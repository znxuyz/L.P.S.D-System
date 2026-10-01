import { hierarchy, select, treemap, treemapResquarify, type HierarchyNode, type HierarchyRectangularNode } from 'd3';
import type { Universe } from '../data/types';
import { assignHexes, buildHexGrid, type Hex } from '../layout/hexgrid';
import type { MarketMetrics } from '../domain/metrics';
import type { Palette } from './colors';
import type { Focus } from './focus';
import { escapeHtml, pct, price, sharePct, signedYi, yi } from './format';

/**
 * 資金領地圖（六角格）
 *
 * 整張地圖切成固定數量的六角格，每一格代表相同的成交額。
 * 先用 resquarify treemap 依今日成交佔比排出每檔股票的範圍，再把每個六角格分給
 * 格心所在的股票，所以：格數 ≈ 成交額、同產業連成一片、盤中只有邊界的格子會易主。
 *
 * - 顏色 = 漲跌幅。
 * - 亮度 = 資金方向：吸金（成交佔比高於常態）全亮，失血變暗；吸金最強的 6 檔脈衝發光。
 * - 產業邊界 = 霓虹線，顏色跟著產業資金流方向。
 */

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

type Rect = HierarchyRectangularNode<Node>;

/** 目標格數：越多越細緻，但 SVG 元素也越多。 */
const TARGET_HEXES = 900;
const SQRT3 = Math.sqrt(3);

export class HexMapView {
  private readonly svg;
  private readonly hexG;
  private readonly edgeG;
  private readonly borderG;
  private readonly labelG;
  private readonly reticle;
  private readonly scan;
  private readonly tooltip: HTMLDivElement;
  private readonly layout = treemap<Node>().tile(treemapResquarify).round(false);
  private readonly industryOf: Map<string, string>;
  private readonly nameOf: Map<string, string>;
  private root?: HierarchyNode<Node>;
  private hexes: Hex[] = [];
  private r = 10;
  private width = 0;
  private height = 0;
  private metrics?: MarketMetrics;
  private pal?: Palette;
  private focus: Focus = null;
  private hexPath = '';

  constructor(
    private readonly el: HTMLElement,
    universe: Universe,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    this.industryOf = new Map(universe.stocks.map((s) => [s.code, s.industryId]));
    this.nameOf = new Map(universe.stocks.map((s) => [s.code, s.name]));
    const data: Node = {
      id: 'root',
      name: '',
      children: universe.industries.map((ind) => ({
        id: ind.id,
        name: ind.name,
        children: universe.stocks.filter((s) => s.industryId === ind.id).map((s) => ({ id: s.code, name: s.name })),
      })),
    };
    this.root = hierarchy(data);

    this.svg = select(el).append('svg').attr('class', 'hx-svg').attr('role', 'img').attr('aria-label', '資金領地圖');
    this.hexG = this.svg.append('g').attr('class', 'hx-hexes');
    this.edgeG = this.svg.append('path').attr('class', 'hx-stock-edges');
    this.borderG = this.svg.append('g').attr('class', 'hx-borders');
    this.labelG = this.svg.append('g').attr('class', 'hx-labels');
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

  /** 每一格代表多少成交額（億元）。 */
  get yiPerHex(): number {
    return this.metrics && this.hexes.length ? this.metrics.totalTurnover / this.hexes.length : 0;
  }

  private resize(): void {
    const w = Math.floor(this.el.clientWidth);
    const h = Math.floor(this.el.clientHeight);
    if (w < 50 || h < 50 || (w === this.width && h === this.height)) return;
    this.width = w;
    this.height = h;
    this.svg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
    this.scan.attr('width', w).style('--scan-h', `${h}px`);
    this.buildGrid();
    if (this.metrics && this.pal) this.update(this.metrics, this.pal, true);
  }

  private buildGrid(): void {
    const grid = buildHexGrid(this.width, this.height, TARGET_HEXES);
    this.r = grid.r;
    this.hexes = grid.hexes;
    const k = 0.9; // 格子之間留一點縫，看得出格線
    this.hexPath = Array.from({ length: 6 }, (_, j) => {
      const a = (Math.PI / 3) * j - Math.PI / 2;
      return `${j ? 'L' : 'M'}${(Math.cos(a) * grid.r * k).toFixed(2)},${(Math.sin(a) * grid.r * k).toFixed(2)}`;
    }).join('') + 'Z';
    this.hexG.selectAll('*').remove();
    this.labelG.selectAll('*').remove();
  }

  setFocus(focus: Focus): void {
    this.focus = focus;
    this.applyFocus();
  }

  private applyFocus(): void {
    const f = this.focus;
    const industry = f?.kind === 'industry' ? f.id : f?.kind === 'stock' ? this.industryOf.get(f.id) : undefined;
    this.svg.classed('has-focus', !!f);
    this.hexG.selectAll<SVGPathElement, Hex>('path')
      .classed('is-focus', (d) => (f?.kind === 'stock' ? d.owner === f.id : d.industry === industry))
      .classed('is-selected', (d) => f?.kind === 'stock' && d.owner === f.id);
    this.borderG.selectAll<SVGPathElement, string>('path').classed('is-focus', (id) => id === industry);
    this.labelG.selectAll<SVGTextElement, { code: string }>('text.hx-stock')
      .classed('is-dim', (d) => !!f && (f.kind === 'stock' ? d.code !== f.id : this.industryOf.get(d.code) !== industry));
    this.drawReticle();
  }

  /** 相鄰格子屬於不同股票（或不同產業）的邊。 */
  private edges(): { stock: string; industry: Map<string, string[]> } {
    const r = this.r;
    const key = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
    const at = new Map(this.hexes.map((h) => [key(h.x, h.y), h]));
    const stock: string[] = [];
    const industry = new Map<string, string[]>();
    for (const h of this.hexes) {
      for (let j = 0; j < 6; j++) {
        // 尖頂六角格的六個鄰居方向（邊的法線方向）
        const a = (Math.PI / 3) * j;
        const nx = h.x + Math.cos(a) * SQRT3 * r;
        const ny = h.y + Math.sin(a) * SQRT3 * r;
        const n = at.get(key(nx, ny));
        if (n && n.i < h.i) continue; // 每條邊只畫一次
        if (n && n.owner === h.owner) continue;
        const a1 = a - Math.PI / 6;
        const a2 = a + Math.PI / 6;
        const seg = `M${(h.x + Math.cos(a1) * r).toFixed(1)},${(h.y + Math.sin(a1) * r).toFixed(1)}L${(h.x + Math.cos(a2) * r).toFixed(1)},${(h.y + Math.sin(a2) * r).toFixed(1)}`;
        if (!n || n.industry !== h.industry) {
          for (const id of n ? [h.industry, n.industry] : [h.industry]) {
            if (!industry.has(id)) industry.set(id, []);
            industry.get(id)!.push(seg);
          }
        } else stock.push(seg);
      }
    }
    return { stock: stock.join(''), industry };
  }

  update(metrics: MarketMetrics, pal: Palette, relayout = false): void {
    const first = !this.metrics || relayout;
    this.metrics = metrics;
    this.pal = pal;
    if (!this.width || !this.root) return;

    const value = (code: string) => {
      const s = metrics.stockByCode.get(code);
      if (!s) return 0;
      return metrics.totalTurnover > 0 ? s.share : s.baseShare;
    };
    this.root.sum((d) => (d.children ? 0 : value(d.id)));
    if (!this.root.descendants().some((d) => (d as Rect).x1 !== undefined)) {
      this.root.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    }
    this.layout.size([this.width, this.height])(this.root);
    const leaves = (this.root as Rect).leaves();
    const prevOwner = new Map(this.hexes.map((h) => [h.i, h.owner]));
    const owned = assignHexes(
      this.hexes,
      leaves.map((d) => ({ id: d.data.id, group: d.parent!.data.id, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 })),
    );

    // 吸金最強的 6 檔
    const stocks = [...metrics.stockByCode.values()];
    const surging = new Set(stocks.filter((s) => s.flow > 0).sort((a, b) => b.flow - a.flow).slice(0, 6).map((s) => s.code));

    const hexSel = this.hexG.selectAll<SVGPathElement, Hex>('path')
      .data(this.hexes, (d) => String(d.i))
      .join((enter) =>
        enter.append('path')
          .attr('d', this.hexPath)
          .attr('transform', (d) => `translate(${d.x.toFixed(1)},${d.y.toFixed(1)})`)
          .on('click', (e: MouseEvent, d) => {
            e.stopPropagation();
            this.onSelect({ kind: 'stock', id: d.owner });
          })
          .on('mousemove', (e: MouseEvent, d) => this.showTooltip(e, d.owner))
          .on('mouseleave', () => (this.tooltip.hidden = true)),
      );
    hexSel
      .attr('fill', (d) => pal.heat(metrics.stockByCode.get(d.owner)?.changePct ?? 0))
      .attr('class', (d) => {
        const s = metrics.stockByCode.get(d.owner);
        const cls = ['hx'];
        if (s && s.flow < 0) cls.push('is-drain');
        if (surging.has(d.owner)) cls.push('is-surge');
        return cls.join(' ');
      });
    if (!first) {
      // 易主的格子閃光
      hexSel.filter((d) => prevOwner.get(d.i) !== d.owner)
        .classed('is-captured', true)
        .each(function () {
          const node = this;
          setTimeout(() => node.classList.remove('is-captured'), 1200);
        });
    }

    const { stock, industry } = this.edges();
    this.edgeG.attr('d', stock);
    this.borderG.selectAll<SVGPathElement, string>('path')
      .data([...industry.keys()], (d) => d)
      .join('path')
      .attr('d', (id) => industry.get(id)!.join(''))
      .attr('stroke', (id) => ((metrics.industryById.get(id)?.flow ?? 0) >= 0 ? pal.up.bright : pal.down.bright))
      .attr('stroke-opacity', (id) => 0.45 + 0.55 * Math.abs(metrics.industryById.get(id)?.flow ?? 0) / metrics.maxAbsFlow);

    this.renderLabels(owned, metrics);
    this.applyFocus();
  }

  private renderLabels(owned: Map<string, Hex[]>, metrics: MarketMetrics): void {
    const r = this.r;
    // 個股標籤：依領地實際寬高決定字級，放不下就不標
    const stockLabels = [...owned.entries()]
      .filter(([, hs]) => hs.length >= 3)
      .map(([code, hs]) => {
        const xs = hs.map((h) => h.x);
        const ys = hs.map((h) => h.y);
        const w = Math.max(...xs) - Math.min(...xs) + SQRT3 * r;
        const h = Math.max(...ys) - Math.min(...ys) + 1.6 * r;
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
        const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        const name = this.nameOf.get(code) ?? code;
        // 名稱與漲跌幅取較寬者（漲跌幅約 3.6 個全形字寬）
        const size = Math.min((w * 0.82) / Math.max(3.6, name.length), h / 2.7, 34);
        return { code, cx, cy, size, name, many: h > size * 2.5 };
      })
      .filter((d) => d.size >= 9);
    this.labelG.selectAll<SVGTextElement, (typeof stockLabels)[number]>('text.hx-stock')
      .data(stockLabels, (d) => d.code)
      .join('text')
      .attr('class', 'hx-stock')
      .attr('x', (d) => d.cx)
      .attr('y', (d) => d.cy)
      .attr('font-size', (d) => d.size)
      .html((d) => {
        const s = metrics.stockByCode.get(d.code)!;
        return `<tspan x="${d.cx}" dy="${d.many ? '-0.15em' : '0.35em'}">${escapeHtml(d.name)}</tspan>` +
          (d.many ? `<tspan class="pc" x="${d.cx}" dy="1.15em">${pct(s.changePct)}</tspan>` : '');
      });

    // 產業標籤：放在產業領地最上方的格子
    const byIndustry = new Map<string, Hex[]>();
    for (const h of this.hexes) {
      if (!byIndustry.has(h.industry)) byIndustry.set(h.industry, []);
      byIndustry.get(h.industry)!.push(h);
    }
    const tags = [...byIndustry.entries()].map(([id, hs]) => {
      const top = hs.reduce((best, h) => (h.y < best.y || (h.y === best.y && h.x < best.x) ? h : best), hs[0]);
      const ind = metrics.industryById.get(id)!;
      return { id, x: top.x - r * 0.6, y: top.y - r * 0.25, ind, cells: hs.length };
    });
    const tagSel = this.labelG.selectAll<SVGGElement, (typeof tags)[number]>('g.hx-tag')
      .data(tags, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'hx-tag');
        g.append('rect');
        g.append('text');
        g.on('click', (e: MouseEvent, d) => {
          e.stopPropagation();
          this.onSelect({ kind: 'industry', id: d.id });
        });
        return g;
      })
      .attr('transform', (d) => `translate(${Math.max(2, Math.min(this.width - 90, d.x))},${Math.max(10, d.y)})`);
    tagSel.select('text').html((d) => {
      const up = d.ind.flow >= 0;
      return `<tspan class="nm">${escapeHtml(d.ind.name)}</tspan>` +
        (d.cells >= 12 ? `<tspan dx="5" class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${Math.abs(d.ind.flow).toFixed(0)}</tspan>` : '');
    });
    tagSel.each(function () {
      const g = select(this);
      const node = g.select<SVGTextElement>('text').node();
      const w = node ? node.getComputedTextLength() : 40;
      g.select('rect').attr('x', -4).attr('y', -10).attr('width', w + 8).attr('height', 14);
    });
  }

  /** 選取股票時，用準星框住它的領地。 */
  private drawReticle(): void {
    const f = this.focus;
    const hs = f?.kind === 'stock' ? this.hexes.filter((h) => h.owner === f.id) : [];
    if (!hs.length || f?.kind !== 'stock') {
      this.reticle.attr('display', 'none');
      return;
    }
    const r = this.r;
    const x0 = Math.min(...hs.map((h) => h.x)) - r - 3;
    const x1 = Math.max(...hs.map((h) => h.x)) + r + 3;
    const y0 = Math.min(...hs.map((h) => h.y)) - r - 3;
    const y1 = Math.max(...hs.map((h) => h.y)) + r + 3;
    const k = Math.max(7, Math.min(16, (x1 - x0) / 4, (y1 - y0) / 4));
    this.reticle.attr('display', null);
    this.reticle.select('path.ret-frame').attr('d',
      `M${x0},${y0 + k}V${y0}H${x0 + k}M${x1 - k},${y0}H${x1}V${y0 + k}` +
      `M${x1},${y1 - k}V${y1}H${x1 - k}M${x0 + k},${y1}H${x0}V${y1 - k}`);
    const below = y1 + 13 < this.height;
    this.reticle.select('text.ret-label')
      .attr('x', Math.max(2, Math.min(this.width - 150, x0 + 2)))
      .attr('y', below ? y1 + 13 : y0 - 5)
      .text(`LOCK ▸ ${f.id} ${this.nameOf.get(f.id) ?? ''}`);
  }

  private showTooltip(e: MouseEvent, code: string): void {
    const s = this.metrics?.stockByCode.get(code);
    if (!s) return;
    const cells = this.hexes.filter((h) => h.owner === code).length;
    const rect = this.el.getBoundingClientRect();
    const d = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    this.tooltip.innerHTML =
      `<b>${escapeHtml(s.name)}</b> <span class="code">${s.code}</span>` +
      `<div class="tt-row"><span>${price(s.price)}</span><span class="${d}">${pct(s.changePct)}</span></div>` +
      `<div class="tt-row muted"><span>領地</span><span>${cells} 格・${yi(s.turnover)}</span></div>` +
      `<div class="tt-row muted"><span>成交佔比</span><span>${sharePct(s.share)}（常態 ${sharePct(s.baseShare)}）</span></div>` +
      `<div class="tt-row muted"><span>資金流</span><span class="${s.flow >= 0 ? 'up' : 'down'}">${signedYi(s.flow)}</span></div>`;
    this.tooltip.hidden = false;
    const x = Math.min(e.clientX - rect.left + 14, rect.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY - rect.top + 14, rect.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
}
