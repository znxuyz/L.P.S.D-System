import './styles.css';
import { MockMarketProvider } from './data/mockProvider';
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

const PAGES = ['map', 'intel', 'screen', 'etf'] as const;
type Page = (typeof PAGES)[number];

function pageFromHash(): Page {
  const h = location.hash.slice(1);
  return (PAGES as readonly string[]).includes(h) ? (h as Page) : 'map';
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
    private readonly provider: MockMarketProvider,
  ) {
    this.fundamentals = new Map(
      universe.stocks.filter((s) => s.fundamentals).map((s) => [s.code, s.fundamentals!] as [string, Fundamentals]),
    );
    const onSelect = (f: Focus) => this.select(f);
    this.map = new GlassMapView($('#map'), universe, onSelect);
    this.toasts = new Toasts($('#toasts'), onSelect);
    this.bindControls();
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
    const found = this.detector.detect(this.metrics);
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
      playing: !this.provider.paused,
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
    if (this.page === 'screen') {
      renderStrategyList($('#strategies'), this.metrics, this.universe, this.strategy);
      renderScreen($('#screen'), this.metrics, this.universe, this.strategy, this.focus?.kind === 'stock' ? this.focus.id : null);
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
    this.renderPanels();
  }

  private showPage(page: Page): void {
    const app = $('.app');
    for (const p of PAGES) {
      app.classList.toggle(`page-${p}`, p === page);
      $(`#tab-${p}`).setAttribute('aria-selected', String(p === page));
    }
    if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    this.renderPanels();
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
      const el = (e.target as Element).closest<HTMLElement>('[data-strategy],[data-highlight],[data-etf],[data-etf-cat],[data-etf-highlight],[data-etf-changes]');
      if (!el) return;
      if (el.dataset.etfCat) {
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
    $('#filter-chip').addEventListener('click', () => {
      this.highlight = null;
      this.applyHighlight();
    });
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.addEventListener('click', () => {
        this.provider.setSpeed(Number(btn.dataset.speed));
        this.syncControls();
      });
    }
    $('#btn-play').addEventListener('click', () => (this.provider.paused ? this.provider.resume() : this.provider.pause()));
    $('#btn-restart').addEventListener('click', () => this.provider.restart());
    $('#btn-convention').addEventListener('click', () => {
      this.convention = this.convention === 'tw' ? 'intl' : 'tw';
      saveConvention(this.convention);
      this.pal = palette(this.convention);
      this.refresh();
    });
  }

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
  const provider = new MockMarketProvider({ speed: 60 });
  const universe = await provider.loadUniverse();
  new App(universe, provider);
}

void main();
