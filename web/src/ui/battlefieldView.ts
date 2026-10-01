import { arc, interpolateLab, select, zoom, zoomIdentity, type Selection, type ZoomBehavior, type ZoomTransform } from 'd3';
import type { Universe } from '../data/types';
import type { CastleState } from '../domain/castles';
import type { MarketMetrics } from '../domain/metrics';
import type { BattlefieldLayout, StockCell, Territory } from '../layout/battlefield';
import { area, distance, lerp, pathData, type Point } from '../layout/geometry';
import { contestantColor, type Palette } from './colors';
import { escapeHtml, pct, price, signedYi } from './format';

export type SelectionRef = { kind: 'industry' | 'stock' | 'castle'; id: string } | null;

const PARCHMENT = '#e8e1cf';
const PARCHMENT_EDGE = '#8f8672';

interface FlowLink {
  castleId: string;
  industryId: string;
  start: Point;
  ctrl: Point;
  end: Point;
  flow: number;
  targetDepth: number;
  depth: number;
  seeds: number[];
}

interface LabelInfo {
  cell: StockCell;
  font: number;
}

function crenellatedWall(r: number, merlons = 12): string {
  const inner = r * 0.86;
  const step = Math.PI / merlons;
  const pts: string[] = [];
  for (let k = 0; k < merlons * 2; k++) {
    const rr = k % 2 === 0 ? r : inner;
    for (const a of [k * step, (k + 1) * step]) {
      const ang = a - Math.PI / 2;
      pts.push(`${(Math.cos(ang) * rr).toFixed(2)},${(Math.sin(ang) * rr).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z`;
}

function bezier(link: FlowLink, t: number): Point {
  const u = 1 - t;
  return [
    u * u * link.start[0] + 2 * u * t * link.ctrl[0] + t * t * link.end[0],
    u * u * link.start[1] + 2 * u * t * link.ctrl[1] + t * t * link.end[1],
  ];
}

export class BattlefieldView {
  private readonly stage: HTMLDivElement;
  private readonly baseSvg: Selection<SVGSVGElement, unknown, null, undefined>;
  private readonly topSvg: Selection<SVGSVGElement, unknown, null, undefined>;
  private readonly baseG: Selection<SVGGElement, unknown, null, undefined>;
  private readonly topG: Selection<SVGGElement, unknown, null, undefined>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltip: HTMLDivElement;
  private readonly zoomBehavior: ZoomBehavior<HTMLDivElement, unknown>;
  private readonly names: Map<string, string>;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  private layout?: BattlefieldLayout;
  private metrics?: MarketMetrics;
  private castles: CastleState[] = [];
  private pal?: Palette;
  private transform: ZoomTransform = zoomIdentity;
  private links: FlowLink[] = [];
  private labels: LabelInfo[] = [];
  private selection: SelectionRef = null;
  private raf = 0;

  constructor(
    stage: HTMLDivElement,
    universe: Universe,
    private readonly onSelect: (sel: SelectionRef) => void,
  ) {
    this.stage = stage;
    this.names = new Map(universe.stocks.map((s) => [s.code, s.name]));

    this.baseSvg = select(stage).append('svg').attr('class', 'bf-base').attr('role', 'img')
      .attr('aria-label', '產業領地與個股熱力圖');
    this.baseG = this.baseSvg.append('g');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bf-flow';
    this.canvas.setAttribute('aria-hidden', 'true');
    stage.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.topSvg = select(stage).append('svg').attr('class', 'bf-top');
    this.topG = this.topSvg.append('g');

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'bf-tooltip';
    this.tooltip.hidden = true;
    stage.appendChild(this.tooltip);

    this.zoomBehavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([1, 6])
      .on('zoom', (event: { transform: ZoomTransform }) => {
        this.transform = event.transform;
        const t = event.transform.toString();
        this.baseG.attr('transform', t);
        this.topG.attr('transform', t);
        this.updateLabelVisibility();
        this.tooltip.hidden = true;
      });
    select(stage).call(this.zoomBehavior).on('dblclick.zoom', null);

    stage.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (target === stage || target === this.baseSvg.node() || target === this.topSvg.node()) this.onSelect(null);
    });

    const loop = (now: number) => {
      this.drawFlows(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  resetZoom(): void {
    select(this.stage).call(this.zoomBehavior.transform, zoomIdentity);
  }

  setLayout(layout: BattlefieldLayout): void {
    this.layout = layout;
    const { width, height } = layout;
    for (const svg of [this.baseSvg, this.topSvg]) svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.zoomBehavior.translateExtent([[0, 0], [width, height]]).extent([[0, 0], [width, height]]);
    this.transform = zoomIdentity;
    select(this.stage).call(this.zoomBehavior.transform, zoomIdentity);

    this.buildBase(layout);
    this.buildTop(layout);
    this.buildLinks(layout);
    if (this.metrics && this.pal) this.update(this.metrics, this.castles, this.pal);
    this.applySelection();
  }

  private buildBase(layout: BattlefieldLayout): void {
    const { territories, gutter } = layout;
    this.baseG.selectAll('*').remove();
    const defs = this.baseG.append('defs');
    territories.forEach((t) => {
      defs.append('clipPath').attr('id', `clip-${t.industryId}`).append('path').attr('d', pathData(t.outer));
    });
    this.baseG.append('path').attr('class', 'field').attr('d', pathData(layout.field));
    const groups = this.baseG.selectAll<SVGGElement, Territory>('g.territory')
      .data(territories)
      .join('g')
      .attr('class', 'territory')
      .attr('data-id', (t) => t.industryId);

    groups.append('path').attr('class', 'ground').attr('d', (t) => pathData(t.outer))
      .on('click', (_e, t) => this.onSelect({ kind: 'industry', id: t.industryId }));
    groups.append('g').attr('class', 'cells')
      .selectAll<SVGPathElement, StockCell>('path')
      .data((t) => t.cells)
      .join('path')
      .attr('class', 'cell')
      .attr('data-code', (c) => c.code)
      .attr('d', (c) => pathData(c.polygon))
      .on('click', (_e, c) => this.onSelect({ kind: 'stock', id: c.code }))
      .on('mousemove', (e: MouseEvent, c) => this.showTooltip(e, c.code))
      .on('mouseleave', () => (this.tooltip.hidden = true));
    // 護城河：沿領地外框畫一圈戰場底色，讓領地之間留出間隔
    groups.append('path').attr('class', 'moat').attr('d', (t) => pathData(t.outer)).attr('stroke-width', gutter * 2);
    // 資金光暈只畫在領地內側
    groups.append('path').attr('class', 'glow').attr('d', (t) => pathData(t.outer))
      .attr('clip-path', (t) => `url(#clip-${t.industryId})`);
    groups.append('path').attr('class', 'wall').attr('d', (t) => pathData(t.outer));
  }

  private buildTop(layout: BattlefieldLayout): void {
    this.topG.selectAll('*').remove();

    // 個股標籤
    this.labels = layout.territories.flatMap((t) =>
      t.cells.map((cell) => {
        const xs = cell.polygon.map((p) => p[0]);
        const w = Math.max(...xs) - Math.min(...xs);
        const name = this.names.get(cell.code) ?? cell.code;
        const size = Math.sqrt(cell.area);
        const font = Math.min(size * 0.2, (w * 0.82) / Math.max(2, name.length), 54);
        return { cell, font };
      }),
    );
    const labelG = this.topG.append('g').attr('class', 'stock-labels');
    const texts = labelG.selectAll<SVGTextElement, LabelInfo>('text')
      .data(this.labels)
      .join('text')
      .attr('data-code', (d) => d.cell.code)
      .attr('x', (d) => d.cell.labelAt[0])
      .attr('y', (d) => d.cell.labelAt[1])
      .attr('font-size', (d) => d.font);
    texts.append('tspan').attr('class', 'nm').attr('x', (d) => d.cell.labelAt[0]).attr('dy', '-0.1em')
      .text((d) => this.names.get(d.cell.code) ?? d.cell.code);
    texts.append('tspan').attr('class', 'pc').attr('x', (d) => d.cell.labelAt[0]).attr('dy', '1.15em');

    // 攻擊路線（選取時才顯示）
    this.topG.append('g').attr('class', 'routes');

    // 城池
    const castleG = this.topG.append('g').attr('class', 'castles')
      .selectAll<SVGGElement, BattlefieldLayout['castles'][number]>('g.castle')
      .data(layout.castles)
      .join('g')
      .attr('class', (c) => `castle tier-${c.tier}`)
      .attr('data-id', (c) => c.id)
      .attr('transform', (c) => `translate(${c.x},${c.y})`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .on('click', (e: MouseEvent, c) => {
        e.stopPropagation();
        this.onSelect({ kind: 'castle', id: c.id });
      })
      .on('keydown', (e: KeyboardEvent, c) => {
        if (e.key === 'Enter' || e.key === ' ') this.onSelect({ kind: 'castle', id: c.id });
      });
    castleG.append('circle').attr('class', 'land').attr('r', (c) => c.r * 1.32);
    castleG.append('circle').attr('class', 'pulse').attr('r', (c) => c.r * 1.12);
    castleG.append('g').attr('class', 'ring');
    castleG.append('path').attr('class', 'keep').attr('d', (c) => crenellatedWall(c.r * 0.78));
    castleG.append('line').attr('class', 'pole').attr('x1', 0).attr('x2', 0)
      .attr('y1', (c) => -c.r * 0.66).attr('y2', (c) => -c.r * 1.55);
    castleG.append('path').attr('class', 'flag')
      .attr('d', (c) => `M0,${-c.r * 1.55}L${c.r * 0.7},${-c.r * 1.38}L0,${-c.r * 1.2}Z`);
    castleG.append('text').attr('class', 'castle-id').attr('dy', '0.35em')
      .attr('font-size', (c) => Math.max(8, c.r * 0.4)).text((c) => c.label);
    castleG.append('text').attr('class', 'castle-status')
      .attr('y', (c) => c.r * 1.32 + Math.max(9, c.r * 0.34))
      .attr('font-size', (c) => Math.max(9, c.r * 0.34));
    castleG.append('title').text((c) => `資金城池 ${c.label}`);

    // 產業標籤
    this.topG.append('g').attr('class', 'pills')
      .selectAll<SVGGElement, Territory>('g.pill')
      .data(layout.territories.filter((t) => t.outer.length >= 3))
      .join('g')
      .attr('class', 'pill')
      .attr('data-id', (t) => t.industryId)
      .attr('transform', (t) => `translate(${t.labelAnchor[0]},${t.labelAnchor[1]})`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .on('click', (e: MouseEvent, t) => {
        e.stopPropagation();
        this.onSelect({ kind: 'industry', id: t.industryId });
      })
      .on('keydown', (e: KeyboardEvent, t) => {
        if (e.key === 'Enter' || e.key === ' ') this.onSelect({ kind: 'industry', id: t.industryId });
      })
      .call((g) => {
        g.append('rect').attr('rx', 3);
        g.append('text').attr('dy', '0.35em').attr('font-size', (t) => Math.max(10, Math.min(14, Math.sqrt(area(t.outer)) * 0.05)));
      });

    this.updateLabelVisibility();
  }

  private buildLinks(layout: BattlefieldLayout): void {
    const byId = new Map(layout.territories.map((t) => [t.industryId, t]));
    this.links = [];
    for (const castle of layout.castles) {
      const p: Point = [castle.x, castle.y];
      castle.contestants.forEach((id, i) => {
        const t = byId.get(id);
        if (!t) return;
        const start = t.gate;
        const len = distance(start, p);
        if (len < 1) return;
        const dir: Point = [(p[0] - start[0]) / len, (p[1] - start[1]) / len];
        const end: Point = [p[0] - dir[0] * castle.r * 1.02, p[1] - dir[1] * castle.r * 1.02];
        const bend = (i % 2 === 0 ? 1 : -1) * len * 0.14;
        const mid = lerp(start, end, 0.5);
        const ctrl: Point = [mid[0] - dir[1] * bend, mid[1] + dir[0] * bend];
        const seeds = Array.from({ length: 48 }, (_, k) => ((k * 0.618034 + i * 0.37) % 1));
        this.links.push({ castleId: castle.id, industryId: id, start, ctrl, end, flow: 0, targetDepth: 0, depth: 0, seeds });
      });
    }

    this.topG.select('g.routes')
      .selectAll<SVGPathElement, FlowLink>('path')
      .data(this.links)
      .join('path')
      .attr('data-castle', (l) => l.castleId)
      .attr('data-industry', (l) => l.industryId)
      .attr('d', (l) => `M${l.start[0]},${l.start[1]}Q${l.ctrl[0]},${l.ctrl[1]} ${l.end[0]},${l.end[1]}`);
  }

  update(metrics: MarketMetrics, castles: CastleState[], pal: Palette): void {
    this.metrics = metrics;
    this.castles = castles;
    this.pal = pal;
    if (!this.layout) return;

    this.baseG.selectAll<SVGPathElement, StockCell>('path.cell')
      .attr('fill', (c) => pal.heat(metrics.stockByCode.get(c.code)?.changePct ?? 0));
    this.topG.selectAll<SVGTSpanElement, LabelInfo>('tspan.pc')
      .text((d) => pct(metrics.stockByCode.get(d.cell.code)?.changePct ?? 0));

    this.baseG.selectAll<SVGPathElement, Territory>('path.glow')
      .attr('stroke', (t) => ((metrics.industryById.get(t.industryId)?.flow ?? 0) >= 0 ? pal.up.bright : pal.down.bright))
      .attr('stroke-opacity', (t) => 0.12 + 0.6 * Math.abs(metrics.industryById.get(t.industryId)?.flow ?? 0) / metrics.maxAbsFlow)
      .attr('stroke-width', (t) => 6 + 18 * Math.min(1, Math.abs(metrics.industryById.get(t.industryId)?.flow ?? 0) / 200));

    this.layoutPills(metrics);

    const stateById = new Map(castles.map((c) => [c.site.id, c]));
    const ringArc = arc<{ start: number; end: number }>()
      .startAngle((d) => d.start)
      .endAngle((d) => d.end)
      .padAngle(0.03);
    this.topG.selectAll<SVGGElement, BattlefieldLayout['castles'][number]>('g.castle').each(function (site) {
      const state = stateById.get(site.id);
      if (!state) return;
      const g = select(this);
      g.classed('is-contested', state.status === 'contested')
        .classed('is-neutral', state.status === 'neutral')
        .classed('is-occupied', state.status === 'occupied');

      const segments: Array<{ start: number; end: number; color: string }> = [];
      let a = 0;
      for (const c of state.contestants) {
        if (c.occupancy <= 0.001) continue;
        const end = a + c.occupancy * Math.PI * 2;
        segments.push({ start: a, end, color: contestantColor(c.slot) });
        a = end;
      }
      segments.push({ start: a, end: Math.PI * 2, color: PARCHMENT });
      ringArc.innerRadius(site.r * 0.86).outerRadius(site.r * 1.04);
      g.select('g.ring').selectAll<SVGPathElement, (typeof segments)[number]>('path')
        .data(segments)
        .join('path')
        .attr('d', (d) => ringArc(d))
        .attr('fill', (d) => d.color);

      const leader = state.leader;
      const leaderColor = leader ? contestantColor(leader.slot) : PARCHMENT_EDGE;
      const hold = leader ? leader.occupancy : 0;
      g.select('path.keep')
        .attr('fill', interpolateLab(PARCHMENT, leaderColor)(state.status === 'neutral' ? 0 : hold * 0.55))
        .attr('stroke', state.status === 'neutral' ? PARCHMENT_EDGE : leaderColor);
      g.select('path.flag').attr('fill', state.status === 'neutral' ? PARCHMENT : leaderColor);

      let status: string;
      if (state.status === 'neutral' || !leader) status = '中立';
      else if (state.status === 'contested') {
        const [x, y] = [...state.contestants].sort((p, q) => q.occupancy - p.occupancy);
        status = `${x.short}${Math.round(x.occupancy * 100)} : ${y.short}${Math.round(y.occupancy * 100)}`;
      } else status = `${leader.short} ${Math.round(leader.occupancy * 100)}%`;
      g.select('text.castle-status').text(status);
      g.select('title').text(`資金城池 ${site.label}：${status}`);
    });

    for (const link of this.links) {
      const state = stateById.get(link.castleId);
      const c = state?.contestants.find((x) => x.industryId === link.industryId);
      link.flow = c?.flow ?? 0;
      link.targetDepth = c && c.flow > 0 ? 0.18 + 0.82 * c.depth : 0;
    }
  }

  /** 更新產業標籤內容，並避開彼此重疊與地圖邊界。 */
  private layoutPills(metrics: MarketMetrics): void {
    if (!this.layout) return;
    const { width, height } = this.layout;
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    const overlaps = (r: (typeof placed)[number]) =>
      placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
    const pills = this.topG.selectAll<SVGGElement, Territory>('g.pill').nodes()
      .map((node) => ({ node, t: select<SVGGElement, Territory>(node).datum() }))
      .sort((a, b) => area(b.t.outer) - area(a.t.outer));

    for (const { node, t } of pills) {
      const ind = metrics.industryById.get(t.industryId);
      if (!ind) continue;
      const g = select(node);
      const text = g.select<SVGTextElement>('text');
      const fs = Number(text.attr('font-size'));
      const full =
        `<tspan class="pill-name">${escapeHtml(ind.name)}</tspan><tspan class="pill-pct ${ind.changePct >= 0 ? 'up' : 'down'}" dx="0.4em">${pct(ind.changePct)}</tspan>` +
        `<tspan class="pill-flow ${ind.flow >= 0 ? 'up' : 'down'}" dx="0.4em">${ind.flow >= 0 ? '▲' : '▼'}${signedYi(ind.flow, 0).replace(' ', '')}</tspan>`;
      const compact = `<tspan class="pill-name">${escapeHtml(ind.name)}</tspan><tspan class="pill-flow ${ind.flow >= 0 ? 'up' : 'down'}" dx="0.3em">${ind.flow >= 0 ? '▲' : '▼'}</tspan>`;

      const ys = t.outer.map((p) => p[1]);
      const yMax = Math.max(...ys);
      let best: { x: number; y: number; w: number; html: string } | undefined;
      for (const html of [full, compact]) {
        text.html(html);
        const w = text.node()?.getComputedTextLength() ?? 60;
        const boxW = w + fs;
        const boxH = fs * 1.7;
        for (let i = 0; i < 6; i++) {
          const y = Math.min(t.labelAnchor[1] + i * boxH * 1.05, yMax - boxH / 2);
          const x = Math.max(boxW / 2 + 2, Math.min(width - boxW / 2 - 2, t.labelAnchor[0]));
          const cy = Math.max(boxH / 2 + 2, Math.min(height - boxH / 2 - 2, y));
          const rect = { x0: x - boxW / 2, y0: cy - boxH / 2, x1: x + boxW / 2, y1: cy + boxH / 2 };
          if (!overlaps(rect)) {
            best = { x, y: cy, w, html };
            placed.push(rect);
            break;
          }
        }
        if (best) break;
      }
      if (!best) {
        // 真的放不下就用精簡版放在原位
        text.html(compact);
        const w = text.node()?.getComputedTextLength() ?? 40;
        best = { x: t.labelAnchor[0], y: t.labelAnchor[1], w, html: compact };
      }
      text.html(best.html).attr('x', -best.w / 2);
      g.attr('transform', `translate(${best.x},${best.y})`);
      g.select('rect').attr('x', -best.w / 2 - fs * 0.5).attr('y', -fs * 0.85).attr('width', best.w + fs).attr('height', fs * 1.7);
    }
  }

  setSelection(sel: SelectionRef): void {
    this.selection = sel;
    this.applySelection();
  }

  private focusIndustries(): Set<string> {
    const sel = this.selection;
    if (!sel) return new Set();
    if (sel.kind === 'industry') return new Set([sel.id]);
    if (sel.kind === 'stock') {
      const t = this.layout?.territories.find((x) => x.cells.some((c) => c.code === sel.id));
      return new Set(t ? [t.industryId] : []);
    }
    const castle = this.layout?.castles.find((c) => c.id === sel.id);
    return new Set(castle?.contestants ?? []);
  }

  private linkFocused(link: FlowLink): boolean {
    const sel = this.selection;
    if (!sel) return true;
    if (sel.kind === 'castle') return link.castleId === sel.id;
    return this.focusIndustries().has(link.industryId);
  }

  private applySelection(): void {
    const sel = this.selection;
    const focus = this.focusIndustries();
    this.stage.classList.toggle('has-selection', !!sel);
    this.baseG.selectAll<SVGGElement, Territory>('g.territory').classed('is-focus', (t) => focus.has(t.industryId));
    this.topG.selectAll<SVGGElement, Territory>('g.pill').classed('is-focus', (t) => focus.has(t.industryId));
    this.baseG.selectAll<SVGPathElement, StockCell>('path.cell').classed('is-selected', (c) => sel?.kind === 'stock' && c.code === sel.id);
    this.baseG.selectAll<SVGPathElement, StockCell>('path.cell.is-selected').raise();
    this.topG.selectAll<SVGGElement, { id: string; contestants: string[] }>('g.castle').classed('is-focus', (c) =>
      sel?.kind === 'castle' ? c.id === sel.id : c.contestants.some((id) => focus.has(id)),
    );
    this.topG.selectAll<SVGPathElement, FlowLink>('g.routes path').classed('is-on', (l) => !!sel && this.linkFocused(l));
  }

  private updateLabelVisibility(): void {
    const k = this.transform.k;
    this.topG.selectAll<SVGTextElement, LabelInfo>('g.stock-labels text')
      .attr('display', (d) => (d.font * k >= 8.5 ? null : 'none'))
      .select('tspan.pc')
      .attr('display', (d) => (d.font * k >= 10.5 ? null : 'none'));
  }

  private showTooltip(e: MouseEvent, code: string): void {
    const s = this.metrics?.stockByCode.get(code);
    if (!s) return;
    const rect = this.stage.getBoundingClientRect();
    const dirClass = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    this.tooltip.innerHTML =
      `<b>${escapeHtml(s.name)}</b> <span class="code">${s.code}</span>` +
      `<div class="tt-row"><span>${price(s.price)}</span><span class="${dirClass}">${pct(s.changePct)}</span></div>` +
      `<div class="tt-row muted"><span>資金流</span><span>${signedYi(s.flow)}</span></div>`;
    this.tooltip.hidden = false;
    const x = Math.min(e.clientX - rect.left + 14, rect.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY - rect.top + 14, rect.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }

  private drawFlows(now: number): void {
    const { ctx, canvas } = this;
    const dpr = canvas.width / (this.layout?.width || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.layout || !this.pal) return;
    const t = this.transform;
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
    const still = this.reducedMotion.matches;
    const time = now / 1000;
    const hasSel = !!this.selection;
    ctx.globalCompositeOperation = 'lighter';

    for (const link of this.links) {
      link.depth += (link.targetDepth - link.depth) * 0.05;
      const strength = Math.min(1, Math.abs(link.flow) / 200);
      const focused = this.linkFocused(link);
      const alphaMul = hasSel ? (focused ? 1.25 : 0.18) : 1;
      const attacking = link.flow > 0;
      const color = attacking ? this.pal.up.bright : this.pal.down.bright;
      const reach = attacking ? Math.max(0.05, link.depth) : 0.55;

      // 兵力流（粗細代表資金量）
      ctx.beginPath();
      const p0 = bezier(link, 0);
      ctx.moveTo(p0[0], p0[1]);
      for (let i = 1; i <= 20; i++) {
        const p = bezier(link, (i / 20) * reach);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.globalAlpha = (attacking ? 0.16 : 0.08) * alphaMul;
      ctx.lineWidth = attacking ? 2 + 12 * strength : 1.5 + 3 * strength;
      ctx.stroke();

      // 前線
      if (attacking && link.depth > 0.06) {
        const a = bezier(link, Math.max(0, reach - 0.02));
        const b = bezier(link, reach);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        const half = 4 + 8 * strength;
        ctx.globalAlpha = 0.85 * Math.min(1, alphaMul);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b[0] + nx * half, b[1] + ny * half);
        ctx.lineTo(b[0] - nx * half, b[1] - ny * half);
        ctx.stroke();
      }

      // 粒子：攻擊往城池推進，撤退往領地內部回流
      const count = attacking ? Math.round(5 + 40 * strength) : Math.round(3 + 18 * strength);
      const size = 1 + 2.2 * strength;
      ctx.fillStyle = color;
      for (let i = 0; i < count; i++) {
        const seed = link.seeds[i % link.seeds.length];
        const prog = still ? seed : (seed + time * (attacking ? 0.28 : 0.18)) % 1;
        const tt = attacking ? prog * reach : (1 - prog) * reach;
        const p = bezier(link, tt);
        const fade = attacking ? Math.sin(prog * Math.PI) : Math.sin(prog * Math.PI) * 0.8;
        ctx.globalAlpha = Math.min(1, 0.9 * fade * alphaMul);
        ctx.beginPath();
        ctx.arc(p[0], p[1], size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
