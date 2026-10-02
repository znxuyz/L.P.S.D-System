import { color, hierarchy, treemap, treemapResquarify, type HierarchyNode, type HierarchyRectangularNode } from 'd3';
import type { Universe } from '../data/types';
import type { MarketMetrics } from '../domain/metrics';
import { assignTiles, buildTileGrid, type Tile, type TileGrid } from '../layout/tilegrid';
import type { Palette } from './colors';
import type { Focus } from './focus';
import { escapeHtml, pct, price, sharePct, signedYi, yi } from './format';
import { COIN, CURSOR, drawSprite, kingdomOf } from './sprites';

/**
 * 像素冒險世界地圖
 *
 * 地圖切成 8×8 像素的方格，每一格代表相同的成交額。用 resquarify treemap 依今日成交佔比
 * 排出每檔股票的範圍，再把格子分給格心所在的股票：格數 ≈ 成交額，同產業連成一個王國，
 * 盤中只有邊界的格子會易主。
 *
 * - 地面顏色 = 漲跌幅。
 * - 戰爭迷霧 = 成交低於常態（資金撤出）的領地蓋上一層暗色網點。
 * - 金幣 = 吸金最強的 6 檔，頭上有金幣跳動。
 * - 閃光 = 剛被別的股票奪下的格子。
 *
 * 底圖（格子、邊界、圖示、文字）只在資料或選取改變時重畫；金幣、游標、閃光畫在上層，每一幀更新。
 */

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

type Rect = HierarchyRectangularNode<Node>;

interface Territory {
  code: string;
  industry: string;
  tiles: Tile[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Tag {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 每格大約的面積（px²）：地圖越大格數越多。 */
const TILE_AREA = 560;
const MIN_TILES = 400;
const MAX_TILES = 1600;
const FONT = '"DotGothic16", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
const MAP_BG = '#1b2550';
const BORDER = '#20182e';
const GOLD = '#ffd43b';
const CAPTURE_MS = 900;

export class WorldMapView {
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly tooltip: HTMLDivElement;
  private readonly layout = treemap<Node>().tile(treemapResquarify).round(false);
  private readonly industryOf: Map<string, string>;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly root: HierarchyNode<Node>;
  private laidOut = false;
  private grid?: TileGrid;
  private territories = new Map<string, Territory>();
  private tags: Tag[] = [];
  private surging: string[] = [];
  private captured = new Map<number, number>();
  private width = 0;
  private height = 0;
  private dpr = 1;
  private metrics?: MarketMetrics;
  private pal?: Palette;
  private focus: Focus = null;
  private raf = 0;

  constructor(
    private readonly el: HTMLElement,
    universe: Universe,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    this.industryOf = new Map(universe.stocks.map((s) => [s.code, s.industryId]));
    this.root = hierarchy<Node>({
      id: 'root',
      name: '',
      children: universe.industries.map((ind) => ({
        id: ind.id,
        name: ind.name,
        children: universe.stocks.filter((s) => s.industryId === ind.id).map((s) => ({ id: s.code, name: s.name })),
      })),
    });

    this.base = document.createElement('canvas');
    this.base.className = 'wm-base';
    this.base.setAttribute('role', 'img');
    this.base.setAttribute('aria-label', '世界地圖：各產業王國與個股領地');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'wm-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    el.append(this.base, this.overlay);
    this.bctx = this.base.getContext('2d')!;
    this.octx = this.overlay.getContext('2d')!;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'rpg-tip';
    this.tooltip.hidden = true;
    el.appendChild(this.tooltip);

    this.overlay.addEventListener('click', (e) => {
      const hit = this.hitTest(e);
      this.onSelect(hit);
    });
    this.overlay.addEventListener('mousemove', (e) => {
      const hit = this.hitTest(e);
      this.overlay.style.cursor = hit ? 'pointer' : 'default';
      if (hit?.kind === 'stock') this.showTooltip(e, hit.id);
      else this.tooltip.hidden = true;
    });
    this.overlay.addEventListener('mouseleave', () => (this.tooltip.hidden = true));

    new ResizeObserver(() => this.resize()).observe(el);
    // 像素字型載入後重畫文字
    void document.fonts?.load(`16px ${FONT}`).then(() => this.drawBase());

    const loop = (t: number) => {
      this.drawOverlay(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  /** 每一格代表多少成交額（億元）。 */
  get yiPerTile(): number {
    return this.metrics && this.grid ? this.metrics.totalTurnover / this.grid.tiles.length : 0;
  }

  private resize(): void {
    const w = Math.floor(this.el.clientWidth);
    const h = Math.floor(this.el.clientHeight);
    if (w < 50 || h < 50 || (w === this.width && h === this.height)) return;
    this.width = w;
    this.height = h;
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const target = Math.max(MIN_TILES, Math.min(MAX_TILES, (w * h) / TILE_AREA));
    this.grid = buildTileGrid(w, h, target);
    this.captured.clear();
    if (this.metrics && this.pal) this.update(this.metrics, this.pal, true);
  }

  setFocus(focus: Focus): void {
    this.focus = focus;
    this.drawBase();
  }

  update(metrics: MarketMetrics, pal: Palette, relayout = false): void {
    const grid = this.grid;
    const firstOnGrid = relayout || !this.metrics;
    this.metrics = metrics;
    this.pal = pal;
    if (!grid) return;

    this.root.sum((d) => {
      if (d.children) return 0;
      const s = metrics.stockByCode.get(d.id);
      if (!s) return 0;
      return metrics.totalTurnover > 0 ? s.share : s.baseShare;
    });
    if (!this.laidOut) {
      this.root.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      this.laidOut = true;
    }
    const mapW = grid.cols * grid.size;
    const mapH = grid.rows * grid.size;
    this.layout.size([mapW, mapH])(this.root);
    const leaves = (this.root as Rect).leaves();

    const prevOwner = new Map(grid.tiles.map((t) => [t.i, t.owner]));
    const owned = assignTiles(
      grid.tiles,
      leaves.map((d) => ({
        id: d.data.id,
        group: d.parent!.data.id,
        x0: d.x0 + grid.ox,
        y0: d.y0 + grid.oy,
        x1: d.x1 + grid.ox,
        y1: d.y1 + grid.oy,
      })),
    );
    if (!firstOnGrid) {
      const now = performance.now();
      for (const t of grid.tiles) if (prevOwner.get(t.i) && prevOwner.get(t.i) !== t.owner) this.captured.set(t.i, now);
    }

    this.territories.clear();
    for (const [code, tiles] of owned) {
      if (!tiles.length) continue;
      this.territories.set(code, {
        code,
        industry: this.industryOf.get(code) ?? '',
        tiles,
        x0: Math.min(...tiles.map((t) => t.x)) - grid.size / 2,
        y0: Math.min(...tiles.map((t) => t.y)) - grid.size / 2,
        x1: Math.max(...tiles.map((t) => t.x)) + grid.size / 2,
        y1: Math.max(...tiles.map((t) => t.y)) + grid.size / 2,
      });
    }
    this.surging = [...metrics.stockByCode.values()]
      .filter((s) => s.flow > 0)
      .sort((a, b) => b.flow - a.flow)
      .slice(0, 6)
      .map((s) => s.code);

    this.drawBase();
  }

  // ------------------------------------------------------------ 底圖

  private focusMatch(t: Tile): boolean {
    const f = this.focus;
    if (!f) return true;
    if (f.kind === 'stock') return this.industryOf.get(f.id) === t.industry;
    return t.industry === f.id;
  }

  private drawBase(): void {
    const { grid, metrics, pal, bctx: ctx } = this;
    if (!grid || !metrics || !pal) return;
    const T = grid.size;
    const p = grid.pixel;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, this.width, this.height);

    const fog = this.ditherPattern(p, 'rgba(14, 10, 32, 0.78)', [[0, 0], [1, 1]], 2);
    const dim = 'rgba(12, 10, 28, 0.62)';

    // 1. 地面：漲跌色 + 兩個亮點當紋理
    for (const t of grid.tiles) {
      const s = metrics.stockByCode.get(t.owner);
      const fill = pal.heat(s?.changePct ?? 0);
      const x = t.x - T / 2;
      const y = t.y - T / 2;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, T, T);
      const light = color(fill)?.brighter(0.55).formatHex() ?? fill;
      ctx.fillStyle = light;
      const k = (t.col * 7 + t.row * 13) % 4;
      ctx.fillRect(x + (1 + k) * p, y + (2 + (k % 2)) * p, p, p);
      ctx.fillRect(x + (5 - (k % 3)) * p, y + (5 + (k % 2)) * p, p, p);
      // 2. 戰爭迷霧：資金撤出
      if (s && s.flow < 0) {
        ctx.fillStyle = fog;
        ctx.fillRect(x, y, T, T);
      }
      // 選取時，其他王國變暗
      if (!this.focusMatch(t)) {
        ctx.fillStyle = dim;
        ctx.fillRect(x, y, T, T);
      }
    }

    // 3. 邊界：領地之間是深色線，王國之間是金色虛線
    const at = (col: number, row: number) =>
      col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? grid.tiles[row * grid.cols + col] : undefined;
    for (const t of grid.tiles) {
      const x = t.x - T / 2;
      const y = t.y - T / 2;
      const right = at(t.col + 1, t.row);
      const down = at(t.col, t.row + 1);
      if (right && right.owner !== t.owner) {
        if (right.industry !== t.industry) this.dashed(x + T - p / 2, y, p, T, true);
        else {
          ctx.fillStyle = BORDER;
          ctx.fillRect(x + T - p / 2, y, p, T);
        }
      }
      if (down && down.owner !== t.owner) {
        if (down.industry !== t.industry) this.dashed(x, y + T - p / 2, T, p, false);
        else {
          ctx.fillStyle = BORDER;
          ctx.fillRect(x, y + T - p / 2, T, p);
        }
      }
    }
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = p;
    ctx.strokeRect(grid.ox + p / 2, grid.oy + p / 2, grid.cols * T - p, grid.rows * T - p);

    // 4. 領地圖示與名稱
    for (const terr of this.territories.values()) this.drawTerritoryLabel(terr, T, p);

    // 5. 王國旗幟
    this.drawTags(T, p);
  }

  private dashed(x: number, y: number, w: number, h: number, vertical: boolean): void {
    const ctx = this.bctx;
    const p = this.grid!.pixel;
    ctx.fillStyle = GOLD;
    const len = vertical ? h : w;
    for (let o = 0; o < len; o += p * 3) {
      const seg = Math.min(p * 2, len - o);
      if (vertical) ctx.fillRect(x, y + o, w, seg);
      else ctx.fillRect(x + o, y, seg, h);
    }
  }

  private ditherPattern(p: number, fill: string, dots: Array<[number, number]>, cells: number): CanvasPattern | string {
    const c = document.createElement('canvas');
    c.width = Math.ceil(p * cells * this.dpr);
    c.height = Math.ceil(p * cells * this.dpr);
    const g = c.getContext('2d');
    if (!g) return fill;
    g.fillStyle = fill;
    for (const [dx, dy] of dots) g.fillRect(dx * p * this.dpr, dy * p * this.dpr, Math.ceil(p * this.dpr), Math.ceil(p * this.dpr));
    const pattern = this.bctx.createPattern(c, 'repeat');
    if (!pattern) return fill;
    pattern.setTransform(new DOMMatrix().scale(1 / this.dpr));
    return pattern;
  }

  private drawTerritoryLabel(terr: Territory, T: number, p: number): void {
    const ctx = this.bctx;
    const s = this.metrics!.stockByCode.get(terr.code);
    if (!s) return;
    const n = terr.tiles.length;
    const bw = terr.x1 - terr.x0;
    const bh = terr.y1 - terr.y0;
    const cx = (terr.x0 + terr.x1) / 2;
    const cy = (terr.y0 + terr.y1) / 2;
    const scale = n >= 40 ? 3 : n >= 12 ? 2 : 1;
    const spriteSize = 8 * p * scale;
    const name = s.name;
    const font = Math.floor(Math.min((bw * 0.84) / Math.max(3.6, name.length), bh / 2.6, 30));
    const sprite = kingdomOf(terr.industry).sprite;
    const dimmed = this.focus && !this.focusMatch(terr.tiles[0]);
    ctx.globalAlpha = dimmed ? 0.35 : 1;

    const textBlock = font * 2.3;
    if (n >= 4 && bh >= spriteSize + textBlock + p * 2 && bw >= spriteSize && font >= 10) {
      const top = cy - (spriteSize + textBlock) / 2;
      drawSprite(ctx, sprite, cx - spriteSize / 2, top, p * scale);
      this.text(name, cx, top + spriteSize + font * 0.95, font);
      this.text(pct(s.changePct), cx, top + spriteSize + font * 2.05, Math.round(font * 0.82));
    } else if (font >= 10 && bh >= textBlock) {
      this.text(name, cx, cy - font * 0.1, font);
      this.text(pct(s.changePct), cx, cy + font * 1.0, Math.round(font * 0.82));
    } else if (font >= 9 && bh >= font * 1.3) {
      this.text(name, cx, cy + font * 0.4, font);
    } else if (n >= 1 && bw >= T && bh >= T) {
      drawSprite(ctx, sprite, cx - T / 2, cy - T / 2, p);
    }
    ctx.globalAlpha = 1;
  }

  private text(s: string, x: number, y: number, size: number): void {
    const ctx = this.bctx;
    ctx.font = `${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.22);
    ctx.strokeStyle = '#14102b';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s, x, y);
  }

  private drawTags(T: number, p: number): void {
    const { grid, metrics, bctx: ctx } = this;
    if (!grid || !metrics) return;
    const firstTile = new Map<string, Tile>();
    for (const t of grid.tiles) if (!firstTile.has(t.industry)) firstTile.set(t.industry, t);
    this.tags = [];
    const fontSize = 12;
    ctx.font = `${fontSize}px ${FONT}`;
    for (const [id, t] of firstTile) {
      const ind = metrics.industryById.get(id);
      if (!ind) continue;
      const up = ind.flow >= 0;
      const label = ind.name;
      const flow = `${up ? '▲' : '▼'}${Math.abs(ind.flow).toFixed(0)}`;
      const icon = 16;
      const w = 6 + icon + 4 + ctx.measureText(label).width + 6 + ctx.measureText(flow).width + 8;
      const h = 22;
      const x = Math.min(t.x - T / 2 + p * 2, this.width - w - 2);
      const y = t.y - T / 2 + p * 2;
      const dimmed = this.focus && !this.focusMatch(t);
      ctx.globalAlpha = dimmed ? 0.5 : 1;
      // RPG 視窗：深藍底、白框
      ctx.fillStyle = '#1c2a78';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      drawSprite(ctx, kingdomOf(id).sprite, x + 6, y + 3, 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 6 + icon + 4, y + h / 2 + 1);
      ctx.fillStyle = up ? this.pal!.up.bright : this.pal!.down.bright;
      ctx.fillText(flow, x + 6 + icon + 4 + ctx.measureText(label).width + 6, y + h / 2 + 1);
      ctx.globalAlpha = 1;
      this.tags.push({ id, x, y, w, h });
    }
  }

  // ------------------------------------------------------------ 動畫層

  private drawOverlay(now: number): void {
    const { grid, octx: ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!grid) return;
    ctx.imageSmoothingEnabled = false;
    const T = grid.size;
    const p = grid.pixel;
    const still = this.reducedMotion.matches;

    // 易主的格子閃白光
    for (const [i, start] of this.captured) {
      const age = now - start;
      if (age > CAPTURE_MS) {
        this.captured.delete(i);
        continue;
      }
      const t = grid.tiles[i];
      ctx.fillStyle = `rgba(255, 255, 255, ${(still ? 0.5 : 0.75 * (1 - age / CAPTURE_MS)).toFixed(3)})`;
      ctx.fillRect(t.x - T / 2, t.y - T / 2, T, T);
    }

    // 吸金最強的領地：金幣跳動
    this.surging.forEach((code, k) => {
      const terr = this.territories.get(code);
      if (!terr) return;
      const bob = still ? 0 : Math.sin(now / 260 + k) * p * 1.5;
      const coin = 8 * p;
      const cx = (terr.x0 + terr.x1) / 2;
      const y = Math.max(terr.y0 + p, terr.y0 + p * 2 + bob);
      drawSprite(ctx, COIN, Math.min(terr.x1 - coin - p, cx + coin * 0.2), y, p);
    });

    // 選取的領地：閃爍白框 + 游標
    const f = this.focus;
    if (f?.kind === 'stock') {
      const terr = this.territories.get(f.id);
      if (terr) {
        const mine = new Set(terr.tiles.map((t) => t.i));
        const at = (col: number, row: number) =>
          col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? grid.tiles[row * grid.cols + col].i : -1;
        ctx.fillStyle = `rgba(255, 255, 255, ${still ? 1 : (0.55 + 0.45 * Math.abs(Math.sin(now / 300))).toFixed(3)})`;
        for (const t of terr.tiles) {
          const x = t.x - T / 2;
          const y = t.y - T / 2;
          if (!mine.has(at(t.col - 1, t.row))) ctx.fillRect(x, y, p, T);
          if (!mine.has(at(t.col + 1, t.row))) ctx.fillRect(x + T - p, y, p, T);
          if (!mine.has(at(t.col, t.row - 1))) ctx.fillRect(x, y, T, p);
          if (!mine.has(at(t.col, t.row + 1))) ctx.fillRect(x, y + T - p, T, p);
        }
        const nudge = still ? 0 : Math.round(Math.sin(now / 180) * p);
        const cy = (terr.y0 + terr.y1) / 2 - 4 * p;
        const cxLeft = terr.x0 - 8 * p - p + nudge;
        drawSprite(ctx, CURSOR, Math.max(0, cxLeft), cy, p);
      }
    }
  }

  // ------------------------------------------------------------ 互動

  private hitTest(e: MouseEvent): Focus {
    const grid = this.grid;
    if (!grid) return null;
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tag = this.tags.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
    if (tag) return { kind: 'industry', id: tag.id };
    const col = Math.floor((x - grid.ox) / grid.size);
    const row = Math.floor((y - grid.oy) / grid.size);
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;
    const tile = grid.tiles[row * grid.cols + col];
    return tile.owner ? { kind: 'stock', id: tile.owner } : null;
  }

  private showTooltip(e: MouseEvent, code: string): void {
    const s = this.metrics?.stockByCode.get(code);
    if (!s) return;
    const terr = this.territories.get(code);
    const rect = this.el.getBoundingClientRect();
    const d = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
    this.tooltip.innerHTML =
      `<b>${escapeHtml(s.name)}</b> <span class="code">${s.code}</span>` +
      `<div class="tt-row"><span>股價</span><span>${price(s.price)} <span class="${d}">${pct(s.changePct)}</span></span></div>` +
      `<div class="tt-row"><span>領地</span><span>${terr?.tiles.length ?? 0} 格・${yi(s.turnover)}</span></div>` +
      `<div class="tt-row"><span>成交佔比</span><span>${sharePct(s.share)}（常態 ${sharePct(s.baseShare)}）</span></div>` +
      `<div class="tt-row"><span>資金流</span><span class="${s.flow >= 0 ? 'up' : 'down'}">${signedYi(s.flow)}</span></div>`;
    this.tooltip.hidden = false;
    const x = Math.min(e.clientX - rect.left + 16, rect.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY - rect.top + 16, rect.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
}
