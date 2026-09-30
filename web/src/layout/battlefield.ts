import { hierarchy } from 'd3';
import { voronoiTreemap } from 'd3-voronoi-treemap';
import { createRng } from '../data/random';
import type { IndustryId, Universe } from '../data/types';
import type { CastleSite, CastleTier } from '../domain/castles';
import { area, centroid, clipHalfPlane, distance, insetConvex, lerp, type Point, type Polygon } from './geometry';

/**
 * 戰場版面：Voronoi Treemap。
 *
 * 1. 第一層依產業市值切出「產業領地」。
 * 2. 在三個以上領地交會的頂點挑出城池位置，把各領地在該頂點的角切掉，留出中立空地。
 *    切角用半平面裁切，領地仍維持凸多邊形。
 * 3. 領地往內縮一點當作邊界（城牆與戰線），再依個股市值切出股票區塊。
 *
 * 面積只由市值決定（以昨收計），盤中不重新配置，版面穩定。
 */

export interface StockCell {
  code: string;
  polygon: Polygon;
  centroid: Point;
  area: number;
}

export interface Territory {
  industryId: IndustryId;
  /** Voronoi 原始領地邊界。 */
  outer: Polygon;
  /** 挖出城池、內縮邊界後，實際放股票的範圍。 */
  inner: Polygon;
  centroid: Point;
  labelAnchor: Point;
  cells: StockCell[];
}

export interface BattlefieldLayout {
  width: number;
  height: number;
  territories: Territory[];
  castles: CastleSite[];
}

export interface BattlefieldOptions {
  seed?: number;
  castleCount?: number;
  gutter?: number;
}

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

interface Junction {
  point: Point;
  industries: IndustryId[];
  /** 位在地圖外框上的交會點：往內推的方向。內部交會點為 undefined。 */
  inward?: Point;
}

/**
 * 找出領地之間的交會頂點：
 * - 內部：三個以上領地交會。
 * - 外框：兩個領地在地圖邊緣交會（邊境據點）。
 */
function findJunctions(polys: Map<IndustryId, Polygon>, width: number, height: number, eps: number): Junction[] {
  const clusters: Array<{ sum: Point; count: number; ids: Set<IndustryId> }> = [];
  for (const [id, poly] of polys) {
    for (const p of poly) {
      let hit = clusters.find((c) => distance([c.sum[0] / c.count, c.sum[1] / c.count], p) < eps);
      if (!hit) {
        hit = { sum: [0, 0], count: 0, ids: new Set() };
        clusters.push(hit);
      }
      hit.sum = [hit.sum[0] + p[0], hit.sum[1] + p[1]];
      hit.count += 1;
      hit.ids.add(id);
    }
  }
  const margin = eps * 2;
  const result: Junction[] = [];
  for (const c of clusters) {
    const point: Point = [c.sum[0] / c.count, c.sum[1] / c.count];
    const industries = [...c.ids];
    const edges: Point[] = [];
    if (point[0] <= margin) edges.push([1, 0]);
    if (point[0] >= width - margin) edges.push([-1, 0]);
    if (point[1] <= margin) edges.push([0, 1]);
    if (point[1] >= height - margin) edges.push([0, -1]);
    if (edges.length === 0 && industries.length >= 3) result.push({ point, industries });
    // 角落不放城池
    else if (edges.length === 1 && industries.length >= 2) result.push({ point, industries, inward: edges[0] });
  }
  return result;
}

export function computeBattlefield(universe: Universe, width: number, height: number, options: BattlefieldOptions = {}): BattlefieldLayout {
  const rng = createRng(options.seed ?? 42);
  const castleCount = options.castleCount ?? 11;
  const m = Math.min(width, height);
  const gutter = options.gutter ?? Math.max(2.5, m * 0.006);

  const capByIndustry = new Map<IndustryId, number>();
  for (const s of universe.stocks) capByIndustry.set(s.industryId, (capByIndustry.get(s.industryId) ?? 0) + s.marketCap);
  const totalCap = [...capByIndustry.values()].reduce((a, b) => a + b, 0);

  const rect: Polygon = [[0, 0], [0, height], [width, height], [width, 0]];
  const outerPolys = runTreemap(
    universe.industries.map((ind) => ({ id: ind.id, weight: capByIndustry.get(ind.id) ?? 0 })),
    rect,
    rng,
  );
  const centroids = new Map<IndustryId, Point>([...outerPolys].map(([id, p]) => [id, centroid(p)]));

  // --- 挑選城池位置 ---
  const center: Point = [width / 2, height / 2];
  const maxDist = Math.hypot(width, height) / 2;
  const tierRadius: Record<CastleTier, number> = { core: m * 0.058, major: m * 0.045, minor: m * 0.034 };
  const candidates = findJunctions(outerPolys, width, height, Math.max(1, m * 0.004))
    .map((j) => {
      // 外框上的據點往內推，讓城池完整出現在畫面上
      const point: Point = j.inward
        ? [j.point[0] + j.inward[0] * tierRadius.minor * 1.1, j.point[1] + j.inward[1] * tierRadius.minor * 1.1]
        : j.point;
      const capShare = j.industries.reduce((s, id) => s + (capByIndustry.get(id) ?? 0), 0) / totalCap;
      const centrality = 1 - distance(point, center) / maxDist;
      // 可挖出的空間受限於最近的相鄰領地中心
      const room = Math.min(...j.industries.map((id) => distance(point, centroids.get(id)!)));
      const score =
        Math.sqrt(capShare) + centrality * 0.9 + Math.min(1, room / (m * 0.2)) * 0.5 - (j.inward ? 0.35 : 0);
      return { ...j, point, centrality, room, score };
    })
    .sort((a, b) => b.score - a.score);

  const minSpacing = m * 0.13;
  const picked: typeof candidates = [];
  for (const j of candidates) {
    if (picked.length >= castleCount) break;
    if (j.room < m * 0.05) continue;
    if (picked.every((p) => distance(p.point, j.point) >= minSpacing)) picked.push(j);
  }

  // 最靠近中央的內部交會點是核心城池，其次三座是大型城池，其餘是小型據點
  const byCentrality = [...picked].sort((a, b) => Number(!!a.inward) - Number(!!b.inward) || b.centrality - a.centrality);
  const tierOf = new Map<(typeof picked)[number], CastleTier>();
  byCentrality.forEach((j, i) => tierOf.set(j, i === 0 ? 'core' : i <= 3 && !j.inward ? 'major' : 'minor'));

  const industryOrder = new Map(universe.industries.map((ind, i) => [ind.id, i]));
  const castles: CastleSite[] = picked
    .sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0])
    .map((j, i) => {
      const tier = tierOf.get(j)!;
      return {
        id: `castle-${i + 1}`,
        label: `#${String(i + 1).padStart(2, '0')}`,
        tier,
        x: j.point[0],
        y: j.point[1],
        r: Math.min(tierRadius[tier], j.room * 0.38),
        contestants: [...j.industries].sort((a, b) => industryOrder.get(a)! - industryOrder.get(b)!).slice(0, 3),
      };
    });
  const castleSource = new Map(castles.map((c, i) => [c, picked[i]]));

  // --- 領地：挖出城池空地、內縮邊界，再切出股票區塊 ---
  const territories: Territory[] = universe.industries.map((ind) => {
    const outer = outerPolys.get(ind.id) ?? [];
    const c = centroids.get(ind.id) ?? [width / 2, height / 2];
    let inner = outer;
    for (const castle of castles) {
      const v: Point = [castle.x, castle.y];
      if (!castleSource.get(castle)?.industries.includes(ind.id)) continue;
      const d = distance(c, v);
      if (d < 1e-6) continue;
      const normal: Point = [(c[0] - v[0]) / d, (c[1] - v[1]) / d];
      inner = clipHalfPlane(inner, v, normal, castle.r * 1.15);
    }
    inner = insetConvex(inner, gutter);

    const stocks = universe.stocks.filter((s) => s.industryId === ind.id);
    const cells: StockCell[] = [];
    if (inner.length >= 3) {
      const polys = runTreemap(stocks.map((s) => ({ id: s.code, weight: s.marketCap })), inner, rng);
      for (const s of stocks) {
        const poly = polys.get(s.code);
        if (poly) cells.push({ code: s.code, polygon: poly, centroid: centroid(poly), area: area(poly) });
      }
    }

    // 產業標籤放在領地上緣附近
    const top = inner.reduce((best, p) => (p[1] < best[1] ? p : best), inner[0] ?? c);
    const labelAnchor = inner.length ? lerp(top, centroid(inner), 0.18) : c;
    return { industryId: ind.id, outer, inner, centroid: inner.length ? centroid(inner) : c, labelAnchor, cells };
  });

  return { width, height, territories, castles };
}
