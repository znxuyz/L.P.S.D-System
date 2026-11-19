/**
 * 盤中紀錄補抓：網頁是開了才開始每分鐘記錄，晚開（或中途關掉）就少了前面那段。
 * 用富果「當日 1 分 K」把 09:00 到現在缺的分鐘補起來（熱力圖小走勢線、資金輪動、資金流都靠這份紀錄）。
 *
 * - 已經有的分鐘（網頁開著時記錄的真實報價）不動，只補缺的。
 * - 每分鐘的成交額＝那一分鐘以前的累計；1 分 K 只有量，先用「量 × 均價」估，再按即時報價的真實累計成交額等比例校正。
 */
import type { FugleCandleRaw } from './fugle';
import type { TurnoverBar } from './types';

const MIN = 60_000;

/** 開盤到 untilMs 之間，有沒有缺超過 gapMin 分鐘的紀錄。 */
export function hasGap(bars: TurnoverBar[], openMs: number, untilMs: number, gapMin = 3): boolean {
  const end = Math.floor(untilMs / MIN) * MIN;
  if (end - openMs < gapMin * MIN) return false;
  let prev = openMs;
  for (const b of bars) {
    if (b.t < openMs) continue;
    if (b.t > end) break;
    if (b.t - prev > gapMin * MIN) return true;
    prev = b.t;
  }
  return end - prev > gapMin * MIN;
}

/**
 * 把 1 分 K 補進每分鐘紀錄。
 * candles：代號 → 當日 1 分 K；turnoverNow：代號 → 現在的累計成交額（億元，用來校正）。
 * untilMs：補到哪一分鐘（含）；通常是現在或收盤。
 */
export function fillBars(
  bars: TurnoverBar[],
  candles: Map<string, FugleCandleRaw[]>,
  turnoverNow: Record<string, number>,
  openMs: number,
  untilMs: number,
): TurnoverBar[] {
  const have = new Set(bars.map((b) => b.t));
  // 每檔：依時間排序的 [分鐘起點, 累計成交額(億), 收盤價]
  const series = new Map<string, Array<[number, number, number]>>();
  let last = 0;
  for (const [code, rows] of candles) {
    const list = rows
      .map((c) => ({ t: Math.floor(Date.parse(c.date) / MIN) * MIN, v: c.volume ?? 0, p: c.close ?? 0, a: (c as { average?: number }).average }))
      .filter((c) => Number.isFinite(c.t) && c.p > 0 && c.t >= openMs)
      .sort((a, b) => a.t - b.t);
    if (!list.length) continue;
    let cum = 0;
    const out: Array<[number, number, number]> = [];
    for (const c of list) {
      cum += c.v * (c.a && c.a > 0 ? c.a : c.p);
      out.push([c.t, cum, c.p]);
    }
    const real = turnoverNow[code];
    // 沒有即時成交額可以校正時，假設量的單位是股
    const scale = real && cum > 0 ? real / cum : 1 / 1e8;
    for (const r of out) r[1] *= scale;
    series.set(code, out);
    last = Math.max(last, list[list.length - 1].t);
  }
  if (!series.size) return bars;
  // 第 t 分鐘的紀錄＝t 以前已經收完的 1 分 K（跟網頁每分鐘記下的「當時的累計」一致）
  const end = Math.min(Math.floor(untilMs / MIN) * MIN, last + MIN);
  const added: TurnoverBar[] = [];
  const idx = new Map<string, number>();
  for (let t = openMs + MIN; t <= end; t += MIN) {
    if (have.has(t)) continue;
    const byStock: Record<string, number> = {};
    const prices: Record<string, number> = {};
    for (const [code, s] of series) {
      let i = idx.get(code) ?? -1;
      while (i + 1 < s.length && s[i + 1][0] < t) i++;
      idx.set(code, i);
      if (i < 0) continue;
      byStock[code] = s[i][1];
      prices[code] = s[i][2];
    }
    if (Object.keys(byStock).length) added.push({ t, byStock, prices });
  }
  if (!added.length) return bars;
  return [...bars, ...added].sort((a, b) => a.t - b.t);
}
