/**
 * 5 分 K 走勢預測（加權指數 → 換算 00631L）：特徵與預測，訓練程式（scripts/predict-intraday.ts）與網頁共用。
 *
 * 時間點 k＝0～53：k＝0 是開盤第一筆之後，k＝1～53 是第 k 根 5 分 K 收盤之後。
 * 價格序列 c：c[0]＝開盤價，c[k]＝第 k 根收盤（c[54]＝收盤）。
 * 預測目標：從 c[k] 到 c[k＋h] 的對數報酬，h ∈ HORIZONS（54 代表到收盤）。
 */

export const BARS = 54;
export const HORIZONS = [1, 2, 3, 6, 12, 54] as const;

/** 每天開盤前就知道的資料（前一天收盤後）。 */
export interface DailyCtx {
  /** 昨天漲跌（對數）。 */
  prevDay: number;
  /** 近 5 日漲跌（對數）。 */
  prev5: number;
  /** 昨天開盤到收盤（對數）。 */
  prevIntra: number;
  /** 外資台指期淨未平倉昨天的增減（萬口）；沒有資料是 NaN。 */
  futChg: number;
}

export const FEATURE_NAMES = [
  '時間（越接近收盤越大）',
  '時間平方',
  '開盤跳空',
  '開盤到現在',
  '最近 1 根',
  '最近 3 根',
  '最近 6 根',
  '今天的波動',
  '在今天高低區間的位置',
  '昨天漲跌',
  '近 5 日漲跌',
  '昨天開盤到收盤',
  '外資期貨昨天增減',
] as const;

const lr = (a: number, b: number) => (a > 0 && b > 0 ? Math.log(a / b) : 0);

/** 時間點 k 的特徵；c 至少要有 c[0..k]，P0 是昨收。 */
export function features(c: ArrayLike<number>, k: number, P0: number, d: DailyCtx): number[] {
  const t = k / BARS;
  let rv = 0;
  for (let i = 1; i <= k; i++) rv += lr(c[i], c[i - 1]) ** 2;
  rv = k >= 1 ? Math.sqrt(rv / k) : NaN;
  let hi = c[0];
  let lo = c[0];
  for (let i = 1; i <= k; i++) {
    if (c[i] > hi) hi = c[i];
    if (c[i] < lo) lo = c[i];
  }
  return [
    t,
    t * t,
    lr(c[0], P0),
    lr(c[k], c[0]),
    k >= 1 ? lr(c[k], c[k - 1]) : NaN,
    k >= 3 ? lr(c[k], c[k - 3]) : NaN,
    k >= 6 ? lr(c[k], c[k - 6]) : NaN,
    rv,
    hi > lo ? (c[k] - lo) / (hi - lo) : 0.5,
    d.prevDay,
    d.prev5,
    d.prevIntra,
    d.futChg,
  ];
}

export interface IntradayModel {
  mean: number[];
  sd: number[];
  /** 每個 horizon 一組 [截距, ...係數]（標準化後的特徵）。 */
  coef: number[][];
  /** 殘差標準差：[horizon][時段]，時段把 0～53 分成 6 段。 */
  resid: number[][];
}

export const timeBucket = (k: number) => Math.min(5, Math.floor(k / 9));

/**
 * 「到收盤」剩下的時間長短不一：越接近收盤能走的幅度越小。
 * 訓練時把目標除以 √(剩下的比例)，預測時再乘回來，各時間點的誤差才在同一個尺度。
 */
export const horizonScale = (h: number, k: number) => (h === 54 ? Math.sqrt(Math.max(1, BARS - k) / BARS) : 1);

export function standardize(m: Pick<IntradayModel, 'mean' | 'sd'>, x: number[]): number[] {
  return x.map((v, j) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - m.mean[j]) / (m.sd[j] || 1))) : 0));
}

/** 時間點 k 對各個 horizon 的預測（對數報酬）。 */
export function predictAt(m: IntradayModel, c: ArrayLike<number>, k: number, P0: number, d: DailyCtx): number[] {
  const z = standardize(m, features(c, k, P0, d));
  return m.coef.map((b, i) => (b[0] + z.reduce((s, v, j) => s + b[j + 1] * v, 0)) * horizonScale(HORIZONS[i], k));
}

export interface ForecastPoint {
  /** 第幾根收盤（k＋1～54）。 */
  bar: number;
  /** 預測的指數價格。 */
  mid: number;
  /** 約 80% 區間（±1.28 個標準差）。 */
  lo: number;
  hi: number;
}

/** 從時間點 k 一路預測到收盤：各 horizon 的點之間用對數線性內插。 */
export function forecastPath(m: IntradayModel, c: ArrayLike<number>, k: number, P0: number, d: DailyCtx): ForecastPoint[] {
  const p = predictAt(m, c, k, P0, d);
  const tb = timeBucket(k);
  // 錨點：(距離, 預測報酬, 標準差)，距離超過收盤的不要
  const anchors: Array<[number, number, number]> = [[0, 0, 0]];
  HORIZONS.forEach((h, i) => {
    const dist = h === 54 ? BARS - k : h;
    if (k + dist > BARS || dist <= 0) return;
    if (anchors.some((a) => a[0] === dist)) return;
    anchors.push([dist, p[i], m.resid[i][tb]]);
  });
  anchors.sort((a, b) => a[0] - b[0]);
  const out: ForecastPoint[] = [];
  // 區間只會隨時間變寬（各長度的誤差是分開估的，偶爾遠的比近的小）
  let maxSd = 0;
  for (let s = 1; s <= BARS - k; s++) {
    let j = 0;
    while (j + 1 < anchors.length && anchors[j + 1][0] < s) j++;
    const a = anchors[j];
    const b = anchors[Math.min(j + 1, anchors.length - 1)];
    const w = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0]);
    const mu = a[1] + (b[1] - a[1]) * w;
    const sd = (maxSd = Math.max(maxSd, a[2] + (b[2] - a[2]) * w));
    out.push({ bar: k + s, mid: c[k] * Math.exp(mu), lo: c[k] * Math.exp(mu - 1.28 * sd), hi: c[k] * Math.exp(mu + 1.28 * sd) });
  }
  return out;
}

/** 指數價格換算成 00631L：L＝L昨收 × exp(β × ln(指數 ÷ 指數昨收))。 */
export const toLeveraged = (ix: number, P0: number, L0: number, beta: number) => L0 * Math.exp(beta * Math.log(ix / P0));
