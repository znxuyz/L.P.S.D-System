/**
 * 世界地圖的方格：建立格網、把格子分給各股票。
 */

export interface Tile {
  i: number;
  col: number;
  row: number;
  /** 格心座標。 */
  x: number;
  y: number;
  /** 擁有這一格的股票代號。 */
  owner: string;
  /** 擁有者所屬的產業。 */
  industry: string;
}

export interface TileGrid {
  /** 每格邊長（px），一定是像素大小的 8 倍。 */
  size: number;
  /** 一個「像素」的邊長（px）。 */
  pixel: number;
  cols: number;
  rows: number;
  /** 置中後的左上角位移。 */
  ox: number;
  oy: number;
  tiles: Tile[];
}

export interface OwnerRect {
  id: string;
  group: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 每格 8×8 像素；像素大小取整數，讓格數大約落在 target 附近。 */
export function buildTileGrid(width: number, height: number, target: number): TileGrid {
  const pixel = Math.max(2, Math.round(Math.sqrt((width * height) / target) / 8));
  const size = pixel * 8;
  const cols = Math.max(1, Math.floor(width / size));
  const rows = Math.max(1, Math.floor(height / size));
  const ox = Math.floor((width - cols * size) / 2);
  const oy = Math.floor((height - rows * size) / 2);
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({ i: tiles.length, col, row, x: ox + (col + 0.5) * size, y: oy + (row + 0.5) * size, owner: '', industry: '' });
    }
  }
  return { size, pixel, cols, rows, ox, oy, tiles };
}

/**
 * 每一格分給格心所在的範圍；落在範圍外的分給最近的範圍。
 * 小於一格的範圍，從最近且擁有多格的範圍借一格，確保每檔股票都看得到。
 */
export function assignTiles(tiles: Tile[], rects: OwnerRect[]): Map<string, Tile[]> {
  const owned = new Map<string, Tile[]>(rects.map((d) => [d.id, []]));
  const byId = new Map(rects.map((d) => [d.id, d]));
  for (const tile of tiles) {
    let rect = rects.find((d) => tile.x >= d.x0 && tile.x < d.x1 && tile.y >= d.y0 && tile.y < d.y1);
    if (!rect) {
      let best = Infinity;
      for (const d of rects) {
        const dx = Math.max(d.x0 - tile.x, 0, tile.x - d.x1);
        const dy = Math.max(d.y0 - tile.y, 0, tile.y - d.y1);
        const dist = dx * dx + dy * dy;
        if (dist < best) {
          best = dist;
          rect = d;
        }
      }
    }
    if (!rect) continue;
    tile.owner = rect.id;
    tile.industry = rect.group;
    owned.get(rect.id)!.push(tile);
  }
  for (const rect of rects) {
    if (owned.get(rect.id)!.length) continue;
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    let best: Tile | undefined;
    let bestDist = Infinity;
    for (const t of tiles) {
      if ((owned.get(t.owner)?.length ?? 0) < 2) continue;
      const dist = (t.x - cx) ** 2 + (t.y - cy) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
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
