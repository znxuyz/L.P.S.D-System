import { forceCollide, forceSimulation, forceX, forceY, select, type Simulation, type SimulationNodeDatum } from 'd3';
import type { IndustryId, Universe } from '../data/types';
import type { MarketMetrics } from '../domain/metrics';
import type { Palette } from './colors';
import type { Focus } from './focus';
import { escapeHtml, pct, price, sharePct, signedYi } from './format';

/**
 * ③ 資金引力場
 *
 * 每檔股票是一顆泡泡：面積 = 今日成交額，顏色 = 漲跌。
 * 同產業的泡泡聚在同一個方位；資金流入越多越被吸向中心，流出越多越被推向外圈。
 * 中央是「資金核心」，誰往中間衝一眼就看得到。
 */

interface Bubble extends SimulationNodeDatum {
  code: string;
  industryId: IndustryId;
  r: number;
  tx: number;
  ty: number;
}

const RING_ORDER = ['semi', 'comp', 'pc', 'oe', 'net', 'opto', 'mech', 'bio', 'trad', 'plastic', 'steel', 'ship', 'fin'];

export class GravityView {
  private readonly svg;
  private readonly ringsG;
  private readonly nodesG;
  private readonly labelsG;
  private readonly tooltip: HTMLDivElement;
  private readonly sim: Simulation<Bubble, undefined>;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private bubbles: Bubble[] = [];
  private width = 0;
  private height = 0;
  private metrics?: MarketMetrics;
  private pal?: Palette;
  private focus: Focus = null;
  private active = true;
  private readonly angleOf = new Map<IndustryId, number>();

  constructor(
    private readonly el: HTMLElement,
    universe: Universe,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    this.svg = select(el).append('svg').attr('class', 'gv-svg').attr('role', 'img').attr('aria-label', '資金引力場');
    this.ringsG = this.svg.append('g').attr('class', 'gv-rings');
    this.nodesG = this.svg.append('g').attr('class', 'gv-nodes');
    this.labelsG = this.svg.append('g').attr('class', 'gv-ind-labels');
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'bf-tooltip';
    this.tooltip.hidden = true;
    el.appendChild(this.tooltip);
    this.svg.on('click', (e: MouseEvent) => {
      if (e.target === this.svg.node()) this.onSelect(null);
    });

    // 各產業的方位：依 20 日平均成交佔比分配角度，從正上方順時針
    const baseTotal = universe.stocks.reduce((s, x) => s + x.avgTurnover20, 0);
    const order = [...RING_ORDER.filter((id) => universe.industries.some((i) => i.id === id)),
      ...universe.industries.map((i) => i.id).filter((id) => !RING_ORDER.includes(id))];
    let cum = 0;
    for (const id of order) {
      const share = universe.stocks.filter((s) => s.industryId === id).reduce((s, x) => s + x.avgTurnover20, 0) / baseTotal;
      // 給小產業保底的角度，避免擠成一團
      const w = 0.6 * share + 0.4 / order.length;
      this.angleOf.set(id, -Math.PI / 2 + Math.PI * 2 * (cum + w / 2));
      cum += w;
    }

    this.bubbles = universe.stocks.map((s) => ({ code: s.code, industryId: s.industryId, r: 4, tx: 0, ty: 0 }));
    this.sim = forceSimulation(this.bubbles)
      .force('x', forceX<Bubble>((d) => d.tx).strength(0.07))
      .force('y', forceY<Bubble>((d) => d.ty).strength(0.07))
      .force('collide', forceCollide<Bubble>((d) => d.r + 1.5).iterations(3))
      .alphaDecay(0.03)
      .on('tick', () => this.tick());
    this.sim.stop();

    new ResizeObserver(() => this.resize()).observe(el);
  }

  private resize(): void {
    const w = Math.floor(this.el.clientWidth);
    const h = Math.floor(this.el.clientHeight);
    if (w < 50 || h < 50 || (w === this.width && h === this.height)) return;
    const fresh = this.width === 0;
    this.width = w;
    this.height = h;
    this.svg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
    if (fresh) {
      for (const b of this.bubbles) {
        const a = this.angleOf.get(b.industryId) ?? 0;
        b.x = w / 2 + Math.cos(a) * w * 0.3;
        b.y = h / 2 + Math.sin(a) * h * 0.3;
      }
    }
    this.drawRings();
    if (this.metrics && this.pal) this.update(this.metrics, this.pal);
  }

  /** 圓形範圍的半徑，左右留空間給產業標籤。 */
  private get radius(): number {
    const side = Math.min(84, this.width * 0.16);
    return Math.max(60, Math.min(this.width / 2 - side, this.height / 2 - 22));
  }

  /** 雷達底圖：同心圓、刻度、十字線與旋轉掃描線。 */
  private drawRings(): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const R = this.radius;
    const rings = [
      { r: R * 0.16, label: 'CORE 資金核心', cls: 'core' },
      { r: R * 0.58, label: 'NORMAL 常態', cls: 'norm' },
      { r: R * 0.98, label: 'OUTFLOW 撤出', cls: 'out' },
    ];
    this.ringsG.selectAll('*').remove();
    this.ringsG.append('circle').attr('class', 'gv-disc').attr('cx', cx).attr('cy', cy).attr('r', R);
    for (const r of [0.37, 0.78]) {
      this.ringsG.append('circle').attr('class', 'gv-ring minor').attr('cx', cx).attr('cy', cy).attr('r', R * r);
    }
    for (const ring of rings) {
      this.ringsG.append('circle').attr('class', `gv-ring ${ring.cls}`).attr('cx', cx).attr('cy', cy).attr('r', ring.r);
    }
    // 十字線與刻度
    this.ringsG.append('path').attr('class', 'gv-cross')
      .attr('d', `M${cx - R},${cy}H${cx + R}M${cx},${cy - R}V${cy + R}`);
    const ticks: string[] = [];
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const len = deg % 30 === 0 ? 9 : 4;
      ticks.push(`M${cx + Math.cos(a) * R},${cy + Math.sin(a) * R}L${cx + Math.cos(a) * (R - len)},${cy + Math.sin(a) * (R - len)}`);
    }
    this.ringsG.append('path').attr('class', 'gv-ticks').attr('d', ticks.join(''));
    // 掃描線：60° 扇形 + 前緣亮線
    const sweep = this.ringsG.append('g').attr('transform', `translate(${cx},${cy})`).append('g').attr('class', 'gv-sweep');
    const a0 = -Math.PI / 3;
    sweep.append('path').attr('class', 'gv-sweep-fan')
      .attr('d', `M0,0L${Math.cos(a0) * R},${Math.sin(a0) * R}A${R},${R} 0 0 1 ${R},0Z`);
    sweep.append('line').attr('class', 'gv-sweep-edge').attr('x1', 0).attr('y1', 0).attr('x2', R).attr('y2', 0);
    for (const ring of rings) {
      this.ringsG.append('text').attr('class', 'gv-ring-label').attr('x', cx).attr('y', cy - ring.r + 13).text(ring.label);
    }
  }

  setFocus(focus: Focus): void {
    this.focus = focus;
    this.applyFocus();
  }

  /** 切到其他分頁時停止物理模擬，省電。 */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.sim.stop();
    else if (this.metrics && this.pal) this.update(this.metrics, this.pal);
  }

  private applyFocus(): void {
    const f = this.focus;
    const industry = f?.kind === 'industry' ? f.id : f?.kind === 'stock' ? this.bubbles.find((b) => b.code === f.id)?.industryId : undefined;
    this.svg.classed('has-focus', f?.kind === 'industry');
    this.nodesG.selectAll<SVGGElement, Bubble>('g.gv-node')
      .classed('is-selected', (d) => f?.kind === 'stock' && d.code === f.id)
      .classed('is-focus', (d) => d.industryId === industry);
    this.labelsG.selectAll<SVGTextElement, { id: string }>('text').classed('is-focus', (d) => d.id === industry);
  }

  update(metrics: MarketMetrics, pal: Palette): void {
    this.metrics = metrics;
    this.pal = pal;
    if (!this.width) return;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const R = this.radius;
    // 泡泡總面積約佔圓形範圍的 42%
    const areaBudget = Math.PI * R * R * 0.42;
    const maxStockFlow = Math.max(1e-9, ...[...metrics.stockByCode.values()].map((s) => Math.abs(s.flow)));

    for (const b of this.bubbles) {
      const s = metrics.stockByCode.get(b.code);
      if (!s) continue;
      const share = metrics.totalTurnover > 0 ? s.share : s.baseShare;
      b.r = Math.max(2.5, Math.sqrt((areaBudget * share) / Math.PI));
      // 個股資金流（開根號拉開小幅差異）決定離中心的距離
      const f = Math.sign(s.flow) * Math.sqrt(Math.abs(s.flow) / maxStockFlow);
      const dist = R * (0.58 - 0.42 * f);
      const a = this.angleOf.get(b.industryId) ?? 0;
      b.tx = cx + Math.cos(a) * dist;
      b.ty = cy + Math.sin(a) * dist;
    }
    // forceX / forceY 只在指定存取函式時讀取目標，所以每次更新都要重新指定
    (this.sim.force('x') as ReturnType<typeof forceX<Bubble>>).x((d) => d.tx);
    (this.sim.force('y') as ReturnType<typeof forceY<Bubble>>).y((d) => d.ty);
    (this.sim.force('collide') as ReturnType<typeof forceCollide<Bubble>>).radius((d) => d.r + 1.5);

    const nodes = this.nodesG.selectAll<SVGGElement, Bubble>('g.gv-node')
      .data(this.bubbles, (d) => d.code)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'gv-node');
        g.append('circle');
        g.append('text');
        g.on('click', (e: MouseEvent, d) => {
          e.stopPropagation();
          this.onSelect({ kind: 'stock', id: d.code });
        })
          .on('mousemove', (e: MouseEvent, d) => this.showTooltip(e, d.code))
          .on('mouseleave', () => (this.tooltip.hidden = true));
        return g;
      });
    nodes.select('circle')
      .attr('fill', (d) => pal.heat(metrics.stockByCode.get(d.code)?.changePct ?? 0))
      .transition().duration(700)
      .attr('r', (d) => d.r);
    nodes.select<SVGTextElement>('text').each(function (d) {
      const s = metrics.stockByCode.get(d.code)!;
      const size = Math.min((d.r * 1.7) / Math.max(2, s.name.length), d.r * 0.55, 22);
      const t = select(this);
      if (size < 8) {
        t.text('');
        return;
      }
      t.attr('font-size', size).html(
        `<tspan x="0" dy="-0.15em">${escapeHtml(s.name)}</tspan>` +
          (d.r > 22 ? `<tspan class="pc" x="0" dy="1.15em">${pct(s.changePct)}</tspan>` : ''),
      );
    });

    // 產業標籤：放在該產業方位的最外圈
    this.labelsG.selectAll<SVGTextElement, { id: string }>('text')
      .data(metrics.industries, (d) => d.id)
      .join('text')
      .attr('class', 'gv-ind-label')
      .attr('x', (d) => cx + Math.cos(this.angleOf.get(d.id) ?? 0) * (R + 2))
      .attr('y', (d) => cy + Math.sin(this.angleOf.get(d.id) ?? 0) * (R + 2))
      .attr('text-anchor', (d) => {
        const c = Math.cos(this.angleOf.get(d.id) ?? 0);
        return c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
      })
      .html((d) => `${escapeHtml(d.name)}<tspan dx="4" class="${d.flow >= 0 ? 'up' : 'down'}">${d.flow >= 0 ? '▲' : '▼'}${Math.abs(d.flow).toFixed(0)}</tspan>`)
      .on('click', (e: MouseEvent, d) => {
        e.stopPropagation();
        this.onSelect({ kind: 'industry', id: d.id });
      });
    this.applyFocus();
    if (!this.active) {
      this.tick();
      return;
    }

    if (this.reducedMotion.matches) {
      this.sim.alpha(1);
      for (let i = 0; i < 200; i++) this.sim.tick();
      this.tick();
    } else {
      this.sim.alpha(Math.max(this.sim.alpha(), 0.35)).restart();
    }
  }

  private tick(): void {
    this.nodesG.selectAll<SVGGElement, Bubble>('g.gv-node').attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  private showTooltip(e: MouseEvent, code: string): void {
    const s = this.metrics?.stockByCode.get(code);
    if (!s) return;
    const rect = this.el.getBoundingClientRect();
    const d = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    this.tooltip.innerHTML =
      `<b>${escapeHtml(s.name)}</b> <span class="code">${s.code}</span>` +
      `<div class="tt-row"><span>${price(s.price)}</span><span class="${d}">${pct(s.changePct)}</span></div>` +
      `<div class="tt-row muted"><span>今日成交佔比</span><span>${sharePct(s.share)}</span></div>` +
      `<div class="tt-row muted"><span>資金流</span><span>${signedYi(s.flow)}</span></div>`;
    this.tooltip.hidden = false;
    const x = Math.min(e.clientX - rect.left + 14, rect.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY - rect.top + 14, rect.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
}
