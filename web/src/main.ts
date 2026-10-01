import './styles.css';
import './views.css';
import { MockMarketProvider } from './data/mockProvider';
import { sessionOpenMs } from './data/twse';
import type { MarketSnapshot, Universe } from './data/types';
import { EventDetector, type MarketEvent } from './domain/events';
import { computeMetrics, type MarketMetrics } from './domain/metrics';
import { computeRotation, type Rotation } from './domain/rotation';
import { palette, type Convention } from './ui/colors';
import { sameFocus, type Focus } from './ui/focus';
import { GravityView } from './ui/gravityView';
import { HexMapView } from './ui/hexMapView';
import { renderDetail, renderDock, renderLog, renderSectors, renderTicker, type PanelContext } from './ui/panels';
import { renderRotation } from './ui/rotationView';

type ViewName = 'hex' | 'gravity';

const CONVENTION_KEY = 'lplc.convention';
const VIEW_KEY = 'lplc.view';
const GRAVITY_HINT = '光點 = 今日成交額　越靠中心 = 資金流入越多　顏色 = 漲跌';

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 無法儲存時沿用預設 */
  }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

class App {
  private readonly hex: HexMapView;
  private readonly gravity: GravityView;
  private metrics?: MarketMetrics;
  private rotation?: Rotation;
  private readonly detector = new EventDetector();
  private events: MarketEvent[] = [];
  private fresh = new Set<number>();
  private focus: Focus = null;
  private convention = load<Convention>(CONVENTION_KEY, ['tw', 'intl'], 'tw');
  private view = load<ViewName>(VIEW_KEY, ['hex', 'gravity'], 'hex');
  private pal = palette(this.convention);
  private readonly openMs = sessionOpenMs(new Date());

  constructor(
    private readonly universe: Universe,
    private readonly provider: MockMarketProvider,
  ) {
    const onSelect = (f: Focus) => this.select(f);
    this.hex = new HexMapView($('#hex'), universe, onSelect);
    this.gravity = new GravityView($('#gravity'), universe, onSelect);
    this.bindControls();
    this.showView(this.view);
    provider.subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: MarketSnapshot): void {
    // 重播時時間倒退，日誌重新開始
    if (this.metrics && snap.time < this.metrics.time) {
      this.detector.reset();
      this.events = [];
    }
    this.metrics = computeMetrics(this.universe, snap);
    const found = this.detector.detect(this.metrics);
    this.fresh = new Set(found.map((e) => e.id));
    this.events = [...found.reverse(), ...this.events].slice(0, 40);
    this.rotation = computeRotation(this.universe, snap.turnoverHistory);
    this.refresh();
  }

  private refresh(): void {
    if (!this.metrics) return;
    if (this.view === 'hex') this.hex.update(this.metrics, this.pal);
    else this.gravity.update(this.metrics, this.pal);
    this.renderHint();
    this.renderPanels();
  }

  private context(): PanelContext {
    return { metrics: this.metrics!, selection: this.focus, pal: this.pal, playing: !this.provider.paused };
  }

  private renderPanels(): void {
    if (!this.metrics) return;
    const ctx = this.context();
    renderTicker($('#ticker'), ctx);
    renderSectors($('#sectors'), ctx);
    renderDetail($('#detail'), ctx);
    renderDock($('#dock'), ctx, (el) => this.rotation && renderRotation(el, this.rotation, this.pal, this.openMs));
    renderLog($('#log'), this.events, this.fresh);
    this.fresh = new Set();
    this.syncControls();
  }

  private select(f: Focus): void {
    this.focus = sameFocus(f, this.focus) ? null : f;
    this.hex.setFocus(this.focus);
    this.gravity.setFocus(this.focus);
    this.renderPanels();
  }

  private showView(view: ViewName): void {
    this.view = view;
    save(VIEW_KEY, view);
    for (const name of ['hex', 'gravity'] as const) {
      $(`#${name}`).hidden = name !== view;
      $(`#tab-${name}`).setAttribute('aria-selected', String(name === view));
    }
    this.renderHint();
    this.gravity.setActive(view === 'gravity');
    this.refresh();
  }

  private renderHint(): void {
    const per = this.hex.yiPerHex;
    $('#field-hint').textContent =
      this.view === 'hex'
        ? `每格 ≈ ${per >= 1 ? per.toFixed(1) : per.toFixed(2)} 億成交額　亮 = 吸金　暗 = 失血　閃光 = 領地易主　顏色 = 漲跌`
        : GRAVITY_HINT;
  }

  private bindControls(): void {
    // 面板裡的產業、股票按鈕都走同一個選取流程
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-industry],[data-stock],[data-clear]');
      if (!el || el.closest('.view')) return;
      const data = (el as HTMLElement).dataset;
      if (data.clear !== undefined) this.select(null);
      else if (data.industry) this.select({ kind: 'industry', id: data.industry });
      else if (data.stock) this.select({ kind: 'stock', id: data.stock });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.focus) this.select(this.focus);
      const row = (e.target as Element).closest?.<HTMLElement>('tr[data-stock]');
      if (row && (e.key === 'Enter' || e.key === ' ')) this.select({ kind: 'stock', id: row.dataset.stock! });
    });
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      tab.addEventListener('click', () => this.showView(tab.dataset.view as ViewName));
    }
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
      save(CONVENTION_KEY, this.convention);
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
