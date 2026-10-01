import './styles.css';
import { MockMarketProvider } from './data/mockProvider';
import type { MarketSnapshot, Universe } from './data/types';
import { evaluateCastle, type CastleState } from './domain/castles';
import { computeMetrics, type MarketMetrics } from './domain/metrics';
import { computeBattlefield, type BattlefieldLayout } from './layout/battlefield';
import { BattlefieldView, type SelectionRef } from './ui/battlefieldView';
import { palette, type Convention } from './ui/colors';
import { renderDetail, renderDock, renderSectors, renderTicker, type PanelContext } from './ui/panels';

const CONVENTION_KEY = 'lplc.convention';

function loadConvention(): Convention {
  try {
    return localStorage.getItem(CONVENTION_KEY) === 'intl' ? 'intl' : 'tw';
  } catch {
    return 'tw';
  }
}

function saveConvention(c: Convention): void {
  try {
    localStorage.setItem(CONVENTION_KEY, c);
  } catch {
    /* 無法儲存時沿用預設 */
  }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

class App {
  private readonly view: BattlefieldView;
  private layout?: BattlefieldLayout;
  private metrics?: MarketMetrics;
  private castles: CastleState[] = [];
  private selection: SelectionRef = null;
  private convention = loadConvention();
  private pal = palette(this.convention);

  constructor(
    private readonly universe: Universe,
    private readonly provider: MockMarketProvider,
  ) {
    this.view = new BattlefieldView($<HTMLDivElement>('#stage'), universe, (sel) => this.select(sel));
    this.bindControls();
    this.observeStage();
    provider.subscribe((snap) => this.onSnapshot(snap));
  }

  private observeStage(): void {
    const stage = $<HTMLDivElement>('#stage');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    const relayout = () => {
      const w = Math.floor(stage.clientWidth);
      const h = Math.floor(stage.clientHeight);
      const key = `${w}x${h}`;
      if (w < 50 || h < 50 || key === last) return;
      last = key;
      this.layout = computeBattlefield(this.universe, w, h);
      this.view.setLayout(this.layout);
      this.refresh();
    };
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(relayout, last ? 180 : 0);
    }).observe(stage);
  }

  private onSnapshot(snap: MarketSnapshot): void {
    this.metrics = computeMetrics(this.universe, snap);
    this.refresh();
  }

  private refresh(): void {
    if (!this.metrics || !this.layout) return;
    this.castles = this.layout.castles.map((site) => evaluateCastle(site, this.metrics!));
    this.view.update(this.metrics, this.castles, this.pal);
    this.renderPanels();
  }

  private context(): PanelContext {
    return {
      metrics: this.metrics!,
      castles: this.castles,
      selection: this.selection,
      pal: this.pal,
      playing: !this.provider.paused,
    };
  }

  private renderPanels(): void {
    if (!this.metrics) return;
    const ctx = this.context();
    renderTicker($('#ticker'), ctx);
    renderSectors($('#sectors'), ctx);
    renderDetail($('#detail'), ctx);
    renderDock($('#dock'), ctx);
    this.syncControls();
  }

  private select(sel: SelectionRef): void {
    const same = sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id;
    this.selection = same ? null : sel;
    this.view.setSelection(this.selection);
    this.renderPanels();
  }

  private bindControls(): void {
    // 所有面板裡的產業、股票、城池按鈕都走同一個選取流程
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-industry],[data-stock],[data-castle],[data-clear]');
      if (!el || el.closest('#stage')) return;
      if (el.dataset.clear !== undefined) this.select(null);
      else if (el.dataset.industry) this.select({ kind: 'industry', id: el.dataset.industry });
      else if (el.dataset.stock) this.select({ kind: 'stock', id: el.dataset.stock });
      else if (el.dataset.castle) this.select({ kind: 'castle', id: el.dataset.castle });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.select(null);
      const row = (e.target as Element).closest?.<HTMLElement>('tr[data-stock]');
      if (row && (e.key === 'Enter' || e.key === ' ')) this.select({ kind: 'stock', id: row.dataset.stock! });
    });

    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.addEventListener('click', () => {
        this.provider.setSpeed(Number(btn.dataset.speed));
        this.syncControls();
      });
    }
    $('#btn-play').addEventListener('click', () => {
      if (this.provider.paused) this.provider.resume();
      else this.provider.pause();
    });
    $('#btn-restart').addEventListener('click', () => this.provider.restart());
    $('#btn-convention').addEventListener('click', () => {
      this.convention = this.convention === 'tw' ? 'intl' : 'tw';
      saveConvention(this.convention);
      this.pal = palette(this.convention);
      this.refresh();
    });
    $('#btn-reset-zoom').addEventListener('click', () => this.view.resetZoom());
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
