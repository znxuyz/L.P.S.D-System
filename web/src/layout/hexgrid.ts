/**
 * 六角格領地的純計算：建立格網、把格子分給各股票。
 */

export interface Hex {
  i: number;
  x: number;
  y: number;
  /** 擁有這一格的股票代號。 */
  owner: string;
  /** 擁有者所屬的產業。 */
  industry: string;
}

export interface OwnerRect {
  id: string;
  group: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const SQRT3 = Math.sqrt(3);

/** 尖頂六角格，奇數列往右錯半格；格子大小讓總數接近 target。 */
export function buildHexGrid(width: number, height: number, target: number): { r: number; hexes: Hex[] } {
  const r = Math.sqrt((width * height) / (target * 1.5 * SQRT3));
  const dx = SQRT3 * r;
  const dy = 1.5 * r;
  const hexes: Hex[] = [];
  for (let row = 0, y = r; y <= height - r * 0.5; row++, y += dy) {
    for (let x = dx / 2 + (row % 2 ? dx / 2 : 0); x <= width - dx / 2 + 0.01; x += dx) {
      hexes.push({ i: hexes.length, x, y, owner: '', industry: '' });
    }
  }
  return { r, hexes };
}

/**
 * 每一格分給格心所在的範圍；落在範圍外的分給最近的範圍。
 * 小於一格的範圍，從最近且擁有多格的範圍借一格，確保每檔股票都看得到。
 */
export function assignHexes(hexes: Hex[], rects: OwnerRect[]): Map<string, Hex[]> {
  const owned = new Map<string, Hex[]>(rects.map((d) => [d.id, []]));
  const byId = new Map(rects.map((d) => [d.id, d]));
  for (const hex of hexes) {
    let rect = rects.find((d) => hex.x >= d.x0 && hex.x < d.x1 && hex.y >= d.y0 && hex.y < d.y1);
    if (!rect) {
      let best = Infinity;
      for (const d of rects) {
        const ddx = Math.max(d.x0 - hex.x, 0, hex.x - d.x1);
        const ddy = Math.max(d.y0 - hex.y, 0, hex.y - d.y1);
        const dist = ddx * ddx + ddy * ddy;
        if (dist < best) {
          best = dist;
          rect = d;
        }
      }
    }
    if (!rect) continue;
    hex.owner = rect.id;
    hex.industry = rect.group;
    owned.get(rect.id)!.push(hex);
  }
  for (const rect of rects) {
    if (owned.get(rect.id)!.length) continue;
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    let best: Hex | undefined;
    let bestDist = Infinity;
    for (const h of hexes) {
      if ((owned.get(h.owner)?.length ?? 0) < 2) continue;
      const dist = (h.x - cx) ** 2 + (h.y - cy) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = h;
      }
    }
    if (!best) continue;
    const prev = owned.get(best.owner)!;
    prev.splice(prev.indexOf(best), 1);
    best.owner = rect.id;
    best.industry = byId.get(rect.id)!.group;
    owned.get(rect.id)!.push(best);
  }
  return owned;
}
