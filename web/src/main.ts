import './styles.css';
import { MockMarketProvider } from './data/mockProvider';
import { sessionOpenMs } from './data/twse';
import type { MarketSnapshot, Universe } from './data/types';
import { EventDetector, type MarketEvent } from './domain/events';
import { computeMetrics, type MarketMetrics } from './domain/metrics';
import { computeRotation, type Rotation } from './domain/rotation';
import { palette, type Convention } from './ui/colors';
import { DialogueBox } from './ui/dialogue';
import { sameFocus, type Focus } from './ui/focus';
import { renderDetail, renderDock, renderLog, renderSectors, renderTicker, type PanelContext } from './ui/panels';
import { renderRotation } from './ui/rotationView';
import { spriteUrl } from './ui/sprites';
import { WorldMapView } from './ui/worldMapView';

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
  private readonly map: WorldMapView;
  private readonly dialogue: DialogueBox;
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
    this.map = new WorldMapView($('#map'), universe, onSelect);
    this.dialogue = new DialogueBox($('#dialogue'), onSelect);
    $<HTMLImageElement>('#crest').src = spriteUrl('fin');
    this.bindControls();
    provider.subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: MarketSnapshot): void {
    // 重播時時間倒退，日誌重新開始
    if (this.metrics && snap.time < this.metrics.time) {
      this.detector.reset();
      this.events = [];
      this.dialogue.reset();
    }
    this.metrics = computeMetrics(this.universe, snap);
    this.rotation = computeRotation(this.universe, snap.turnoverHistory);
    const found = this.detector.detect(this.metrics);
    this.fresh = new Set(found.map((e) => e.id));
    this.events = [...[...found].reverse(), ...this.events].slice(0, 40);
    this.dialogue.push(found);
    this.refresh();
  }

  private refresh(): void {
    if (!this.metrics) return;
    this.map.update(this.metrics, this.pal);
    this.renderPanels();
  }

  private renderPanels(): void {
    if (!this.metrics) return;
    const ctx: PanelContext = { metrics: this.metrics, selection: this.focus, pal: this.pal, playing: !this.provider.paused };
    renderTicker($('#ticker'), ctx);
    renderSectors($('#sectors'), ctx);
    renderDetail($('#detail'), ctx);
    renderDock($('#dock'), ctx, (el) => this.rotation && renderRotation(el, this.rotation, this.pal, this.openMs));
    renderLog($('#log'), this.events, this.fresh);
    this.fresh = new Set();
    const per = this.map.yiPerTile;
    $('#field-hint').textContent =
      `每格 ≈ ${per >= 1 ? per.toFixed(1) : per.toFixed(2)} 億成交額　地面顏色 = 漲跌　暗色網點 = 資金撤出　金幣 = 吸金最強　閃光 = 領地易主`;
    this.syncControls();
  }

  private select(f: Focus): void {
    this.focus = sameFocus(f, this.focus) ? null : f;
    this.map.setFocus(this.focus);
    this.renderPanels();
  }

  private toggleExpanded(force?: boolean): void {
    const on = $('.app').classList.toggle('is-expanded', force);
    const btn = $('#btn-expand');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '還原版面' : '放大地圖';
  }

  private bindControls(): void {
    // 面板裡的王國、領地按鈕都走同一個選取流程
    document.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-industry],[data-stock],[data-clear]');
      if (!el) return;
      const data = el.dataset;
      if (data.clear !== undefined) this.select(null);
      else if (data.industry) this.select({ kind: 'industry', id: data.industry });
      else if (data.stock) this.select({ kind: 'stock', id: data.stock });
    });
    document.addEventListener('keydown', (e) => {
      const typing = (e.target as Element).closest?.('input, textarea, select');
      if (!typing && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) this.toggleExpanded();
      if (e.key === 'Escape') {
        if (document.querySelector('.app.is-expanded')) this.toggleExpanded(false);
        else if (this.focus) this.select(this.focus);
      }
      const row = (e.target as Element).closest?.<HTMLElement>('tr[data-stock]');
      if (row && (e.key === 'Enter' || e.key === ' ')) this.select({ kind: 'stock', id: row.dataset.stock! });
    });
    $('#btn-expand').addEventListener('click', () => this.toggleExpanded());
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
