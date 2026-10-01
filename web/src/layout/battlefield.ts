import { hierarchy } from 'd3';
import { voronoiTreemap } from 'd3-voronoi-treemap';
import { createRng } from '../data/random';
import type { IndustryId, StockMeta, Universe } from '../data/types';
import type { CastleSite, CastleTier } from '../domain/castles';
import { area, centroid, clipHalfPlane, distance, lerp, type Point, type Polygon } from './geometry';

/**
 * 戰場版面：產業圍在四周，中央是中立戰場，城池都在中央，各產業從外圍往中間進攻。
 *
 * 1. 中央戰場是一個和地圖等比例的橢圓（預設佔 20% 面積）。
 * 2. 外圈依市值切成扇形，每個產業一塊，從正上方順時針排列。
 *    扇形的內側是一條直線（橢圓上的弦），所以每塊都是凸多邊形，可以再切個股。
 *    超過外圈一半面積的產業（台積電所在的半導體）會拆成數塊相鄰的扇形，畫成同一塊領地。
 * 3. 城池分三層：正中央的核心城池（所有產業都能進攻）、內圈大型城池（面向約三個產業）、
 *    外圈小型據點（面向兩個相鄰產業）。
 *
 * 面積只由市值決定（以昨收計），盤中不重新配置，版面穩定。
 */

export interface StockCell {
  code: string;
  polygon: Polygon;
  centroid: Point;
  area: number;
  /** 標籤位置。凹多邊形的重心可能太靠近中央戰場，所以另外指定。 */
  labelAt: Point;
}

export interface Territory {
  industryId: IndustryId;
  /** 領地外框（多塊扇形合併後）。 */
  outer: Polygon;
  /** 內縮邊界後、實際放股票的各塊範圍。 */
  pieces: Polygon[];
  centroid: Point;
  /** 面向中央戰場的出擊點。 */
  gate: Point;
  labelAnchor: Point;
  cells: StockCell[];
}

export interface BattlefieldLayout {
  width: number;
  height: number;
  center: Point;
  /** 領地之間的間隔寬度。 */
  gutter: number;
  /** 中央中立戰場。 */
  field: Polygon;
  territories: Territory[];
  castles: CastleSite[];
}

export interface BattlefieldOptions {
  seed?: number;
  gutter?: number;
  /** 中央戰場佔整張地圖的面積比例。 */
  fieldShare?: number;
}

/** 產業在外圈的排列順序（從正上方順時針），讓相關產業彼此相鄰。 */
const RING_ORDER = ['semi', 'comp', 'pc', 'oe', 'net', 'opto', 'mech', 'bio', 'trad', 'plastic', 'steel', 'ship', 'fin'];
/** 單一扇形最多佔外圈面積的比例，超過就拆塊，確保扇形角度小於 180°。 */
const MAX_PIECE_SHARE = 0.45;
/** 多檔股票的扇形內側用直線（弦），角度太大會切進中央戰場，所以再拆小一點。 */
const MAX_MULTI_PIECE_SHARE = 0.12;
const TAU = Math.PI * 2;

interface WeightedNode {
  id: string;
  weight: number;
  children?: WeightedNode[];
}

function runTreemap(items: WeightedNode[], clip: Polygon, rng: () => number): Map<string, Polygon> {
  const root = hierarchy<WeightedNode>({ id: 'root', weight: 0, children: items }).sum((d) => (d.children ? 0 : d.weight));
  voronoiTreemap()
    .clip(clip.map((p) => [p[0], p[1]] as [number, number]))
    .prng(rng)
    .minWeightRatio(0.002)
    .maxIterationCount(80)
    .convergenceRatio(0.005)(root);
  const out = new Map<string, Polygon>();
  for (const leaf of root.leaves()) {
    const poly = (leaf as unknown as { polygon?: Point[] }).polygon;
    if (poly) out.set(leaf.data.id, poly.map((p) => [p[0], p[1]] as Point));
  }
  return out;
}

/** 把產業的股票分成 k 組，讓每組市值盡量平均（大的先放）。 */
function splitStocks(stocks: StockMeta[], k: number): StockMeta[][] {
  const groups: StockMeta[][] = Array.from({ length: k }, () => []);
  const sums = new Array<number>(k).fill(0);
  for (const s of [...stocks].sort((a, b) => b.marketCap - a.marketCap)) {
    const i = sums.indexOf(Math.min(...sums));
    groups[i].push(s);
    sums[i] += s.marketCap;
  }
  // 依市值由大到小排列，讓最大的一塊排在產業的起點
  return groups.filter((g) => g.length).sort((a, b) => sum(b) - sum(a));
}

const sum = (g: StockMeta[]) => g.reduce((s, x) => s + x.marketCap, 0);


/** 合併兩個共用一條邊的凸多邊形（頂點方向需一致）。 */
function mergeAdjacent(p1: Polygon, p2: Polygon, eps: number): Polygon | undefined {
  for (let i = 0; i < p1.length; i++) {
    const a = p1[i];
    const b = p1[(i + 1) % p1.length];
    for (let j = 0; j < p2.length; j++) {
      const c = p2[j];
      const d = p2[(j + 1) % p2.length];
      if (distance(a, d) < eps && distance(b, c) < eps) {
        const out: Polygon = [];
        for (let k = 0; k < p1.length; k++) out.push(p1[(i + 1 + k) % p1.length]);
        for (let k = 2; k < p2.length; k++) out.push(p2[(j + k) % p2.length]);
        return out;
      }
    }
  }
  return undefined;
}

function mergePieces(pieces: Polygon[], eps: number): Polygon {
  let merged = pieces[0] ?? [];
  for (const p of pieces.slice(1)) merged = mergeAdjacent(merged, p, eps) ?? (area(p) > area(merged) ? p : merged);
  return merged;
}

function pointInPolygon(poly: Polygon, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 角度 a 是否落在 [start, start + span) 內。 */
function angleIn(a: number, start: number, span: number): boolean {
  return (((a - start) % TAU) + TAU) % TAU < span;
}

function angularOverlap(start: number, span: number, lo: number, width: number): number {
  // 在 [lo, lo + width] 內取樣，計算與扇形重疊的比例
  let hit = 0;
  const n = 48;
  for (let i = 0; i < n; i++) if (angleIn(lo + ((i + 0.5) / n) * width, start, span)) hit++;
  return hit / n;
}

export function computeBattlefield(universe: Universe, width: number, height: number, options: BattlefieldOptions = {}): BattlefieldLayout {
  const rng = createRng(options.seed ?? 42);
  const m = Math.min(width, height);
  const gutter = options.gutter ?? Math.max(2.5, m * 0.006);
  const fieldShare = options.fieldShare ?? 0.2;
  const c: Point = [width / 2, height / 2];

  // 中央橢圓：與地圖等比例，面積 = fieldShare
  const k = Math.sqrt((4 * fieldShare) / Math.PI);
  const ea = (k * width) / 2;
  const eb = (k * height) / 2;
  const ellipseR = (a: number) => 1 / Math.sqrt((Math.cos(a) / ea) ** 2 + (Math.sin(a) / eb) ** 2);
  const rectR = (a: number) => Math.min((width / 2) / Math.abs(Math.cos(a) || 1e-12), (height / 2) / Math.abs(Math.sin(a) || 1e-12));
  const density = (a: number) => 0.5 * (rectR(a) ** 2 - ellipseR(a) ** 2);

  // --- 產業 → 扇形塊 ---
  const known = new Set(universe.industries.map((i) => i.id));
  const ring = [...RING_ORDER.filter((id) => known.has(id)), ...[...known].filter((id) => !RING_ORDER.includes(id))];
  const totalCap = universe.stocks.reduce((s, x) => s + x.marketCap, 0);
  interface Piece { industryId: IndustryId; stocks: StockMeta[]; share: number; start: number; span: number; internalLo: boolean; internalHi: boolean }
  const pieces: Piece[] = [];
  for (const id of ring) {
    const stocks = universe.stocks.filter((s) => s.industryId === id);
    const share = sum(stocks) / totalCap;
    let groups = splitStocks(stocks, Math.max(1, Math.ceil(share / MAX_PIECE_SHARE)));
    groups = groups.flatMap((g) =>
      g.length > 1 && sum(g) / totalCap > MAX_MULTI_PIECE_SHARE
        ? splitStocks(g, Math.ceil(sum(g) / totalCap / MAX_MULTI_PIECE_SHARE))
        : [g],
    );
    groups.forEach((g, i) => pieces.push({
      industryId: id, stocks: g, share: sum(g) / totalCap, start: 0, span: 0,
      internalLo: i > 0, internalHi: i < groups.length - 1,
    }));
  }

  // --- 數值積分求扇形邊界角度，讓每塊面積符合市值比例 ---
  const steps = 7200;
  const dA = TAU / steps;
  let ringArea = 0;
  for (let i = 0; i < steps; i++) ringArea += density(i * dA) * dA;
  const firstIndustry = pieces.filter((p) => p.industryId === pieces[0].industryId);
  const firstShare = firstIndustry.reduce((s, p) => s + p.share, 0);
  // 讓第一個產業的中線落在正上方
  let start = -Math.PI / 2;
  for (let acc = 0; acc < (firstShare / 2) * ringArea; ) {
    start -= dA;
    acc += density(start) * dA;
  }
  let angle = start;
  for (const p of pieces) {
    const target = p.share * ringArea;
    let acc = 0;
    p.start = angle;
    while (acc < target && angle < start + TAU) {
      acc += density(angle) * dA;
      angle += dA;
    }
    p.span = angle - p.start;
  }
  pieces[pieces.length - 1].span = start + TAU - pieces[pieces.length - 1].start;

  // --- 每塊扇形的多邊形 ---
  const rect: Polygon = [[0, 0], [0, height], [width, height], [width, 0]];
  const fieldPoint = (a: number): Point => [c[0] + Math.cos(a) * ellipseR(a), c[1] + Math.sin(a) * ellipseR(a)];
  const insetRect = (poly: Polygon, g: number): Polygon => {
    if (g <= 0) return poly;
    poly = clipHalfPlane(poly, [0, 0], [1, 0], g);
    poly = clipHalfPlane(poly, [0, 0], [0, 1], g);
    poly = clipHalfPlane(poly, [width, height], [-1, 0], g);
    return clipHalfPlane(poly, [width, height], [0, -1], g);
  };
  const clipRays = (poly: Polygon, p: Piece, g: number): Polygon => {
    const a0 = p.start;
    const a1 = p.start + p.span;
    poly = clipHalfPlane(poly, c, [-Math.sin(a0), Math.cos(a0)], p.internalLo ? 0 : g);
    return clipHalfPlane(poly, c, [Math.sin(a1), -Math.cos(a1)], p.internalHi ? 0 : g);
  };
  const arcPoints = (a0: number, a1: number, extra: number): Polygon => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.05));
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / n;
      const r = ellipseR(a) + extra;
      return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r] as Point;
    });
  };
  /** 多檔股票：內側是弦，整塊是凸多邊形。 */
  const chordPolygon = (p: Piece, g: number): Polygon => {
    const q0 = fieldPoint(p.start);
    const q1 = fieldPoint(p.start + p.span);
    const ex = q1[0] - q0[0];
    const ey = q1[1] - q0[1];
    const len = Math.hypot(ex, ey) || 1;
    let n: Point = [-ey / len, ex / len];
    if ((q0[0] - c[0]) * n[0] + (q0[1] - c[1]) * n[1] < 0) n = [-n[0], -n[1]];
    return clipHalfPlane(clipRays(insetRect(rect, g), p, g), q0, n, g);
  };
  /** 單一股票：內側沿著橢圓弧，不需要再切個股，所以可以是凹多邊形。 */
  const arcPolygon = (p: Piece, g: number): Polygon => {
    const wedge = clipRays(rect, { ...p, internalLo: true, internalHi: true }, 0);
    const idx = wedge.reduce((best, q, i) => (distance(q, c) < distance(wedge[best], c) ? i : best), 0);
    const prev = wedge[(idx - 1 + wedge.length) % wedge.length];
    const prevAngle = Math.atan2(prev[1] - c[1], prev[0] - c[0]);
    const a0 = p.start;
    const a1 = p.start + p.span;
    const prevIsStart = Math.abs(Math.atan2(Math.sin(prevAngle - a0), Math.cos(prevAngle - a0))) < 1e-3;
    const arc = prevIsStart ? arcPoints(a0, a1, g) : arcPoints(a1, a0, g);
    const poly = [...wedge.slice(0, idx), ...arc, ...wedge.slice(idx + 1)];
    return clipRays(insetRect(poly, g), p, g);
  };
  const piecePolygon = (p: Piece, inset: boolean): Polygon =>
    p.stocks.length === 1 ? arcPolygon(p, inset ? gutter : 0) : chordPolygon(p, inset ? gutter : 0);

  const field: Polygon = pieces.flatMap((p) =>
    p.stocks.length === 1 ? arcPoints(p.start, p.start + p.span, 0).slice(0, -1) : [fieldPoint(p.start)],
  );

  // --- 領地與個股 ---
  const eps = Math.max(0.5, m * 0.001);
  const territories: Territory[] = universe.industries.map((ind) => {
    const own = pieces.filter((p) => p.industryId === ind.id);
    const outers = own.map((p) => piecePolygon(p, false));
    const inners = own.map((p) => piecePolygon(p, true));
    const cells: StockCell[] = [];
    own.forEach((p, i) => {
      if (inners[i].length < 3) return;
      if (p.stocks.length === 1) {
        const poly = inners[i];
        const a = p.start + p.span / 2;
        const r = ellipseR(a) + 0.45 * (rectR(a) - ellipseR(a));
        const at: Point = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
        cells.push({ code: p.stocks[0].code, polygon: poly, centroid: centroid(poly), area: area(poly), labelAt: at });
        return;
      }
      const polys = runTreemap(p.stocks.map((s) => ({ id: s.code, weight: s.marketCap })), inners[i], rng);
      for (const s of p.stocks) {
        const poly = polys.get(s.code);
        if (!poly) continue;
        const ctr = centroid(poly);
        cells.push({ code: s.code, polygon: poly, centroid: ctr, area: area(poly), labelAt: ctr });
      }
    });
    const outer = mergePieces(outers, eps);
    const a0 = own[0]?.start ?? 0;
    const a1 = own.length ? own[own.length - 1].start + own[own.length - 1].span : 0;
    const mid = (a0 + a1) / 2;
    const innerC = outer.length ? centroid(outer) : c;
    const gate = lerp(fieldPoint(mid), innerC, 0.12);
    // 標籤放在遠離中央的一側，把面向中央的前線留給兵力流
    const label: Point = [
      c[0] + Math.cos(mid) * (ellipseR(mid) + 0.86 * (rectR(mid) - ellipseR(mid))),
      c[1] + Math.sin(mid) * (ellipseR(mid) + 0.86 * (rectR(mid) - ellipseR(mid))),
    ];
    const labelAnchor = inners.some((p) => p.length >= 3 && pointInPolygon(p, label)) ? label : innerC;
    return { industryId: ind.id, outer, pieces: inners, centroid: innerC, gate, labelAnchor, cells };
  });

  // --- 城池 ---
  const industryOrder = new Map(universe.industries.map((ind, i) => [ind.id, i]));
  const spans = ring.map((id) => {
    const own = pieces.filter((p) => p.industryId === id);
    return { id, start: own[0].start, span: own.reduce((s, p) => s + p.span, 0) };
  });
  const facing = (a: number, halfWidth: number, count: number): IndustryId[] => {
    const ranked = spans
      .map((s) => ({ id: s.id, overlap: angularOverlap(s.start, s.span, a - halfWidth, halfWidth * 2) }))
      .filter((s) => s.overlap > 0)
      .sort((x, y) => y.overlap - x.overlap)
      .map((s) => s.id);
    const picked = ranked.slice(0, count);
    if (picked.length < 2) {
      // 視窗只碰到一個產業時，補上角度最近的鄰居
      const idx = ring.indexOf(picked[0]);
      const own = spans[idx];
      const toStart = Math.abs(((a - own.start) % TAU + TAU) % TAU);
      const neighbour = toStart < own.span / 2 ? ring[(idx - 1 + ring.length) % ring.length] : ring[(idx + 1) % ring.length];
      picked.push(neighbour);
    }
    return picked.sort((x, y) => industryOrder.get(x)! - industryOrder.get(y)!);
  };

  const rc = Math.sqrt(ea * eb);
  const castles: CastleSite[] = [
    {
      id: 'castle-1', label: '#01', tier: 'core', x: c[0], y: c[1],
      r: Math.min(rc * 0.18, m * 0.06),
      contestants: [...known].sort((x, y) => industryOrder.get(x)! - industryOrder.get(y)!),
    },
  ];
  const ringCastles = (count: number, offset: number, depth: number, tier: CastleTier, radius: number, halfWidth: number, reach: number) => {
    for (let i = 0; i < count; i++) {
      const a = offset + (TAU * i) / count;
      const n = castles.length + 1;
      const r = ellipseR(a) * depth;
      castles.push({
        id: `castle-${n}`,
        label: `#${String(n).padStart(2, '0')}`,
        tier,
        x: c[0] + Math.cos(a) * r,
        y: c[1] + Math.sin(a) * r,
        r: radius,
        contestants: facing(a, halfWidth, reach),
      });
    }
  };
  ringCastles(4, -Math.PI / 4, 0.55, 'major', Math.min(rc * 0.14, m * 0.045), (50 * Math.PI) / 180, 3);
  ringCastles(7, -Math.PI / 2, 0.84, 'minor', Math.min(rc * 0.105, m * 0.035), (24 * Math.PI) / 180, 2);

  return { width, height, center: c, gutter, field, territories, castles };
}


