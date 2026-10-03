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

class App {
  private readonly map: GlassMapView;
  private readonly toasts: Toasts;
  /** 各股票盤中股價紀錄（每分鐘一筆）。 */
  private readonly history = new Map<string, number[]>();
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
    const onSelect = (f: Focus) => this.select(f);
    this.map = new GlassMapView($('#map'), universe, onSelect);
    this.toasts = new Toasts($('#toasts'), onSelect);
    this.bindControls();
    this.showPage(location.hash === '#intel' ? 'intel' : 'map');
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
    };
    renderTicker($('#ticker'), ctx);
    renderSectors($('#sectors'), ctx);
    renderDetail($('#detail'), ctx);
    // 地圖頁：選取時在地圖右上角浮出狀態視窗
    const floating = $('#map-detail');
    floating.hidden = !this.focus || this.page !== 'map';
    if (!floating.hidden) renderDetail(floating, ctx);
    renderDock($('#dock'), ctx, (el) => this.rotation && renderRotation(el, this.rotation, this.pal, this.openMs));
    renderLog($('#log'), this.events, this.fresh);
    this.fresh = new Set();
    this.syncControls();
  }

  private select(f: Focus): void {
    this.focus = sameFocus(f, this.focus) ? null : f;
    this.map.setFocus(this.focus);
    this.renderPanels();
  }

  private showPage(page: 'map' | 'intel'): void {
    const app = $('.app');
    app.classList.toggle('page-map', page === 'map');
    app.classList.toggle('page-intel', page === 'intel');
    $('#tab-map').setAttribute('aria-selected', String(page === 'map'));
    $('#tab-intel').setAttribute('aria-selected', String(page === 'intel'));
    if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    this.renderPanels();
  }

  private get page(): 'map' | 'intel' {
    return $('.app').classList.contains('page-intel') ? 'intel' : 'map';
  }

  private bindControls(): void {
    // 面板裡的產業、個股按鈕都走同一個選取流程
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-industry],[data-stock],[data-clear]');
      if (!el) return;
      const data = el.dataset;
      if (data.clear !== undefined) this.select(null);
      else if (data.industry) this.select({ kind: 'industry', id: data.industry });
      else if (data.stock) this.select({ kind: 'stock', id: data.stock });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.focus) this.select(this.focus);
      const row = (e.target as Element).closest?.<HTMLElement>('tr[data-stock]');
      if (row && (e.key === 'Enter' || e.key === ' ')) this.select({ kind: 'stock', id: row.dataset.stock! });
    });
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-page]')) {
      tab.addEventListener('click', () => this.showPage(tab.dataset.page as 'map' | 'intel'));
    }
    window.addEventListener('hashchange', () => this.showPage(location.hash === '#intel' ? 'intel' : 'map'));
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
