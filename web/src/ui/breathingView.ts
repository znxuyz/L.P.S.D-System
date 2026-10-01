import { hierarchy, select, treemap, treemapResquarify, type HierarchyNode, type HierarchyRectangularNode } from 'd3';
import type { Universe } from '../data/types';
import { breathRatios } from '../domain/breath';
import type { MarketMetrics } from '../domain/metrics';
import type { Palette } from './colors';
import type { Focus } from './focus';
import { escapeHtml, pct, price, sharePct, signedYi } from './format';

/**
 * ① 資金呼吸圖
 *
 * 每檔股票有一個「格位」，大小 = max(今日成交佔比, 20 日平均佔比)。
 * - 實心方塊 = 今日成交佔比（面積與今日成交額成正比）。
 * - 虛線框   = 20 日平均佔比（常態規模）。
 * 資金湧入時實心方塊撐滿格位、虛線框縮在裡面；資金撤出時實心方塊縮小，外圍露出斜線空地。
 * 格位用 resquarify 排列，盤中只會漲縮、不會跳位。
 */

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

type Rect = HierarchyRectangularNode<Node>;

const HEADER = 18;

export class BreathingView {
  private readonly svg;
  private readonly g;
  private readonly reticle;
  private readonly scan;
  private root?: HierarchyNode<Node>;
  private width = 0;
  private height = 0;
  private metrics?: MarketMetrics;
  private pal?: Palette;
  private focus: Focus = null;
  private readonly industryOf: Map<string, string>;
  private readonly tooltip: HTMLDivElement;
  private readonly layout = treemap<Node>().tile(treemapResquarify).paddingInner(2).paddingTop((d) => (d.depth === 1 ? HEADER : 2)).paddingRight(2).paddingBottom(2).paddingLeft(2).round(false);

  constructor(
    private readonly el: HTMLElement,
    private readonly universe: Universe,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    this.industryOf = new Map(universe.stocks.map((s) => [s.code, s.industryId]));
    this.svg = select(el).append('svg').attr('class', 'br-svg').attr('role', 'img').attr('aria-label', '資金呼吸圖');
    this.g = this.svg.append('g');
    this.reticle = this.svg.append('g').attr('class', 'br-reticle').attr('display', 'none');
    this.reticle.append('path').attr('class', 'ret-frame');
    this.reticle.append('text').attr('class', 'ret-label');
    this.scan = this.svg.append('rect').attr('class', 'br-scan').attr('x', 0).attr('height', 60).attr('fill', 'url(#scan-grad)');
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'bf-tooltip';
    this.tooltip.hidden = true;
    el.appendChild(this.tooltip);
    this.svg.on('click', (e: MouseEvent) => {
      if (e.target === this.svg.node()) this.onSelect(null);
    });
    new ResizeObserver(() => this.resize()).observe(el);
  }

  private resize(): void {
    const w = Math.floor(this.el.clientWidth);
    const h = Math.floor(this.el.clientHeight);
    if (w < 50 || h < 50 || (w === this.width && h === this.height)) return;
    this.width = w;
    this.height = h;
    this.svg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
    this.scan.attr('width', w).style('--scan-h', `${h}px`);
    this.root = undefined;
    this.g.selectAll('*').remove();
    if (this.metrics && this.pal) this.update(this.metrics, this.pal);
  }

  setFocus(focus: Focus): void {
    this.focus = focus;
    this.applyFocus();
  }

  private applyFocus(): void {
    const f = this.focus;
    const industry = f?.kind === 'industry' ? f.id : f?.kind === 'stock' ? this.industryOf.get(f.id) : undefined;
    this.svg.classed('has-focus', f?.kind === 'industry');
    this.g.selectAll<SVGGElement, Rect>('g.br-ind').classed('is-focus', (d) => d.data.id === industry);
    this.g.selectAll<SVGGElement, Rect>('g.br-stock')
      .classed('is-selected', (d) => f?.kind === 'stock' && d.data.id === f.id)
      .classed('is-focus', (d) => this.industryOf.get(d.data.id) === industry);
    this.drawReticle();
  }

  /** 選取股票時畫出鎖定準星。 */
  private drawReticle(): void {
    const f = this.focus;
    const leaf = f?.kind === 'stock' ? this.root?.leaves().find((d) => d.data.id === f.id) as Rect | undefined : undefined;
    if (!leaf) {
      this.reticle.attr('display', 'none');
      return;
    }
    const pad = 4;
    const x0 = leaf.x0 - pad;
    const y0 = leaf.y0 - pad;
    const x1 = leaf.x1 + pad;
    const y1 = leaf.y1 + pad;
    const k = Math.max(6, Math.min(16, (x1 - x0) / 4, (y1 - y0) / 4));
    this.reticle.attr('display', null);
    this.reticle.select('path.ret-frame').attr('d',
      `M${x0},${y0 + k}V${y0}H${x0 + k}M${x1 - k},${y0}H${x1}V${y0 + k}` +
      `M${x1},${y1 - k}V${y1}H${x1 - k}M${x0 + k},${y1}H${x0}V${y1 - k}`);
    // 標籤放在準星下緣；太靠近底部時改放在格位內側下方
    const below = y1 + 13 < this.height;
    this.reticle.select('text.ret-label')
      .attr('x', Math.max(2, x0 + 2))
      .attr('y', below ? y1 + 13 : y1 - 6)
      .text(`LOCK ▸ ${leaf.data.id} ${leaf.data.name}`);
  }

  private slotValue(code: string): number {
    const s = this.metrics?.stockByCode.get(code);
    return s ? breathRatios(s.share, s.baseShare).slot : 0;
  }

  update(metrics: MarketMetrics, pal: Palette): void {
    this.metrics = metrics;
    this.pal = pal;
    if (!this.width) return;
    const first = !this.root;
    if (!this.root) {
      const data: Node = {
        id: 'root',
        name: '',
        children: this.universe.industries.map((ind) => ({
          id: ind.id,
          name: ind.name,
          children: this.universe.stocks.filter((s) => s.industryId === ind.id).map((s) => ({ id: s.code, name: s.name })),
        })),
      };
      this.root = hierarchy(data);
    }
    this.root.sum((d) => (d.children ? 0 : this.slotValue(d.id)));
    if (first) this.root.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    this.layout.size([this.width, this.height])(this.root);
    const root = this.root as Rect;
    const dur = first ? 0 : 900;

    // 產業框
    const inds = this.g.selectAll<SVGGElement, Rect>('g.br-ind')
      .data(root.children ?? [], (d) => d.data.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'br-ind');
        g.append('rect').attr('class', 'br-ind-frame');
        g.append('rect').attr('class', 'br-ind-head').attr('height', HEADER)
          .on('click', (e: MouseEvent, d) => {
            e.stopPropagation();
            this.onSelect({ kind: 'industry', id: d.data.id });
          });
        g.append('text').attr('class', 'br-ind-label').attr('dy', '1em');
        return g;
      });
    inds.select<SVGRectElement>('rect.br-ind-head')
      .attr('x', (d) => d.x0).attr('y', (d) => d.y0).attr('width', (d) => Math.max(0, d.x1 - d.x0));
    inds.select<SVGRectElement>('rect.br-ind-frame').transition().duration(dur)
      .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
      .attr('width', (d) => Math.max(0, d.x1 - d.x0)).attr('height', (d) => Math.max(0, d.y1 - d.y0));
    inds.select<SVGRectElement>('rect.br-ind-frame')
      .attr('stroke', (d) => ((metrics.industryById.get(d.data.id)?.flow ?? 0) >= 0 ? pal.up.bright : pal.down.bright))
      .attr('stroke-opacity', (d) => 0.25 + 0.6 * Math.abs(metrics.industryById.get(d.data.id)?.flow ?? 0) / metrics.maxAbsFlow);
    inds.select<SVGTextElement>('text')
      .attr('x', (d) => d.x0 + 5).attr('y', (d) => d.y0 + 2)
      .each(function (d) {
        const ind = metrics.industryById.get(d.data.id);
        const w = d.x1 - d.x0;
        if (!ind || w < 34) {
          select(this).text('');
          return;
        }
        const up = ind.flow >= 0;
        const full = w > 190;
        select(this).html(
          `<tspan class="nm">${escapeHtml(ind.name)}</tspan>` +
            (w > 90 ? `<tspan dx="6" class="${ind.changePct >= 0 ? 'up' : 'down'}">${pct(ind.changePct)}</tspan>` : '') +
            (full ? `<tspan dx="6" class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${signedYi(ind.flow, 0).replace(' ', '')}</tspan>` : ''),
        );
      });

    // 個股格位
    const leaves = root.leaves();
    const stocks = this.g.selectAll<SVGGElement, Rect>('g.br-stock')
      .data(leaves, (d) => d.data.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'br-stock');
        g.append('rect').attr('class', 'br-slot');
        g.append('rect').attr('class', 'br-fill');
        g.append('rect').attr('class', 'br-ghost');
        g.append('text').attr('class', 'br-label');
        g.on('click', (e: MouseEvent, d) => {
          e.stopPropagation();
          this.onSelect({ kind: 'stock', id: d.data.id });
        })
          .on('mousemove', (e: MouseEvent, d) => this.showTooltip(e, d.data.id))
          .on('mouseleave', () => (this.tooltip.hidden = true));
        return g;
      });
    this.applyFocus();

    const box = (d: Rect, ratio: number) => {
      const w = d.x1 - d.x0;
      const h = d.y1 - d.y0;
      const k = Math.sqrt(Math.max(0, Math.min(1, ratio)));
      return { x: d.x0 + (w * (1 - k)) / 2, y: d.y0 + (h * (1 - k)) / 2, w: w * k, h: h * k };
    };
    const ratios = (d: Rect) => {
      const s = metrics.stockByCode.get(d.data.id)!;
      return breathRatios(s.share, s.baseShare);
    };

    // 資金湧入最強的前 6 檔股票發出脈衝光
    const surging = new Set([...metrics.stockByCode.values()].filter((s) => s.flow > 0).sort((a, b) => b.flow - a.flow).slice(0, 6).map((s) => s.code));
    if (dur) setTimeout(() => this.drawReticle(), dur);
    stocks.classed('is-surge', (d) => surging.has(d.data.id));
    stocks.select<SVGRectElement>('rect.br-slot').transition().duration(dur)
      .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
      .attr('width', (d) => Math.max(0, d.x1 - d.x0)).attr('height', (d) => Math.max(0, d.y1 - d.y0));
    stocks.select<SVGRectElement>('rect.br-fill')
      .attr('fill', (d) => pal.heat(metrics.stockByCode.get(d.data.id)?.changePct ?? 0))
      .transition().duration(dur)
      .attr('x', (d) => box(d, ratios(d).fill).x).attr('y', (d) => box(d, ratios(d).fill).y)
      .attr('width', (d) => box(d, ratios(d).fill).w).attr('height', (d) => box(d, ratios(d).fill).h);
    stocks.select<SVGRectElement>('rect.br-ghost')
      .classed('is-inflow', (d) => ratios(d).fill >= ratios(d).ghost)
      .transition().duration(dur)
      .attr('x', (d) => box(d, ratios(d).ghost).x).attr('y', (d) => box(d, ratios(d).ghost).y)
      .attr('width', (d) => box(d, ratios(d).ghost).w).attr('height', (d) => box(d, ratios(d).ghost).h);

    stocks.select<SVGTextElement>('text.br-label').each(function (d) {
      const s = metrics.stockByCode.get(d.data.id)!;
      const w = d.x1 - d.x0;
      const h = d.y1 - d.y0;
      const size = Math.min(w / (Math.max(3.6, s.name.length) * 1.12), h / 2.6, 30);
      const t = select(this);
      if (size < 8.5) {
        t.text('');
        return;
      }
      const cx = (d.x0 + d.x1) / 2;
      const cy = (d.y0 + d.y1) / 2;
      const showShare = size > 13 && h > size * 4 && w > size * 7;
      t.attr('font-size', size).attr('x', cx).attr('y', cy - (showShare ? size * 0.6 : 0)).html(
        `<tspan x="${cx}" dy="-0.15em">${escapeHtml(s.name)}</tspan><tspan class="pc" x="${cx}" dy="1.15em">${pct(s.changePct)}</tspan>` +
          (showShare ? `<tspan class="sh" x="${cx}" dy="1.35em">成交 ${sharePct(s.share)}・常態 ${sharePct(s.baseShare)}</tspan>` : ''),
      );
    });
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
      `<div class="tt-row muted"><span>20 日平均佔比</span><span>${sharePct(s.baseShare)}</span></div>` +
      `<div class="tt-row muted"><span>資金流</span><span>${signedYi(s.flow)}</span></div>`;
    this.tooltip.hidden = false;
    const x = Math.min(e.clientX - rect.left + 14, rect.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY - rect.top + 14, rect.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
}
