/**
 * 證交所「每 5 秒指數統計」（MI_5MINS_INDEX）→ 加權指數 5 分 K。
 *
 * - 09:00:00 那一筆是開盤前的值（等於昨收），09:00:05 起才是盤中；13:30:00 是收盤。
 * - 5 分 K 共 54 根：第 b 根涵蓋 09:00＋5b 分（不含）到 09:05＋5b 分（含），開盤價是那段時間的第一筆。
 */

export const BARS = 54;
export const INTRADAY_VERSION = 1;

export interface IntradayDay {
  v: number;
  /** 09:00:00 的值（開盤前，通常等於昨收）。 */
  pre: number;
  /** 54 根 [開, 高, 低, 收]。 */
  ix: Array<[number, number, number, number]>;
}

const numOf = (s: unknown) => {
  const v = Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 解析 MI_5MINS_INDEX 的 JSON；沒有資料（假日）時 null。 */
export function parseMi5Index(j: unknown): IntradayDay | null {
  const o = j as { stat?: string; fields?: string[]; data?: unknown[][]; tables?: Array<{ fields?: string[]; data?: unknown[][] }> };
  const t = o?.fields && o?.data ? { fields: o.fields, data: o.data } : o?.tables?.find((x) => x.fields?.some((f) => f.includes('加權')) && x.data?.length);
  if (!t?.fields || !t.data?.length) return null;
  const ti = t.fields.findIndex((f) => f.includes('時間'));
  const xi = t.fields.findIndex((f) => f.includes('發行量加權股價指數'));
  if (ti < 0 || xi < 0) return null;
  let pre = NaN;
  const bars: Array<[number, number, number, number] | null> = new Array(BARS).fill(null);
  for (const row of t.data) {
    const [h, m, s] = String(row[ti]).split(':').map(Number);
    const v = numOf(row[xi]);
    if (!Number.isFinite(v) || !Number.isFinite(h)) continue;
    const sec = (h - 9) * 3600 + m * 60 + (s || 0);
    if (sec <= 0) {
      if (sec === 0) pre = v;
      continue;
    }
    if (sec > 270 * 60) continue;
    const b = Math.min(BARS - 1, Math.floor((sec - 1) / 300));
    const cur = bars[b];
    if (!cur) bars[b] = [v, v, v, v];
    else {
      cur[1] = Math.max(cur[1], v);
      cur[2] = Math.min(cur[2], v);
      cur[3] = v;
    }
  }
  // 缺的 K 棒（極少見）用前一根收盤補
  let last = pre;
  for (let b = 0; b < BARS; b++) {
    if (!bars[b]) {
      if (!Number.isFinite(last)) return null;
      bars[b] = [last, last, last, last];
    }
    last = bars[b]![3];
  }
  if (!Number.isFinite(pre)) pre = bars[0]![0];
  return { v: INTRADAY_VERSION, pre: r2(pre), ix: bars.map((x) => x!.map(r2) as [number, number, number, number]) };
}
