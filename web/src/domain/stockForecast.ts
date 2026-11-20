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

/**
 * 相似走勢預測線（只用這檔股票自己的歷史）：找出「最近 L 天的走勢形狀」跟現在最像的過去時段（漲跌都先除以當時的波動），
 * 把它們之後 H 天的真實走勢依波動比例縮放、接在現在的價格後面；平均起來當主要預測線。
 * 只用「結果在 end 之前就已經揭曉」的時段（時段結束日 + H ≤ end），所以拿來回測也不會看到答案。
 */
export interface AnalogResult {
  /** 每條相似走勢：起點位置（時段結束日）與之後 H 天的累計對數報酬（已依波動縮放）。 */
  lines: Array<{ at: number; path: number[] }>;
  /** 平均（累計對數報酬，t＝1..H）。 */
  avg: number[];
}
function volAt(lr: number[], e: number, n = 60): number {
  let s = 0;
  let s2 = 0;
  let c = 0;
  for (let k = Math.max(1, e - n + 1); k <= e; k++) if (Number.isFinite(lr[k])) (s += lr[k]), (s2 += lr[k] * lr[k]), c++;
  return c >= 40 ? Math.sqrt(Math.max(1e-12, s2 / c - (s / c) ** 2)) : NaN;
}
export function analogForecast(closes: number[], end = closes.length - 1, L = 20, H = 21, n = 5): AnalogResult | null {
  const lr = closes.map((c, k) => (k > 0 && c > 0 && closes[k - 1] > 0 ? Math.log(c / closes[k - 1]) : NaN));
  const vNow = volAt(lr, end);
  if (!(vNow > 0) || end < L + 80) return null;
  const pat = (e: number, v: number) => Array.from({ length: L }, (_, k) => (lr[e - L + 1 + k] || 0) / v);
  const now = pat(end, vNow);
  const cands: Array<[number, number, number]> = []; // [距離, 結束位置, 當時波動]
  for (let e = L + 60; e + H <= end; e++) {
    const v = volAt(lr, e);
    if (!(v > 0)) continue;
    const p = pat(e, v);
    let d = 0;
    // 越近的那幾天越重要
    for (let k = 0; k < L; k++) d += (k >= L - 5 ? 2 : 1) * (p[k] - now[k]) ** 2;
    cands.push([d, e, v]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  const picked: Array<[number, number, number]> = [];
  for (const c of cands) {
    if (picked.length >= n) break;
    // 不要挑到幾乎同一段（相隔至少 10 天）
    if (picked.every((p) => Math.abs(p[1] - c[1]) >= 10)) picked.push(c);
  }
  if (!picked.length) return null;
  const lines = picked.map(([, e, v]) => {
    const path: number[] = [];
    let acc = 0;
    for (let t = 1; t <= H; t++) {
      acc += ((lr[e + t] || 0) / v) * vNow;
      path.push(acc);
    }
    return { at: e, path };
  });
  const avg = Array.from({ length: H }, (_, t) => lines.reduce((s, l) => s + l.path[t], 0) / lines.length);
  return { lines, avg };
}

/** 這檔股票過去用相似走勢預測一個月後的成績（每 5 天一次、只用當時以前的資料）：方向命中率、誤差 vs「不會動」。 */
export function analogBacktest(closes: number[], H = 21, tests = 120): { n: number; hit: number; rmse: number; rmseFlat: number } | null {
  let n = 0;
  let hit = 0;
  let se = 0;
  let seFlat = 0;
  for (let e = closes.length - 1 - H; e > closes.length - 1 - H - tests * 5 && e > 200; e -= 5) {
    const f = analogForecast(closes, e, 20, H);
    if (!f) continue;
    const act = Math.log(closes[e + H] / closes[e]);
    const pred = f.avg[H - 1];
    if (!Number.isFinite(act)) continue;
    n++;
    if (Math.sign(pred) === Math.sign(act)) hit++;
    se += (pred - act) ** 2;
    seFlat += act * act;
  }
  return n >= 20 ? { n, hit: hit / n, rmse: Math.sqrt(se / n), rmseFlat: Math.sqrt(seFlat / n) } : null;
}
