/**
 * 個股的籌碼歷史（data/chips/<代號>.json）與加權指數日 K（data/index/TAIEX.json），
 * 由 GitHub Actions 每天產生，給個股分析頁的副圖使用。
 */

export interface ChipSeries {
  /** [日期, 外資＋投信買賣超（張）] */
  inst: Array<[string, number]>;
  /** [日期, 千張大戶持股比率（%）]，每週一筆 */
  big: Array<[string, number]>;
}

export async function loadChipSeries(code: string): Promise<ChipSeries | null> {
  try {
    const res = await fetch(`data/chips/${encodeURIComponent(code)}.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<ChipSeries>;
    return { inst: Array.isArray(j.inst) ? j.inst : [], big: Array.isArray(j.big) ? j.big : [] };
  } catch {
    return null;
  }
}

let taiex: Promise<Map<string, number> | null> | null = null;

/** 加權指數每日收盤（日期 → 收盤）。 */
export function loadTaiex(): Promise<Map<string, number> | null> {
  taiex ??= fetch('data/index/TAIEX.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<Array<[string, number, number, number, number]>>) : null))
    .then((rows) => (Array.isArray(rows) ? new Map(rows.map((r) => [r[0], r[4]])) : null))
    .catch(() => null);
  return taiex;
}
