/**
 * 偽即時行情：只有某天的開、高、低、收，用它們產生一條 09:00～13:30 每分鐘的價格路徑。
 *
 * - 09:00 是開盤價、13:30 是收盤價，路徑在某個時間點碰到最高價、某個時間點碰到最低價，其他時間都在高低之間。
 * - 收紅的日子比較常「先探低再走高」、收黑的比較常「先衝高再回落」。
 * - 價格照台股升降單位跳動；成交量依台股常見的「開盤、收盤量大，中午量小」分配到每分鐘。
 * - 用「代號＋日期」當亂數種子：同一檔同一天每次產生的路徑都一樣（換裝置、重新整理都不會變）。
 * 這只是讓模擬盤有盤中跳動的感覺，不是真實的盤中走勢；開高低收四個價格是真的。
 */

/** 一天有幾分鐘（09:00～13:30）。 */
export const SESSION_MINUTES = 270;

export interface DayBar {
  open: number;
  high: number;
  low: number;
  close: number;
  /** 當天成交量（張）。 */
  volume: number;
}

export interface IntradayPath {
  /** 第 0～270 分鐘的成交價。 */
  price: Float64Array;
  /** 到第 m 分鐘為止的累計成交量（張）。 */
  cumVolume: Float64Array;
}

/** 台股升降單位（股票）；ETF 50 元以下 0.01、以上 0.05。 */
export function tickSize(price: number, etf = false): number {
  if (etf) return price < 50 ? 0.01 : 0.05;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

export function roundTick(price: number, etf = false): number {
  const t = tickSize(price, etf);
  return Math.round(Math.round(price / t) * t * 100) / 100;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** mulberry32：小而快的可重現亂數。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export function intradayPath(code: string, date: string, bar: DayBar): IntradayPath {
  const N = SESSION_MINUTES;
  const price = new Float64Array(N + 1);
  const cumVolume = new Float64Array(N + 1);
  const etf = code.startsWith('00');
  const r = rng(hash(`${code}|${date}`));
  const { open: O, high: H, low: L, close: C } = bar;

  if (H - L < 1e-9) {
    price.fill(O);
  } else {
    // 最高、最低出現的時間（開盤或收盤剛好是最高／最低時就固定在那一端）
    const pickT = () => 8 + Math.floor(r() * (N - 16));
    let tH = O >= H ? 0 : C >= H ? N : pickT();
    let tL = O <= L ? 0 : C <= L ? N : pickT();
    if (tH === tL) tL = Math.min(N - 1, Math.max(1, tH + (tH < N / 2 ? 20 : -20)));
    // 收紅多半先探低、收黑多半先衝高
    if (tH > 0 && tH < N && tL > 0 && tL < N) {
      const lowFirst = r() < (C >= O ? 0.65 : 0.35);
      if (lowFirst !== tL < tH) [tH, tL] = [tL, tH];
    }
    const anchors = [
      [0, O],
      [tH, H],
      [tL, L],
      [N, C],
    ].sort((a, b) => a[0] - b[0]);
    // 錨點之間用布朗橋連起來，再壓在高低之間
    const span = H - L;
    for (let k = 0; k < anchors.length - 1; k++) {
      const [t0, p0] = anchors[k];
      const [t1, p1] = anchors[k + 1];
      if (t1 === t0) {
        price[t0] = p1;
        continue;
      }
      let w = 0;
      const steps = t1 - t0;
      const sigma = span * 0.07;
      const walk: number[] = [0];
      for (let i = 1; i <= steps; i++) {
        w += gauss(r) * sigma;
        walk.push(w);
      }
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const bridge = walk[i] - f * walk[steps];
        price[t0 + i] = p0 + (p1 - p0) * f + bridge;
      }
    }
    // 只有錨點可以碰到最高、最低；其他點壓在稍微內側
    const inner = (H - L) * 0.002;
    for (let t = 0; t <= N; t++) {
      const isAnchor = t === tH || t === tL || t === 0 || t === N;
      if (!isAnchor) price[t] = Math.min(H - inner, Math.max(L + inner, price[t]));
    }
    price[0] = O;
    price[N] = C;
    if (tH > 0 && tH < N) price[tH] = H;
    if (tL > 0 && tL < N) price[tL] = L;
    for (let t = 0; t <= N; t++) price[t] = Math.min(H, Math.max(L, roundTick(price[t], etf)));
    price[0] = O;
    price[N] = C;
    if (tH > 0 && tH < N) price[tH] = H;
    if (tL > 0 && tL < N) price[tL] = L;
  }

  // 成交量：開盤、收盤附近量大，中午量小，再加一點隨機
  let total = 0;
  const w = new Float64Array(N + 1);
  for (let t = 0; t <= N; t++) {
    w[t] = (1 + 3 * Math.exp(-t / 12) + 1.6 * Math.exp(-(N - t) / 10)) * (0.6 + r() * 0.8);
    total += w[t];
  }
  let acc = 0;
  for (let t = 0; t <= N; t++) {
    acc += w[t];
    cumVolume[t] = (bar.volume * acc) / total;
  }
  return { price, cumVolume };
}

/** 第 m 分鐘的時間字串（0 → 09:00，270 → 13:30）。 */
export function clock(minute: number): string {
  const m = Math.max(0, Math.min(SESSION_MINUTES, Math.floor(minute)));
  const h = 9 + Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
