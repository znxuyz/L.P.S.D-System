export type Point = [number, number];
export type Polygon = Point[];

export function signedArea(poly: Polygon): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function area(poly: Polygon): number {
  return Math.abs(signedArea(poly));
}

export function centroid(poly: Polygon): Point {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * 以半平面裁切凸多邊形，保留 (p − origin)·normal ≥ offset 的部分。
 * 凸多邊形裁切後仍是凸多邊形。
 */
export function clipHalfPlane(poly: Polygon, origin: Point, normal: Point, offset: number): Polygon {
  const side = (p: Point) => (p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1] - offset;
  const out: Polygon = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    const sc = side(cur);
    const sn = side(next);
    if (sc >= 0) out.push(cur);
    if ((sc >= 0) !== (sn >= 0)) {
      const t = sc / (sc - sn);
      out.push([cur[0] + (next[0] - cur[0]) * t, cur[1] + (next[1] - cur[1]) * t]);
    }
  }
  return out;
}

/** 凸多邊形往內縮 d。 */
export function insetConvex(poly: Polygon, d: number): Polygon {
  if (poly.length < 3 || d <= 0) return poly;
  const sign = signedArea(poly) > 0 ? 1 : -1;
  let result = poly;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    // 指向多邊形內側的法向量
    const normal: Point = [(-ey / len) * sign, (ex / len) * sign];
    result = clipHalfPlane(result, a, normal, d);
    if (result.length < 3) return [];
  }
  return result;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function pathData(poly: Polygon): string {
  if (poly.length === 0) return '';
  return `M${poly.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`;
}
