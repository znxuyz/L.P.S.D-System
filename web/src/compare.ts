import './styles.css';
import './compare.css';
import { MockMarketProvider } from './data/mockProvider';
import { sessionOpenMs } from './data/twse';
import type { MarketSnapshot, Universe } from './data/types';
import { computeMetrics, type MarketMetrics } from './domain/metrics';
import { computeRotation, type Rotation } from './domain/rotation';
import { BreathingView } from './ui/breathingView';
import { palette, type Convention } from './ui/colors';
import { escapeHtml, pct, price, sharePct, signedYi } from './ui/format';
import { GravityView } from './ui/gravityView';
import { renderTicker } from './ui/panels';
import { renderRotation } from './ui/rotationView';

const CONVENTION_KEY = 'lplc.convention';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function loadConvention(): Convention {
  try {
    return localStorage.getItem(CONVENTION_KEY) === 'intl' ? 'intl' : 'tw';
  } catch {
    return 'tw';
  }
}

class ComparePage {
  private readonly breath: BreathingView;
  private readonly gravity: GravityView;
  private metrics?: MarketMetrics;
  private rotation?: Rotation;
  private selected: string | null = null;
  private convention = loadConvention();
  private pal = palette(this.convention);
  private readonly openMs = sessionOpenMs(new Date());

  constructor(
    private readonly universe: Universe,
    private readonly provider: MockMarketProvider,
  ) {
    const select = (code: string | null) => this.select(code);
    this.breath = new BreathingView($('#breath'), universe, select);
    this.gravity = new GravityView($('#gravity'), universe, select);
    this.bindControls();
    new ResizeObserver(() => this.renderRotation()).observe($('#rotation'));
    provider.subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: MarketSnapshot): void {
    this.metrics = computeMetrics(this.universe, snap);
    this.rotation = computeRotation(this.universe, snap.turnoverHistory);
    this.refresh();
  }

  private refresh(): void {
    if (!this.metrics) return;
    this.breath.update(this.metrics, this.pal);
    this.gravity.update(this.metrics, this.pal);
    this.renderRotation();
    renderTicker($('#ticker'), { metrics: this.metrics, castles: [], selection: null, pal: this.pal, playing: !this.provider.paused });
    this.renderPick();
    this.syncControls();
  }

  private renderRotation(): void {
    if (this.rotation) renderRotation($('#rotation'), this.rotation, this.pal, this.openMs);
  }

  private select(code: string | null): void {
    this.selected = code;
    this.breath.setSelected(code);
    this.gravity.setSelected(code);
    this.renderPick();
  }

  private renderPick(): void {
    const el = $('#pick');
    const s = this.selected ? this.metrics?.stockByCode.get(this.selected) : undefined;
    if (!s) {
      el.innerHTML = '<span class="muted">點任一檔股票，兩張圖會同時標出它的位置，方便比較。</span>';
      return;
    }
    const ind = this.metrics!.industryById.get(s.industryId);
    const d = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    el.innerHTML = `
      <b class="pk-name">${escapeHtml(s.name)}</b><span class="code num">${s.code}</span>
      <span class="muted">${escapeHtml(ind?.name ?? '')}</span>
      <span class="num">${price(s.price)} <span class="${d}">${pct(s.changePct)}</span></span>
      <span class="num">成交佔比 ${sharePct(s.share)}<span class="muted">（常態 ${sharePct(s.baseShare)}）</span></span>
      <span class="num ${s.flow >= 0 ? 'up' : 'down'}">資金流 ${signedYi(s.flow, 2)}</span>
      <button type="button" class="btn btn-small" id="btn-unpick">取消選取</button>`;
    $('#btn-unpick').addEventListener('click', () => this.select(null));
  }

  private bindControls(): void {
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
      try {
        localStorage.setItem(CONVENTION_KEY, this.convention);
      } catch {
        /* 無法儲存時沿用預設 */
      }
      this.pal = palette(this.convention);
      this.refresh();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.select(null);
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
  new ComparePage(universe, provider);
}

void main();
