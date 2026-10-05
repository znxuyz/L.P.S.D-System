import './styles.css';
import { MockMarketProvider } from './data/mockProvider';
import { LiveProvider, type LiveStatus } from './data/liveProvider';
import type { MarketDataProvider, PlaybackControl } from './data/provider';
import { loadSettings, saveSettings, type SourceSettings } from './data/settings';
import { sessionOpenMs } from './data/twse';
import type { MarketSnapshot, Universe } from './data/types';
import { EventDetector, type MarketEvent } from './domain/events';
import { computeMetrics, type MarketMetrics } from './domain/metrics';
import { computeRotation, type Rotation } from './domain/rotation';
import { palette, type Convention } from './ui/colors';
import { sameFocus, type Focus } from './ui/focus';
import { renderDetail, renderDock, renderLog, renderSectors, renderTicker, type PanelContext } from './ui/panels';
import { renderRotation } from './ui/rotationView';
import { renderScreen, renderStrategyList } from './ui/screener';
import { runScreen, strategyById, type StrategyId } from './domain/screens';
import type { Fundamentals } from './data/types';
import { computeEtfs, type EtfView } from './domain/etf';
import { renderEtfCategories, renderEtfDetail, renderEtfTable, type EtfFilter } from './ui/etfPage';
import { GlassMapView } from './ui/glassMapView';
import { Toasts } from './ui/toasts';
import { renderStockPage } from './ui/stockPage';
import type { DailySeries } from './data/candles';
import { taipeiDate } from './data/liveProvider';

const CONVENTION_KEY = 'lplc.convention';

function loadConvention(): Convention {
  try {
    return localStorage.getItem(CONVENTION_KEY) === 'intl' ? 'intl' : 'tw';
  } catch {
    return 'tw';
  }
}

function saveConvention(value: Convention): void {
  try {
    localStorage.setItem(CONVENTION_KEY, value);
  } catch {
    /* 無法儲存時沿用預設 */
  }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const PAGES = ['map', 'intel', 'screen', 'etf', 'stock'] as const;
type Page = (typeof PAGES)[number];

function pageFromHash(): Page {
  const h = location.hash.slice(1).split('/')[0];
  return (PAGES as readonly string[]).includes(h) ? (h as Page) : 'map';
}

/** #stock/2330 → 2330 */
function stockFromHash(): string | null {
  const [page, code] = location.hash.slice(1).split('/');
  return page === 'stock' && code ? decodeURIComponent(code) : null;
}

class App {
  private readonly map: GlassMapView;
  private readonly toasts: Toasts;
  /** 各股票盤中股價紀錄（每分鐘一筆）。 */
  private readonly history = new Map<string, number[]>();
  private readonly fundamentals: Map<string, Fundamentals>;
  private strategy: StrategyId = 'value';
  /** 熱力圖上正在標示的股票群：五大選股的某個策略，或某檔 ETF 的成分股。 */
  private highlight:
    | { kind: 'strategy'; id: StrategyId }
    | { kind: 'etf'; code: string }
    | { kind: 'etf-changes'; code: string }
    | null = null;
  private etfs: EtfView[] = [];
  private etfFilter: EtfFilter = 'all';
  private etfSelected: string | null = null;
  /** 個股分析頁目前的股票。 */
  private analyzed = stockFromHash() ?? '2330';
  private readonly daily = new Map<string, DailySeries>();
  private readonly dailyLoading = new Set<string>();
  private readonly detector = new EventDetector();
  private metrics?: MarketMetrics;
  private rotation?: Rotation;
  private events: MarketEvent[] = [];
  private fresh = new Set<number>();
  private focus: Focus = null;
  private convention = loadConvention();
  private pal = palette(this.convention);
  private readonly openMs = sessionOpenMs(new Date());

  constructor(
    private readonly universe: Universe,
    private readonly provider: MarketDataProvider & Partial<PlaybackControl>,
    private readonly settings: SourceSettings,
  ) {
    this.fundamentals = new Map(
      universe.stocks.filter((s) => s.fundamentals).map((s) => [s.code, s.fundamentals!] as [string, Fundamentals]),
    );
    const onSelect = (f: Focus) => this.select(f);
    this.map = new GlassMapView($('#map'), universe, onSelect);
    this.toasts = new Toasts($('#toasts'), onSelect);
    this.bindControls();
    this.bindSource();
    this.showPage(pageFromHash());
    provider.subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: MarketSnapshot): void {
    // 重播時時間倒退，日誌重新開始
    if (this.metrics && snap.time < this.metrics.time) {
      this.detector.reset();
      this.events = [];
      this.toasts.clear();
    }
    this.metrics = computeMetrics(this.universe, snap);
    this.etfs = computeEtfs(this.universe, snap, this.metrics);
    this.rotation = computeRotation(this.universe, snap.turnoverHistory);
    // 報價還沒到齊時，漲跌與資金排名都不完整，先不發事件
    if (snap.partial) this.detector.reset();
    const found = snap.partial ? [] : this.detector.detect(this.metrics);
    this.fresh = new Set(found.map((e) => e.id));
    this.events = [...[...found].reverse(), ...this.events].slice(0, 40);
    this.toasts.push(found.filter((e) => e.level !== 'info'));
    this.recordPrices(snap);
    this.refresh();
  }

  /** 由每分鐘紀錄整理出各股票的盤中股價，最後一點用即時價。 */
  private recordPrices(snap: MarketSnapshot): void {
    this.history.clear();
    for (const bar of snap.turnoverHistory ?? []) {
      if (!bar.prices) continue;
      for (const [code, p] of Object.entries(bar.prices)) {
        let arr = this.history.get(code);
        if (!arr) {
          arr = [];
          this.history.set(code, arr);
        }
        arr.push(p);
      }
    }
    for (const [code, q] of Object.entries(snap.quotes)) {
      const arr = this.history.get(code);
      if (arr?.length) arr[arr.length - 1] = q.price;
    }
  }

  private refresh(): void {
    if (!this.metrics) return;
    this.map.update(this.metrics, this.pal, this.history);
    this.applyHighlight();
    this.renderPanels();
  }

  private renderPanels(): void {
    if (!this.metrics) return;
    const ctx: PanelContext = {
      metrics: this.metrics,
      selection: this.focus,
      pal: this.pal,
      playing: !this.provider.paused && !this.sourceError,
      history: this.history,
      fundamentals: this.fundamentals,
    };
    renderTicker($('#ticker'), ctx);
    renderSectors($('#sectors'), ctx);
    if (this.page === 'intel') renderDetail($('#detail'), ctx);
    if (this.page === 'etf') {
      renderEtfCategories($('#etf-cats'), this.etfs, this.etfFilter);
      renderEtfTable($('#etf-list'), this.etfs, this.etfFilter, this.etfSelected);
      const etf = this.etfs.find((e) => e.meta.code === this.etfSelected);
      renderEtfDetail($('#etf-detail'), etf, etf ? this.history.get(etf.meta.code) : undefined);
    }
    if (this.page === 'stock') {
      this.ensureDaily(this.analyzed);
      renderStockPage($('#page-stock'), this.analyzed, {
        metrics: this.metrics,
        universe: this.universe,
        fundamentals: this.fundamentals,
        pal: this.pal,
        history: this.history,
        daily: this.daily.get(this.analyzed),
        live: this.live,
        today: taipeiDate(Date.now()),
      });
    }
    if (this.page === 'screen') {
      renderStrategyList($('#strategies'), this.metrics, this.universe, this.strategy);
      renderScreen(
        $('#screen'),
        this.metrics,
        this.universe,
        this.strategy,
        this.focus?.kind === 'stock' ? this.focus.id : null,
        this.live ? '股價為真實行情；EPS、股利、法人與大戶籌碼、特殊事件目前仍是模擬資料，篩選結果僅供介面測試。' : undefined,
      );
      renderDetail($('#screen-detail'), ctx);
    }
    // 地圖頁：選取時在地圖右上角浮出狀態視窗
    const floating = $('#map-detail');
    floating.hidden = !this.focus || this.page !== 'map';
    if (!floating.hidden) renderDetail(floating, ctx);
    if (this.page === 'intel') renderDock($('#dock'), ctx, (el) => this.rotation && renderRotation(el, this.rotation, this.pal, this.openMs));
    renderLog($('#log'), this.events, this.fresh);
    this.fresh = new Set();
    this.syncControls();
  }

  private select(f: Focus): void {
    this.focus = sameFocus(f, this.focus) ? null : f;
    this.map.setFocus(this.focus);
    if (this.provider instanceof LiveProvider) this.provider.setFocus(this.focus?.kind === 'stock' ? this.focus.id : null);
    this.renderPanels();
  }

  private showPage(page: Page): void {
    const app = $('.app');
    for (const p of PAGES) {
      app.classList.toggle(`page-${p}`, p === page);
      $(`#tab-${p}`).setAttribute('aria-selected', String(p === page));
    }
    if (page === 'stock') this.analyzed = stockFromHash() ?? this.analyzed;
    const hash = page === 'stock' ? `#stock/${this.analyzed}` : `#${page}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    this.renderPanels();
  }

  /** 打開某檔股票的個股分析。 */
  private analyze(code: string): void {
    this.analyzed = code;
    history.replaceState(null, '', `#stock/${code}`);
    this.showPage('stock');
    window.scrollTo({ top: 0 });
  }

  private ensureDaily(code: string): void {
    if (this.daily.has(code) || this.dailyLoading.has(code) || !this.provider.dailyCandles) return;
    this.dailyLoading.add(code);
    this.provider
      .dailyCandles(code)
      .then((series) => this.daily.set(code, series))
      .catch(() => this.daily.set(code, { candles: [], source: 'mock' }))
      .finally(() => {
        this.dailyLoading.delete(code);
        this.renderPanels();
      });
  }

  private get page(): Page {
    return PAGES.find((p) => $('.app').classList.contains(`page-${p}`)) ?? 'map';
  }

  /** 熱力圖只亮出指定策略符合的股票。 */
  private applyHighlight(): void {
    const chip = $('#filter-chip');
    if (!this.highlight || !this.metrics) {
      this.map.setHighlight(null);
      chip.hidden = true;
      return;
    }
    let codes: Set<string>;
    let label: string;
    if (this.highlight.kind === 'strategy') {
      const s = strategyById(this.highlight.id);
      codes = new Set(runScreen(s, this.metrics, this.universe).filter((r) => r.status === 'match').map((r) => r.view.stock.code));
      label = s.name;
    } else {
      const { kind, code } = this.highlight;
      const etf = this.universe.etfs?.find((e) => e.code === code);
      if (kind === 'etf') {
        codes = new Set(etf?.holdings.map((h) => h.code) ?? []);
        label = `${etf?.name ?? code} 成分股`;
      } else {
        codes = new Set(etf?.changes.map((c) => c.code) ?? []);
        label = `${etf?.name ?? code} 異動股`;
      }
    }
    this.map.setHighlight(codes);
    chip.hidden = false;
    chip.textContent = `篩選中：${label}（${codes.size} 檔）✕`;
  }

  private bindControls(): void {
    // 面板裡的產業、個股按鈕都走同一個選取流程
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-industry],[data-stock],[data-clear]');
      if (!el) return;
      const data = el.dataset;
      if (data.clear !== undefined) this.select(null);
      else if (data.industry) this.select({ kind: 'industry', id: data.industry });
      else if (data.stock) {
        this.select({ kind: 'stock', id: data.stock });
        // ETF 頁沒有個股細節欄，點股票時切到熱力圖並選取它
        if (this.page === 'etf') this.showPage('map');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.focus) this.select(this.focus);
      const row = (e.target as Element).closest?.<HTMLElement>('tr[data-stock]');
      if (row && (e.key === 'Enter' || e.key === ' ')) this.select({ kind: 'stock', id: row.dataset.stock! });
      const etfRow = (e.target as Element).closest?.<HTMLElement>('tr[data-etf]');
      if (etfRow && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.etfSelected = etfRow.dataset.etf!;
        this.renderPanels();
      }
    });
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-page]')) {
      tab.addEventListener('click', () => this.showPage(tab.dataset.page as Page));
    }
    window.addEventListener('hashchange', () => this.showPage(pageFromHash()));
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>(
        '[data-strategy],[data-highlight],[data-etf],[data-etf-cat],[data-etf-highlight],[data-etf-changes],[data-analyze],[data-goto-strategy]',
      );
      if (!el) return;
      if (el.dataset.analyze) {
        this.analyze(el.dataset.analyze);
      } else if (el.dataset.gotoStrategy) {
        this.strategy = el.dataset.gotoStrategy as StrategyId;
        this.showPage('screen');
      } else if (el.dataset.etfCat) {
        this.etfFilter = el.dataset.etfCat as EtfFilter;
        this.renderPanels();
      } else if (el.dataset.etf) {
        this.etfSelected = this.etfSelected === el.dataset.etf ? null : el.dataset.etf;
        this.renderPanels();
      } else if (el.dataset.etfHighlight || el.dataset.etfChanges) {
        this.highlight = el.dataset.etfHighlight
          ? { kind: 'etf', code: el.dataset.etfHighlight }
          : { kind: 'etf-changes', code: el.dataset.etfChanges! };
        this.focus = null;
        this.map.setFocus(null);
        this.applyHighlight();
        this.showPage('map');
      } else if (el.dataset.strategy) {
        this.strategy = el.dataset.strategy as StrategyId;
        this.renderPanels();
      } else if (el.dataset.highlight) {
        this.highlight = { kind: 'strategy', id: el.dataset.highlight as StrategyId };
        // 標示篩選結果時取消個別選取，避免符合的股票也被變暗
        this.focus = null;
        this.map.setFocus(null);
        this.applyHighlight();
        this.showPage('map');
      }
    });
    // 個股分析頁的搜尋：可以輸入代號、名稱，或從清單選「2330 台積電」
    document.addEventListener('submit', (e) => {
      const form = e.target as HTMLElement;
      if (form.id !== 'sa-search') return;
      e.preventDefault();
      const q = (form.querySelector<HTMLInputElement>('#sa-q')?.value ?? '').trim();
      if (!q) return;
      const token = q.split(/\s+/)[0];
      const hit =
        this.universe.stocks.find((s) => s.code === token) ??
        this.universe.stocks.find((s) => s.name === q || s.name === token) ??
        this.universe.stocks.find((s) => s.name.includes(q) || q.includes(s.name));
      if (hit) this.analyze(hit.code);
      else form.querySelector<HTMLInputElement>('#sa-q')?.setCustomValidity('找不到這檔股票');
    });
    document.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).id === 'sa-q') (e.target as HTMLInputElement).setCustomValidity('');
    });
    $('#filter-chip').addEventListener('click', () => {
      this.highlight = null;
      this.applyHighlight();
    });
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.addEventListener('click', () => {
        this.provider.setSpeed?.(Number(btn.dataset.speed));
        this.syncControls();
      });
    }
    $('#btn-play').addEventListener('click', () => (this.provider.paused ? this.provider.resume?.() : this.provider.pause?.()));
    $('#btn-restart').addEventListener('click', () => this.provider.restart?.());
    $('#btn-convention').addEventListener('click', () => {
      this.convention = this.convention === 'tw' ? 'intl' : 'tw';
      saveConvention(this.convention);
      this.pal = palette(this.convention);
      this.refresh();
    });
  }

  /** 真實資料連線失敗時，頂部不顯示 Live。 */
  private sourceError = false;

  private get live(): boolean {
    return this.provider instanceof LiveProvider;
  }

  /** 設定選單的「資料來源」：模擬 / 富果 / 證交所，輸入金鑰或轉接網址。儲存後重新載入頁面。 */
  private bindSource(): void {
    const form = $<HTMLFormElement>('#source-form');
    const keyInput = $<HTMLInputElement>('#fugle-key');
    const proxyInput = $<HTMLInputElement>('#mis-proxy');
    const chip = $('#source-chip');
    let pending = this.settings.source;
    const apply = (next: SourceSettings) => {
      saveSettings(next);
      location.reload();
    };
    const sync = () => {
      for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-source]')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.source === pending));
      }
      form.hidden = pending === 'mock' || (this.formCollapsed && !this.sourceError);
      $('.field-proxy').hidden = pending !== 'twse';
      $('#fugle-key-label').textContent = pending === 'twse' ? '富果 API 金鑰（選填，用來算 20 日常態）' : '富果 API 金鑰';
    };
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-source]')) {
      btn.addEventListener('click', () => {
        const source = btn.dataset.source as SourceSettings['source'];
        if (source === 'mock') {
          if (this.settings.source !== 'mock') apply({ ...this.settings, source });
          return;
        }
        pending = source;
        this.formCollapsed = false;
        sync();
        (source === 'twse' && !proxyInput.value ? proxyInput : keyInput).focus();
      });
    }
    keyInput.value = this.settings.fugleKey;
    proxyInput.value = this.settings.misProxy;
    // 已經連上真實行情時先收起表單，避免誤改；點來源按鈕才展開
    this.formCollapsed = this.live;
    sync();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fugleKey = keyInput.value.trim();
      const misProxy = proxyInput.value.trim();
      if (pending === 'fugle' && !fugleKey) return keyInput.focus();
      if (pending === 'twse' && !/^https:\/\/\S+$/.test(misProxy)) return proxyInput.focus();
      apply({ source: pending, fugleKey, misProxy });
    });
    $('#source-clear').addEventListener('click', () => apply({ source: 'mock', fugleKey: '', misProxy: '' }));
    chip.addEventListener('click', () => ($<HTMLDetailsElement>('details.menu').open = true));
    $('#playback').hidden = this.live;

    if (this.provider instanceof LiveProvider) {
      const status = $('#source-status');
      status.hidden = false;
      this.provider.onStatus((s: LiveStatus) => {
        chip.textContent = s.message;
        chip.title = s.detail;
        chip.className = `chip-source is-${s.state}`;
        status.textContent = `${s.message}\n${s.detail}`;
        status.classList.toggle('is-error', s.state === 'error');
        this.sourceError = s.state === 'error';
        if (this.sourceError) {
          this.formCollapsed = false;
          sync();
        }
        this.renderPanels();
      });
    }
  }

  private formCollapsed = false;

  private syncControls(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.speed) === this.provider.speed));
    }
    const closed = this.metrics?.session === 'closed';
    $('#btn-play').textContent = closed ? '重新開盤' : this.provider.paused ? '繼續' : '暫停';
    $('#btn-convention').textContent = this.convention === 'tw' ? '紅漲綠跌' : '綠漲紅跌';
    document.documentElement.dataset.convention = this.convention;
  }
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const provider =
    settings.source === 'mock'
      ? new MockMarketProvider({ speed: 60 })
      : new LiveProvider({ fugleKey: settings.fugleKey, misProxy: settings.source === 'twse' ? settings.misProxy : undefined });
  const universe = await provider.loadUniverse();
  new App(universe, provider, settings);
}

void main();
