/**
 * 個股日 K 預測（未來約一個月）：只用回測校準過的兩件事，不假裝知道方向。
 * - 中線：這檔股票目前「營收選股」分數所在的那一組（10 組），歷史上之後一個月的平均報酬。
 * - 區間：近 60 日波動 ×√天數 × 歷史上實際報酬落點的 10%／90% 分位數（回測各年約 80% 落在區間內）。
 */
export interface StockCalib {
  deciles: Array<{ decile: number; n: number; avg: number | null; excess: number | null; beat: number | null }>;
  zq: { p10: number | null; p50: number | null; p90: number | null };
  coverage: Array<{ year: string; n: number; inside: number | null }>;
  horizon: number;
}
export interface ForecastPoint {
  t: number;
  mid: number;
  lo: number;
  hi: number;
}

/** 近 n 日的日報酬標準差（對數）；資料不夠時 NaN。 */
export function dailyVol(closes: number[], n = 60): number {
  const r: number[] = [];
  for (let i = Math.max(1, closes.length - n); i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < Math.min(40, n)) return NaN;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

/** score：0～100（null＝不在可選範圍，用全部股票的平均）。 */
export function dailyForecast(closes: number[], score: number | null, calib: StockCalib, days = calib.horizon): { sigma: number; avg: number; decile: number | null; path: ForecastPoint[] } {
  const c = closes[closes.length - 1];
  const sigma = dailyVol(closes);
  const ok = calib.deciles.filter((d) => d.avg != null && d.n > 0);
  const decile = score == null ? null : Math.min(9, Math.floor(score / 10));
  const avg = decile == null ? ok.reduce((s, d) => s + d.avg! * d.n, 0) / (ok.reduce((s, d) => s + d.n, 0) || 1) : (calib.deciles[decile]?.avg ?? 0);
  const mu = Math.log(1 + avg) / calib.horizon;
  const lo = calib.zq.p10 ?? -1.28;
  const hi = calib.zq.p90 ?? 1.28;
  const path: ForecastPoint[] = [];
  if (c > 0 && sigma > 0)
    for (let t = 1; t <= days; t++) path.push({ t, mid: c * Math.exp(mu * t), lo: c * Math.exp(mu * t + lo * sigma * Math.sqrt(t)), hi: c * Math.exp(mu * t + hi * sigma * Math.sqrt(t)) });
  return { sigma, avg, decile, path };
}
