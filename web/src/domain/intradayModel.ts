/**
 * 5 分 K 走勢預測（加權指數 → 換算 00631L）：特徵與預測，訓練程式（scripts/predict-intraday.ts）與網頁共用。
 *
 * 時間點 k＝0～53：k＝0 是開盤第一筆之後，k＝1～53 是第 k 根 5 分 K 收盤之後。
 * 價格序列 c：c[0]＝開盤價，c[k]＝第 k 根收盤（c[54]＝收盤）。
 * 預測目標：從 c[k] 到 c[k＋h] 的對數報酬，h ∈ HORIZONS（54 代表到收盤）。
 *
 * 整天的 5 分 K 預測（forecastDay）由四個部分組成：
 * - 收盤走勢：上面的各長度報酬模型（方向很難預測，誤差最小的預測線會很平滑）。
 * - 每根 K 棒的振幅：時段特性（開盤、收盤前最大）× 今天與昨天的波動，這部分預測得準。
 * - 今天剩下時間的最高、最低點：離現在多遠。
 * - 開盤前：先預測開盤跳空。
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
  /** 昨天的振幅 ln(最高 ÷ 最低)。 */
  prevRange: number;
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
  /** 殘差標準差：[horizon][時段]（見 timeBucket）。 */
  resid: number[][];
}

/** 殘差分段：剛開盤（還不知道今天的波動）單獨一段，之後每 9 根一段。 */
export const TIME_BUCKETS = 7;
export const timeBucket = (k: number) => (k <= 0 ? 0 : 1 + Math.min(5, Math.floor((k - 1) / 9)));

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
/**
 * 從第 k 根之後連續 s 根 K 棒「平常」的波動合計：√Σ 振幅²（振幅用各時段的平均）。
 * 開盤與收盤前振幅大，所以同樣長度的預測，開盤附近的區間比較寬。
 */
export function windowVol(base: number[], k: number, s: number): number {
  let v = 0;
  for (let b = k; b < Math.min(BARS, k + s); b++) v += Math.exp(2 * base[b]);
  return Math.sqrt(v);
}

/**
 * scale：區間倍率（依今天的波動大小）；extraSd：額外的不確定性（開盤前的跳空）。
 * base（各時段平均振幅）有給時，m.resid 是「除以 windowVol 之後」的殘差，區間會依時段放大縮小。
 */
export function forecastPath(m: IntradayModel, c: ArrayLike<number>, k: number, P0: number, d: DailyCtx, scale = 1, extraSd = 0, base?: number[]): ForecastPoint[] {
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
    const unit = base ? windowVol(base, k, s) : 1;
    const sd = (maxSd = Math.max(maxSd, Math.hypot((a[2] + (b[2] - a[2]) * w) * unit * scale, extraSd)));
    out.push({ bar: k + s, mid: c[k] * Math.exp(mu), lo: c[k] * Math.exp(mu - 1.28 * sd), hi: c[k] * Math.exp(mu + 1.28 * sd) });
  }
  return out;
}

/** 指數價格換算成 00631L：L＝L昨收 × exp(β × ln(指數 ÷ 指數昨收))。 */
export const toLeveraged = (ix: number, P0: number, L0: number, beta: number) => L0 * Math.exp(beta * Math.log(ix / P0));


// ================================================================ 整天的 5 分 K

/** 5 分 K：[開, 高, 低, 收]。 */
export type Bar = [number, number, number, number];

/** 一根 K 棒的振幅 ln(高 ÷ 低)（至少 0.001%，取對數時不會爆掉）。 */
export const barRange = (b: Bar) => Math.log(Math.max(b[0], b[1], b[3]) / Math.min(b[0], b[2], b[3])) + 1e-5;

/** 線性模型（標準化後的特徵）。 */
export interface LinModel {
  mean: number[];
  sd: number[];
  coef: number[];
}
export const linPredict = (m: LinModel, x: number[]) => {
  const z = standardize(m, x);
  return m.coef[0] + z.reduce((s, v, j) => s + m.coef[j + 1] * v, 0);
};

export interface DayModel {
  /** 每個時段（第 0～53 根）ln(振幅) 的平均。 */
  base: number[];
  /** 振幅比時段平均大多少（ln）。 */
  rng: LinModel;
  /** 剩下的時間最多往上、往下走多遠：ln(極值 ÷ 現價)。 */
  up: LinModel;
  down: LinModel;
  /** 開盤跳空（開盤前用）與它的誤差標準差。 */
  gap: LinModel;
  gapSd: number;
}

/** 區間倍率：今天的波動比平常大多少（用振幅模型預測下一根的振幅比時段平均大幾倍）。 */
export function volScale(dm: DayModel, ix: Bar[], k: number, c0: number, P0: number, d: DailyCtx): number {
  const j = Math.min(BARS - 1, k);
  return Math.max(0.5, Math.min(2.5, Math.exp(linPredict(dm.rng, rangeFeatures(ix, k, j, c0, P0, d, dm.base)))));
}

/** 今天前 k 根的振幅比時段平均大多少（平均的 ln）；還沒有完整的 K 棒時 NaN。 */
export function todayVol(ix: Bar[], k: number, base: number[]): number {
  if (k < 1) return NaN;
  let s = 0;
  for (let b = 0; b < k; b++) s += Math.log(barRange(ix[b])) - base[b];
  return s / k;
}

/** 預測第 j 根（0～53）振幅的特徵；現在是第 k 根收盤後（k＝0：剛開盤）。 */
export function rangeFeatures(ix: Bar[], k: number, j: number, c0: number, P0: number, d: DailyCtx, base: number[]): number[] {
  const t = j / BARS;
  return [todayVol(ix, k, base), k >= 1 ? Math.log(barRange(ix[k - 1])) - base[k - 1] : NaN, d.prevRange, Math.abs(lr(c0, P0)), Math.log(j - k + 1), t, t * t];
}

/** 預測剩下時間最高、最低點的特徵（c 是收盤序列 c[0..k]）。 */
export function excursionFeatures(ix: Bar[], c: ArrayLike<number>, k: number, P0: number, d: DailyCtx, base: number[]): number[] {
  let hi = c[0];
  let lo = c[0];
  for (let b = 0; b < k; b++) (hi = Math.max(hi, ix[b][1])), (lo = Math.min(lo, ix[b][2]));
  return [todayVol(ix, k, base), d.prevRange, Math.abs(lr(c[0], P0)), Math.log((BARS - k) / BARS), lr(c[k], c[0]), hi > lo ? (c[k] - lo) / (hi - lo) : 0.5];
}

export const gapFeatures = (d: DailyCtx) => [d.prevDay, d.prev5, d.prevIntra, d.futChg, d.prevRange];

export interface DayForecast {
  /** 從哪一根開始是預測的（0～53）。 */
  from: number;
  /** 開盤價（開盤前是預測值）。 */
  open: number;
  /** 預測的 K 棒（第 from～53 根），附收盤價約 80% 區間。 */
  bars: Array<{ bar: number; o: number; h: number; l: number; c: number; lo: number; hi: number }>;
  /** 今天預估的最高、最低（已經走過的部分用實際值）。 */
  dayHigh: number;
  dayLow: number;
}

/**
 * 整天的 5 分 K 預測。k＝-1：開盤前；k＝0：剛開盤（open 是開盤價）；k＝1～53：第 k 根收盤後。
 * ix：已經走完的 K 棒（至少前 k 根）。
 */
/** 回傳的 K 棒裡也帶著區間倍率，回測與網頁一致。 */
export function forecastDay(m: IntradayModel, dm: DayModel, ix: Bar[], k: number, open: number | null, P0: number, d: DailyCtx): DayForecast {
  const pre = k < 0;
  const kk = Math.max(0, k);
  const c0 = pre || !(open! > 0) ? P0 * Math.exp(linPredict(dm.gap, gapFeatures(d))) : open!;
  const c = [c0, ...ix.slice(0, kk).map((b) => b[3])];
  const scale = volScale(dm, ix, kk, c0, P0, d);
  const path = forecastPath(m, c, kk, P0, d, scale, pre ? dm.gapSd : 0, dm.base);
  const closes = [c[kk], ...path.map((p) => p.mid)];
  const bars: DayForecast['bars'] = [];
  for (let j = kk; j < BARS; j++) {
    const o = closes[j - kk];
    const cl = closes[j - kk + 1];
    const R = Math.exp(dm.base[j] + linPredict(dm.rng, rangeFeatures(ix, kk, j, c0, P0, d, dm.base)));
    const body = Math.abs(Math.log(cl / o));
    const extra = Math.max(0, R - body) / 2;
    const p = path[j - kk];
    bars.push({ bar: j, o, h: Math.max(o, cl) * Math.exp(extra), l: Math.min(o, cl) * Math.exp(-extra), c: cl, lo: p.lo, hi: p.hi });
  }
  const xf = excursionFeatures(ix, c, kk, P0, d, dm.base);
  const up = Math.max(0, linPredict(dm.up, xf));
  const down = Math.max(0, linPredict(dm.down, xf));
  let hi = c0;
  let lo = c0;
  for (let b = 0; b < kk; b++) (hi = Math.max(hi, ix[b][1])), (lo = Math.min(lo, ix[b][2]));
  return { from: kk, open: c0, bars, dayHigh: Math.max(hi, c[kk] * Math.exp(up)), dayLow: Math.min(lo, c[kk] * Math.exp(-down)) };
}

// ================================================================ 相似日走勢線

/**
 * 歷史上的一天（相似日比對用）：開盤跳空、整天的收盤序列（相對開盤的對數報酬）、開盤前的資料。
 * r[0]＝0（開盤），r[b]＝ln(第 b 根收盤 ÷ 開盤)，共 55 個。
 */
export interface AnalogDay {
  date: string;
  gap: number;
  r: number[];
  ctx: DailyCtx;
}

/** 今天到目前為止的狀態。k＝-1 開盤前（還不知道開盤）；k＝0 剛開盤；k≥1 第 k 根收盤後。 */
export interface TodayState {
  k: number;
  /** 開盤跳空（開盤前是 NaN）。 */
  gap: number;
  /** r[0..k]：相對開盤的對數報酬。 */
  r: number[];
  ctx: DailyCtx;
}

/** 波動的尺度：用前一天的振幅（不同年代、不同指數水準的走勢才比得起來）。 */
const sigmaOf = (d: DailyCtx) => Math.max(0.004, Number.isFinite(d.prevRange) ? d.prevRange : 0.012);

/** 兩天有多不像（越小越像）：開盤前的資料、跳空、到目前為止的走勢形狀（最近 6 根加重），都先除以各自的波動尺度。 */
export function analogDistance(t: TodayState, a: AnalogDay): number {
  const st = sigmaOf(t.ctx);
  const sa = sigmaOf(a.ctx);
  const sq = (x: number, y: number) => (Number.isFinite(x) && Number.isFinite(y) ? (x - y) ** 2 : 0);
  let dist = 0.5 * sq(t.ctx.prevDay / st, a.ctx.prevDay / sa) + 0.5 * sq(t.ctx.prevIntra / st, a.ctx.prevIntra / sa) + 0.25 * sq(t.ctx.prev5 / st, a.ctx.prev5 / sa) + Math.log(st / sa) ** 2;
  if (t.k >= 0) dist += 2 * sq(t.gap / st, a.gap / sa);
  if (t.k >= 1) {
    let p = 0;
    let w = 0;
    for (let b = 1; b <= t.k; b++) {
      const wb = b > t.k - 6 ? 3 : 1;
      p += wb * sq(t.r[b] / st, a.r[b] / sa);
      w += wb;
    }
    // 走勢形狀佔的比重隨時間變大
    dist += (p / w) * (4 + t.k / 6);
  }
  return dist;
}

export interface AnalogLine {
  date: string;
  /** 從預測起點之後的收盤價：第 from＋1～54 根（開盤前從開盤 0 開始）。 */
  closes: number[];
}

/**
 * 找最像的 n 天，把它們「接下來的走勢」依波動比例縮放，接在現在的價格後面。
 * now：現在的價格（開盤前用昨收 P0）；回傳的 closes 對應 c[from..54]（開盤前 from＝0，含開盤價）。
 */
export function analogLines(lib: AnalogDay[], t: TodayState, now: number, n = 5, maxLines = n): { from: number; lines: AnalogLine[]; avg: number[] } {
  const ranked = lib
    .map((a) => ({ a, d: analogDistance(t, a) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, Math.max(n, maxLines));
  const st = sigmaOf(t.ctx);
  const pre = t.k < 0;
  const from = pre ? 0 : t.k + 1;
  const lines = ranked.map(({ a }) => {
    const s = st / sigmaOf(a.ctx);
    const closes: number[] = [];
    for (let j = from; j <= BARS; j++) closes.push(pre ? now * Math.exp((a.gap + a.r[j]) * s) : now * Math.exp((a.r[j] - a.r[t.k]) * s));
    return { date: a.date, closes };
  });
  return { from, lines, avg: avgOf(lines, n) };
}

/** 前 n 條相似日走勢的平均（對數平均）。 */
export function avgOf(lines: AnalogLine[], n: number): number[] {
  const use = lines.slice(0, n);
  return use.length ? use[0].closes.map((_, i) => Math.exp(mean(use.map((l) => Math.log(l.closes[i]))))) : [];
}

/** 綜合預測：模型主線與相似日平均依權重 w（給模型）混合（對數空間）。 */
export const blendLine = (model: number[], avg: number[], w: number) => model.map((v, i) => (avg[i] > 0 ? Math.exp(w * Math.log(v) + (1 - w) * Math.log(avg[i])) : v));

/** 每個預測時間點自動挑的設定：相似日平均要用幾天、綜合預測給模型多少權重。 */
export interface BlendChoice {
  origin: number;
  n: number;
  w: number;
}
export const ANALOG_NS = [5, 10, 20] as const;
export const BLEND_WS = [0, 0.25, 0.5, 0.75, 1] as const;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

/** predict-analogs.json：[日期, 跳空, 走勢, 開盤前資料]，數值 ×1e4 取整。 */
export function decodeAnalogs(raw: Array<[string, number | null, Array<number | null>, Array<number | null>]>): AnalogDay[] {
  const f = (v: number | null) => (v == null ? NaN : v / 1e4);
  return raw.map(([date, gap, r, c]) => ({ date, gap: f(gap), r: r.map(f), ctx: { prevDay: f(c[0]), prev5: f(c[1]), prevIntra: f(c[2]), futChg: f(c[3]), prevRange: f(c[4]) } }));
}
