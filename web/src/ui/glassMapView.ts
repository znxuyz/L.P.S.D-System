import { color, hierarchy, treemap, treemapResquarify, type HierarchyNode, type HierarchyRectangularNode } from 'd3';
import type { Universe } from '../data/types';
import type { MarketMetrics } from '../domain/metrics';
import type { Palette } from './colors';
import type { Focus } from './focus';
import { escapeHtml, pct, price, sharePct, signedYi, yi } from './format';
import { sparkArea, sparkPath } from './spark';

/**
 * 玻璃熱力圖
 *
 * 方塊面積 = 今日成交額（成交佔比），顏色 = 漲跌幅。
 * 版面用 resquarify 排列：成交額變化時方塊只會平滑地漲縮，不會跳位。
 *
 * - 吸金最強的 6 檔：方塊內部有呼吸光。
 * - 資金撤出（成交佔比低於 20 日常態）：降低飽和度。
 * - 夠大的方塊會畫出盤中走勢線。
 *
 * 每個方塊與產業框都是固定的 DOM 元素，只更新位置與內容，讓 CSS 負責過渡動畫。
 */

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

type Rect = HierarchyRectangularNode<Node>;

const HEAD = 24;

export class GlassMapView {
  private readonly root: HTMLDivElement;
  private readonly tree: HierarchyNode<Node>;
  private readonly layout = treemap<Node>()
    .tile(treemapResquarify)
    // paddingOuter 會覆蓋 paddingTop，所以要先設
    .paddingOuter(4)
    .paddingTop((d) => (d.depth === 1 ? HEAD : 4))
    .paddingInner(4)
    .round(true);
  private readonly cells = new Map<string, HTMLDivElement>();
  private readonly groups = new Map<string, HTMLDivElement>();
  private readonly industryOf: Map<string, string>;
  private readonly tooltip: HTMLDivElement;
  private sorted = false;
  private width = 0;
  private height = 0;
  private metrics?: MarketMetrics;
  private pal?: Palette;
  private history = new Map<string, number[]>();
  private focus: Focus = null;

  constructor(
    private readonly el: HTMLElement,
    universe: Universe,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    this.industryOf = new Map(universe.stocks.map((s) => [s.code, s.industryId]));
    this.tree = hierarchy<Node>({
      id: 'root',
      name: '',
      children: universe.industries.map((ind) => ({
        id: ind.id,
        name: ind.name,
        children: universe.stocks.filter((s) => s.industryId === ind.id).map((s) => ({ id: s.code, name: s.name })),
      })),
    });

    this.root = document.createElement('div');
    this.root.className = 'gm';
    this.root.setAttribute('role', 'img');
    this.root.setAttribute('aria-label', '市場熱力圖：方塊面積為今日成交額，顏色為漲跌幅');
    el.appendChild(this.root);

    for (const ind of universe.industries) {
      const g = document.createElement('div');
      g.className = 'gm-group';
      g.innerHTML = `<button type="button" class="gm-head" data-ind="${ind.id}"></button>`;
      g.querySelector('button')!.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect({ kind: 'industry', id: ind.id });
      });
      this.root.appendChild(g);
      this.groups.set(ind.id, g);
    }
    for (const s of universe.stocks) {
      const c = document.createElement('div');
      c.className = 'gm-cell';
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.setAttribute('aria-label', s.name);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect({ kind: 'stock', id: s.code });
      });
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onSelect({ kind: 'stock', id: s.code });
        }
      });
      c.addEventListener('mousemove', (e) => this.showTooltip(e, s.code));
      c.addEventListener('mouseleave', () => (this.tooltip.hidden = true));
      this.root.appendChild(c);
      this.cells.set(s.code, c);
    }
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onSelect(null);
    });

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'gm-tip glass';
    this.tooltip.hidden = true;
    el.appendChild(this.tooltip);

    new ResizeObserver(() => this.resize()).observe(el);
  }

  private resize(): void {
    const w = Math.floor(this.el.clientWidth);
    const h = Math.floor(this.el.clientHeight);
    if (w < 60 || h < 60 || (w === this.width && h === this.height)) return;
    const first = this.width === 0;
    this.width = w;
    this.height = h;
    // 尺寸改變時直接跳到新位置，不播放過渡
    this.root.classList.add('no-anim');
    if (this.metrics && this.pal) this.update(this.metrics, this.pal, this.history);
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.remove('no-anim')));
    if (first) this.root.classList.add('is-ready');
  }

  /** 只亮出指定的股票（例如選股結果）；null 取消。 */
  setHighlight(codes: Set<string> | null): void {
    this.root.classList.toggle('has-highlight', !!codes);
    for (const [code, c] of this.cells) c.classList.toggle('is-hit', !!codes?.has(code));
  }

  setFocus(focus: Focus): void {
    this.focus = focus;
    this.applyFocus();
  }

  private applyFocus(): void {
    const f = this.focus;
    const industry = f?.kind === 'industry' ? f.id : f?.kind === 'stock' ? this.industryOf.get(f.id) : undefined;
    this.root.classList.toggle('has-focus', !!f);
    for (const [code, c] of this.cells) {
      c.classList.toggle('is-selected', f?.kind === 'stock' && f.id === code);
      c.classList.toggle('is-focus', f?.kind === 'stock' ? f.id === code : this.industryOf.get(code) === industry);
    }
    for (const [id, g] of this.groups) g.classList.toggle('is-focus', id === industry);
  }

  update(metrics: MarketMetrics, pal: Palette, history: Map<string, number[]>): void {
    this.metrics = metrics;
    this.pal = pal;
    this.history = history;
    if (!this.width) return;

    this.tree.sum((d) => {
      if (d.children) return 0;
      const s = metrics.stockByCode.get(d.id);
      if (!s) return 0;
      return metrics.totalTurnover > 0 ? s.share : s.baseShare;
    });
    if (!this.sorted) {
      this.tree.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      this.sorted = true;
    }
    this.layout.size([this.width, this.height])(this.tree);
    const root = this.tree as Rect;

    const surging = new Set(
      [...metrics.stockByCode.values()].filter((s) => s.flow > 0).sort((a, b) => b.flow - a.flow).slice(0, 6).map((s) => s.code),
    );

    for (const ind of root.children ?? []) {
      const g = this.groups.get(ind.data.id)!;
      const m = metrics.industryById.get(ind.data.id);
      const w = ind.x1 - ind.x0;
      place(g, ind.x0, ind.y0, w, ind.y1 - ind.y0);
      if (!m) continue;
      const head = g.querySelector('button')!;
      const up = m.flow >= 0;
      head.innerHTML =
        `<span class="gm-head-name">${escapeHtml(m.name)}</span>` +
        (w > 110 ? `<span class="gm-head-pct ${m.changePct >= 0 ? 'up' : 'down'}">${pct(m.changePct)}</span>` : '') +
        (w > 190 ? `<span class="gm-pill ${up ? 'up' : 'down'}">${up ? '流入' : '流出'} ${Math.abs(m.flow).toFixed(0)} 億</span>` : '');
      head.setAttribute('aria-label', `${m.name} ${pct(m.changePct)}`);
    }

    for (const leaf of root.leaves()) {
      const code = leaf.data.id;
      const c = this.cells.get(code)!;
      const s = metrics.stockByCode.get(code);
      if (!s) continue;
      const w = leaf.x1 - leaf.x0;
      const h = leaf.y1 - leaf.y0;
      place(c, leaf.x0, leaf.y0, w, h);

      const fill = pal.heat(s.changePct);
      const light = color(fill)?.brighter(0.6).formatHex() ?? fill;
      c.style.setProperty('--fill', fill);
      c.style.setProperty('--fill-hi', light);
      c.style.borderRadius = `${Math.max(3, Math.min(12, w / 6, h / 6))}px`;
      c.classList.toggle('is-surge', surging.has(code));
      c.classList.toggle('is-drain', s.flow < 0);
      c.classList.toggle('is-tiny', w < 26 || h < 20);

      const size = Math.min(w / (Math.max(3.6, s.name.length) * 1.08), h / 2.8, 34);
      let html = '';
      if (size >= 10) {
        html += `<span class="c-name" style="font-size:${size.toFixed(1)}px">${escapeHtml(s.name)}</span>`;
        if (h > size * 2.3) html += `<span class="c-pct" style="font-size:${(size * 0.78).toFixed(1)}px">${pct(s.changePct)}</span>`;
        if (size >= 15 && h > size * 4.4 && w > 150) {
          html += `<span class="c-meta">成交 ${sharePct(s.share)}　常態 ${sharePct(s.baseShare)}</span>`;
        }
      }
      const series = this.history.get(code);
      if (w > 130 && h > 110 && series && series.length > 2) {
        const sw = Math.round(w - 24);
        const sh = Math.round(Math.min(34, h * 0.2));
        html += `<svg class="c-spark" width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}" aria-hidden="true">
          <path class="c-spark-area" d="${sparkArea(series, sw, sh)}"></path><path class="c-spark-line" d="${sparkPath(series, sw, sh)}"></path></svg>`;
      }
      if (c.dataset.html !== html) {
        c.innerHTML = html;
        c.dataset.html = html;
      }
      c.setAttribute('aria-label', `${s.name} ${pct(s.changePct)}，成交佔比 ${sharePct(s.share)}`);
    }
    this.applyFocus();
  }

  private showTooltip(e: MouseEvent, code: string): void {
    const s = this.metrics?.stockByCode.get(code);
    if (!s) return;
    const ind = this.metrics!.industryById.get(s.industryId);
    const series = this.history.get(code) ?? [];
    const d = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    this.tooltip.innerHTML =
      `<div class="tip-head"><b>${escapeHtml(s.name)}</b><span>${s.code} · ${escapeHtml(ind?.name ?? '')}</span></div>` +
      `<div class="tip-price"><b>${price(s.price)}</b><span class="${d}">${pct(s.changePct)}</span></div>` +
      (series.length > 2
        ? `<svg class="tip-spark ${d}" width="200" height="40" viewBox="0 0 200 40" aria-hidden="true"><path class="c-spark-area" d="${sparkArea(series, 200, 40)}"></path><path class="c-spark-line" d="${sparkPath(series, 200, 40)}"></path></svg>`
        : '') +
      `<dl class="tip-grid"><dt>成交額</dt><dd>${yi(s.turnover)}</dd>` +
      `<dt>成交佔比</dt><dd>${sharePct(s.share)}（常態 ${sharePct(s.baseShare)}）</dd>` +
      `<dt>資金流</dt><dd class="${s.flow >= 0 ? 'up' : 'down'}">${signedYi(s.flow)}</dd></dl>`;
    this.tooltip.hidden = false;
    const rect = this.el.getBoundingClientRect();
    const x = Math.min(e.clientX - rect.left + 18, rect.width - this.tooltip.offsetWidth - 10);
    const y = Math.min(e.clientY - rect.top + 18, rect.height - this.tooltip.offsetHeight - 10);
    this.tooltip.style.transform = `translate(${Math.max(10, x)}px, ${Math.max(10, y)}px)`;
  }
}

function place(el: HTMLElement, x: number, y: number, w: number, h: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, w)}px`;
  el.style.height = `${Math.max(0, h)}px`;
}
