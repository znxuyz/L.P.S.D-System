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

/**
 * 方向預測線（主線，一定押方向）：方向＝相似走勢平均最後是漲還是跌；
 * 形狀與幅度＝相似時段裡「最後也往同一方向走」的那幾段真實走勢平均（已依波動縮放），不會被平均成一條平線。
 * 同方向的不到 2 段時，用全部的平均；方向相反就上下鏡射。回傳累計對數報酬（t＝1..H）。
 */
export function directionPath(an: AnalogResult, n = 5, endSize?: number): number[] {
  const up = (an.avg[an.avg.length - 1] ?? 0) >= 0;
  const same = an.lines.filter((l) => (l.path[l.path.length - 1] ?? 0) >= 0 === up).slice(0, n);
  const raw =
    same.length >= 2
      ? same[0].path.map((_, t) => same.reduce((s, l) => s + l.path[t], 0) / same.length)
      : (an.avg[an.avg.length - 1] ?? 0) >= 0 === up
        ? an.avg
        : an.avg.map((v) => -v);
  // 終點幅度固定成 endSize（例如「這種波動下這段時間一般會走多少」）：相似走勢放大後可能很誇張，只取它的形狀
  const end = Math.abs(raw[raw.length - 1] ?? 0);
  if (endSize == null || !(end > 1e-9)) return raw;
  return raw.map((v) => (v / end) * endSize);
}

/** 這段時間一般會走多少（對數報酬的中位數絕對值）：常態分布下 |z| 的中位數 0.6745 × 波動 × √天數。 */
export const typicalMove = (sigma: number, days: number) => 0.6745 * sigma * Math.sqrt(days);

/** 這檔股票過去用相似走勢預測一個月後的成績（每 5 天一次、只用當時以前的資料）：方向命中率、誤差 vs「不會動」。 */
export function analogBacktest(closes: number[], H = 21, tests = 120): { n: number; hit: number; rmse: number; rmseFlat: number; upRate: number } | null {
  let n = 0;
  let hit = 0;
  let se = 0;
  let seFlat = 0;
  let ups = 0;
  for (let e = closes.length - 1 - H; e > closes.length - 1 - H - tests * 5 && e > 200; e -= 5) {
    const f = analogForecast(closes, e, 20, H);
    if (!f) continue;
    const act = Math.log(closes[e + H] / closes[e]);
    const pred = f.avg[H - 1];
    if (!Number.isFinite(act)) continue;
    n++;
    if (act > 0) ups++;
    if (Math.sign(pred) === Math.sign(act)) hit++;
    se += (pred - act) ** 2;
    seFlat += act * act;
  }
  return n >= 20 ? { n, hit: hit / n, rmse: Math.sqrt(se / n), rmseFlat: Math.sqrt(seFlat / n), upRate: ups / n } : null;
}

/**
 * 這一檔（或指數）自己的歷史校準：過去每一天「之後 H 天的漲跌 ÷（當時近 60 日波動 × √H）」的 10%／90% 分位數，
 * 以及各年實際落在區間內的比例。用整段歷史估分位數（區間寬度的校準，不是方向）。
 */
export function bandCalib(closes: number[], dates: string[] = [], H = 21): { p10: number; p90: number; coverage: Array<{ year: string; inside: number }> } | null {
  const lr = closes.map((c, k) => (k > 0 && c > 0 && closes[k - 1] > 0 ? Math.log(c / closes[k - 1]) : NaN));
  const zs: Array<[number, number]> = [];
  for (let e = 80; e + H < closes.length; e += 2) {
    const v = volAt(lr, e);
    if (!(v > 0)) continue;
    zs.push([e, Math.log(closes[e + H] / closes[e]) / (v * Math.sqrt(H))]);
  }
  if (zs.length < 50) return null;
  const s = zs.map((z) => z[1]).sort((a, b) => a - b);
  const p10 = s[Math.floor(0.1 * (s.length - 1))];
  const p90 = s[Math.floor(0.9 * (s.length - 1))];
  const years = new Map<string, [number, number]>();
  for (const [e, z] of zs) {
    const y = dates[e]?.slice(0, 4);
    if (!y) continue;
    const c = years.get(y) ?? [0, 0];
    c[0]++;
    if (z >= p10 && z <= p90) c[1]++;
    years.set(y, c);
  }
  return { p10, p90, coverage: [...years].map(([year, [n, k]]) => ({ year, inside: k / n })) };
}
