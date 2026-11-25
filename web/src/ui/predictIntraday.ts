/**
 * 預測頁的「00631L 整天 5 分 K 預測」：
 * - 以 5 分鐘為單位，把整天（09:00～13:30，54 根）的 K 棒預測出來：已經走完的畫實心、預測的畫空心，
 *   收盤價約 80% 區間畫陰影，預估的今日最高、最低畫虛線。
 * - 預測時間可以選開盤前、開盤或盤中任何一根之後；每走完一根就用最新走勢重新預測剩下的。
 * - 有即時行情（富果／證交所）時預測今天；否則回放最近 10 天，可以疊上實際走勢比對誤差。
 * - 00631L 的價格由加權指數換算（β 倍），不是 00631L 真實的 5 分 K。
 */
import type { IndexPoint } from '../data/types';
import { BARS, STEP, DAYTRADE_COST, analogLines, avgOf, barRange, blendLine, directionLine, typicalCloseMove, knockout, type KnockoutLine, rangeLevels, simulateRange, type RangeLevels, type RangePlan, forecastDay, toLeveraged, type AnalogDay, type Bar, type DailyCtx, type DayForecast, type DayModel, type IntradayModel, discName } from '../domain/intradayModel';
import { escapeHtml as esc, num } from './format';

type Verdict = 'signal' | 'none';
type RangePlanOut = RangePlan & { m: number | null; noTrade: boolean };
type RangeStat = { from: string; to: string; days: number; trades: number; win: number; avg: number; total: number; maxDD: number; target: number; stop: number; hold: number };
export type LineId = 'dir' | 'blend' | 'model' | 'avg' | 'a1' | 'a2' | 'a3';
const LINE_NAME: Record<LineId, string> = { dir: '方向預測（主線）', blend: '綜合預測', model: '模型主線', avg: '相似日平均', a1: '相似日 1', a2: '相似日 2', a3: '相似日 3' };
const LINE_IDS: LineId[] = ['dir', 'blend', 'model', 'avg', 'a1', 'a2', 'a3'];

export interface IntradayData {
  generatedAt: string;
  ready: boolean;
  days?: number;
  beta: number;
  model: IntradayModel;
  day: DayModel;
  verdict: Verdict;
  rangeVerdict: Verdict;
  backtest: {
    from: string;
    to: string;
    days: number;
    byOrigin: Array<{ origin: number; label: string; pathRmse: number; pathNaive: number; coverage: number; rangeMae: number; rangeNaive: number; rangeR2: number; hlMae: number; hlNaive: number }>;
  };
  /** 各種預測線的樣本外成績：每根收盤誤差（RMSE）、收盤方向命中率、最接近實際的比例。 */
  lines?: Array<{ origin: number; label: string } & Record<LineId, { rmse: number; hit: number; best: number }>>;
  /** 最近的預測紀錄（開盤前與 10:00）：預測收盤 vs 實際。 */
  record?: Array<{ date: string; origin: number; ref: number; blend?: number; model: number; avg: number; actual: number }>;
  /** 各預測時間點自動挑的設定：相似日平均用幾天（n）、綜合預測給模型的權重（w）。 */
  choice?: Array<{ origin: number; n: number; w: number }>;
  /** 回放用的模型：回放那幾天開始之前的模型與設定（回放時不會看到答案）。 */
  replay?: { m: IntradayModel; dm: DayModel; choice: Array<{ origin: number; n: number; w: number }> } | null;
  /** 分期間的成績：hold＝調整模型時從沒看過的期間；dev＝開發期間（看過，可能偏樂觀）。 */
  periods?: Record<'hold' | 'dev', { from: string; to: string; days: number; byOrigin: IntradayData['backtest']['byOrigin']; lines: NonNullable<IntradayData['lines']> } | null>;
  devStart?: string;
  /** 最終模型自己選用的資料（每個預測長度、開盤跳空）。 */
  used?: Record<string, string[]>;
  /** 00631L 當天進出場（區間來回）。 */
  rangeTrade?: {
    plan: RangePlanOut;
    refPlan: RangePlanOut;
    replayPlan: RangePlanOut;
    replayRef: RangePlanOut;
    cost: number;
    all: RangeStat | null;
    hold: RangeStat | null;
    dev: RangeStat | null;
    curve: Array<[string, number, number]>;
    recent: Array<{ date: string; side: number; how: string; pnl: number; hold: number }>;
  };
  /** 事前存檔的實盤成績。 */
  forward?: {
    days: number;
    hit: Record<'blend' | 'model' | 'avg', number>;
    rmse: Record<'blend' | 'model' | 'avg' | 'flat', number>;
    rows: Array<{ asOf: string; date: string; P0: number; actual: number; blend: number; model: number; avg: number; rmse: Record<string, number>; hiErr: number; loErr: number }>;
  };
  next: { after: string; P0: number; L0: number | null; T0?: number | null; ctx: Record<keyof DailyCtx, number | null> };
  recent: Array<{ date: string; P0: number; L0: number | null; Lday?: [number, number, number, number] | null; T0?: number | null; ix: Bar[]; ctx: Record<keyof DailyCtx, number | null> }>;
}

const ctxOf = (c: Record<keyof DailyCtx, number | null>): DailyCtx => ({
  prevDay: c.prevDay ?? NaN,
  prev5: c.prev5 ?? NaN,
  prevIntra: c.prevIntra ?? NaN,
  futChg: c.futChg ?? NaN,
  prevRange: c.prevRange ?? NaN,
  usSox: c.usSox ?? NaN,
  usTsm: c.usTsm ?? NaN,
  usSpx: c.usSpx ?? NaN,
  night: c.night ?? NaN,
  usVix: c.usVix ?? NaN,
  nightRange: c.nightRange ?? NaN,
  nightPos: c.nightPos ?? NaN,
});
/** 第 bar 根的開始時間。 */
const clock = (bar: number) => {
  const m = 9 * 60 + bar * STEP;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const kLabel = (k: number) => (k < 0 ? '開盤前' : k === 0 ? '09:00 開盤' : `${clock(k)}`);
const pctTxt = (v: number, d = 2) => `${v > 0 ? '+' : ''}${num(v * 100, d)}%`;
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** 加權指數 → 顯示的標的價位：00631L（β 倍）、台指期（前一天收盤時的期現貨比例）、加權指數本身。 */
/**
 * 漲跌停：00631L 是 2 倍槓桿 ETF，漲跌幅 ±20%（10% × 2 倍）；台指期 ±10%；加權指數沒有。
 * 換算後的價位一律夾在漲跌停之間（大盤還能漲，00631L 漲停了也不會再高）。
 */
export function limitBand(prev: number, pct: number, tick: number): [number, number] {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return [r(Math.ceil((prev * (1 - pct)) / tick - 1e-9) * tick), r(Math.floor((prev * (1 + pct)) / tick + 1e-9) * tick)];
}
const etfTick = (p: number) => (p < 50 ? 0.01 : 0.05);
const convOf = (v: View, d: IntradayData) => {
  if (v.L0) {
    const [lo, hi] = limitBand(v.L0, 0.2, etfTick(v.L0));
    // 即時：用 00631L 實際成交價對齊「現在」那一點（整條線乘同一個比例），預測從真實價格出發
    const last = v.ix.length ? v.ix[v.ix.length - 1][3] : null;
    const raw = last ? toLeveraged(last, v.P0, v.L0, d.beta) : 0;
    let k = v.live && v.Lnow && raw > 0 ? v.Lnow / raw : 1;
    // 回放：開盤、收盤兩個實價的比例取幾何平均（整天同一個比例；開盤與收盤都很接近實價）
    if (!v.live && v.Lday && v.ix.length) {
      const ro = toLeveraged(v.ix[0][0], v.P0, v.L0, d.beta);
      const rc = toLeveraged(v.ix[v.ix.length - 1][3], v.P0, v.L0, d.beta);
      if (ro > 0 && rc > 0 && v.Lday[0] > 0 && v.Lday[3] > 0) k = Math.sqrt((v.Lday[0] / ro) * (v.Lday[3] / rc));
    }
    // 昨收一定是 00631L 真正的昨收（不乘比例）
    return (x: number) => (x === v.P0 ? v.L0! : Math.min(hi, Math.max(lo, k * toLeveraged(x, v.P0, v.L0!, d.beta))));
  }
  if (v.T0) {
    const [lo, hi] = limitBand(v.T0, 0.1, 1);
    return (x: number) => Math.min(hi, Math.max(lo, (x * v.T0!) / v.P0));
  }
  return (x: number) => x;
};
export type IntraAsset = 'L' | 'ix' | 'tx';
export const ASSET_NAME: Record<IntraAsset, string> = { L: '00631L', ix: '加權指數', tx: '台指期（日盤）' };

/** 即時的加權指數（每分鐘或更密）→ 今天已經走完的 5 分 K 與開盤價。 */
export function liveBars(series: IndexPoint[], openMs: number): { open: number | null; bars: Bar[] } {
  const ms = STEP * 60_000;
  const pts = series.filter((p) => p.t >= openMs && p.t <= openMs + BARS * ms && p.v > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return { open: null, bars: [] };
  const bars: Bar[] = [];
  const last = pts[pts.length - 1].t;
  let i = 0;
  for (let b = 0; b < BARS; b++) {
    const end = openMs + (b + 1) * ms;
    if (last < end - 30_000) break; // 這根還沒走完
    const inBar: number[] = [];
    while (i < pts.length && pts[i].t <= end) inBar.push(pts[i++].v);
    const prevClose = bars.length ? bars[bars.length - 1][3] : pts[0].v;
    const vals = inBar.length ? inBar : [prevClose];
    bars.push([prevClose, Math.max(prevClose, ...vals), Math.min(prevClose, ...vals), vals[vals.length - 1]]);
  }
  return { open: pts[0].v, bars };
}

interface View {
  live: boolean;
  P0: number;
  /** 00631L 前一天收盤（看 00631L 時才有；看加權指數、台指期時 null）。 */
  L0: number | null;
  /** 看台指期時：前一天臺指期收盤（價位＝指數 × T0 ÷ P0）。 */
  T0?: number | null;
  /** 即時：00631L 自己的最新成交價（有的話用它校正換算，00631L 常跟「加權指數 × 倍數」差好幾 %）。 */
  Lnow?: number | null;
  /** 回放：00631L 當天真正的開高低收（用開盤、收盤的實價校正換算，實際收盤／高低直接顯示實價）。 */
  Lday?: [number, number, number, number] | null;
  ctx: DailyCtx;
  /** 已經知道的 K 棒（回放是整天）。 */
  ix: Bar[];
  open: number | null;
  /** 預測時間：-1 開盤前、0 開盤、k 第 k 根收盤後。 */
  k: number;
  /** 這一天用的模型與設定（回放用「回放之前」的模型）。 */
  m: IntradayModel;
  dm: DayModel;
  choice: IntradayData['choice'];
  /** 進出場：模型的設定（可能是「不交易」）與參考設定。 */
  plan?: RangePlanOut;
  ref?: RangePlanOut;
}

type Analogs = ReturnType<typeof analogLines> | null;

/** 各條預測線：c 的索引（0＝開盤、b＝第 b 根收盤）→ 價格，含起點。 */
/** 預測時間 k 對應的自動設定（用最接近的回測時間點）。 */
function choiceFor(choice: IntradayData['choice'], k: number): { n: number; w: number } {
  const cs = choice ?? [];
  if (!cs.length) return { n: 5, w: 1 };
  return cs.reduce((best, c) => (Math.abs(c.origin - k) < Math.abs(best.origin - k) ? c : best), cs[0]);
}

function lineSeries(v: View, f: DayForecast, an: Analogs, ch: { n: number; w: number } = { n: 5, w: 1 }): Partial<Record<LineId, Array<[number, number]>>> {
  const out: Partial<Record<LineId, Array<[number, number]>>> = {};
  const pre = v.k < 0;
  const start: [number, number] = pre ? [0, f.open] : [f.from, f.from === 0 ? f.open : v.ix[f.from - 1][3]];
  out.model = [start, ...f.bars.map((b) => [b.bar + 1, b.c] as [number, number])];
  if (an && an.lines.length) {
    // 相似日：開盤前從各自的開盤畫起；盤中從現在的價格接下去
    const conv = (closes: number[]): Array<[number, number]> => (pre ? closes.map((c, i) => [an.from + i, c]) : [[f.from, start[1]], ...closes.map((c, i) => [an.from + i, c] as [number, number])]);
    const avgN = avgOf(an.lines, ch.n);
    out.avg = conv(avgN);
    const modelCloses = pre ? [f.open, ...f.bars.map((b) => b.c)] : f.bars.map((b) => b.c);
    const bl = blendLine(modelCloses, avgN, ch.w);
    out.blend = conv(bl);
    // 方向預測（主線）：一定押方向；起點價格：開盤前是昨收，盤中是現價
    const ref = pre ? v.P0 : start[1];
    const lastBar = f.bars[f.bars.length - 1];
    const dl = directionLine(an.lines, bl, ref, 7, lastBar ? typicalCloseMove(lastBar.lo, lastBar.hi) : undefined);
    if (dl.length) out.dir = conv(dl);
    an.lines.slice(0, 3).forEach((l, i) => (out[`a${i + 1}` as LineId] = conv(l.closes)));
  }
  return out;
}

/** 這一天的進出場價位（走到設定的時間點之後才有）；模型選「不交易」時用參考設定。 */
function levelsFor(d: IntradayData, v: View): { lv: RangeLevels; plan: RangePlanOut; isRef: boolean; sim: ReturnType<typeof simulateRange> | null } | null {
  const use = v.plan && !v.plan.noTrade ? v.plan : v.ref;
  if (!use || v.ix.length < use.k || v.k < use.k) return null;
  const plan: RangePlan = { ...use, m: use.m ?? 0 };
  const lv = rangeLevels(v.dm, v.ix, plan, v.P0, v.ctx, d.beta);
  const sim = !v.live && v.ix.length === BARS ? simulateRange(v.ix, lv) : null;
  return { lv, plan: use, isRef: use !== v.plan, sim };
}

/**
 * 預測 K 棒：沿著方向預測主線畫（沒有主線時沿模型主線）。每根的開盤＝前一根收盤、收盤＝主線上的點，
 * 上下影線用模型預測的那一根的振幅（扣掉實體後平均分到上下）。
 */
function predCandles(series: Partial<Record<LineId, Array<[number, number]>>>, f: DayForecast): Array<{ bar: number; o: number; h: number; l: number; c: number; span: number }> {
  const line = series.dir ?? series.model;
  if (!line || line.length < 2) return [];
  const rng = new Map(f.bars.map((b) => [b.bar, Math.log(b.h / b.l)]));
  // 1 分、3 分 K 一根太細看不到：幾根合成一根（畫面上至少約 8px 寬）
  const g = Math.max(1, Math.round(8 / (700 / BARS)));
  const out: Array<{ bar: number; o: number; h: number; l: number; c: number; span: number }> = [];
  for (let n = 1; n < line.length; n += g) {
    const m = Math.min(line.length - 1, n + g - 1);
    const o = line[n - 1][1];
    const c = line[m][1];
    let hi = Math.max(o, c);
    let lo = Math.min(o, c);
    for (let q = n; q <= m; q++) {
      const p0 = line[q - 1][1];
      const p1 = line[q][1];
      const wick = Math.max(0, (rng.get(line[q][0] - 1) ?? 0) - Math.abs(Math.log(p1 / p0))) / 2;
      hi = Math.max(hi, Math.max(p0, p1) * Math.exp(wick));
      lo = Math.min(lo, Math.min(p0, p1) * Math.exp(-wick));
    }
    const b0 = line[n][0] - 1;
    const b1 = line[m][0] - 1;
    out.push({ bar: (b0 + b1) / 2, o, c, h: hi, l: lo, span: b1 - b0 + 1 });
  }
  return out;
}

/** 淘汰賽的線：被淘汰的淡灰色停在淘汰那一根（✕），存活的橘色細線畫到收盤，存活平均畫粗線。 */
function koSvg(ko: KnockoutLine[], avg: number[], xi: (i: number) => number, sy: (x: number) => number): string {
  const pathOf = (cs: number[], end: number) => cs.slice(0, end + 1).map((p, j) => `${j ? 'L' : 'M'}${xi(j).toFixed(1)},${sy(p).toFixed(1)}`).join('');
  const out = ko
    .filter((l) => l.out != null)
    .map((l) => `<path class="pd-ko-out" d="${pathOf(l.closes, l.out!)}"/><text class="pd-ko-x" x="${xi(l.out!).toFixed(1)}" y="${(sy(l.closes[l.out!]) + 3).toFixed(1)}" text-anchor="middle">✕</text>`)
    .join('');
  const live = ko.filter((l) => l.out == null).map((l) => `<path class="pd-ko-live" d="${pathOf(l.closes, l.closes.length - 1)}"/>`).join('');
  return `${out}${live}${avg.length ? `<path class="pd-ko-avg" d="${pathOf(avg, avg.length - 1)}"/>` : ''}`;
}

function chart(d: IntradayData, v: View, f: DayForecast, st: IntradayState, an: Analogs, ko: KnockoutLine[] | null = null): string {
  const W = 760;
  const H = 320;
  const pad = { l: 54, r: 12, t: 12, b: 24 };
  const L = convOf(v, d);
  const known = v.ix.slice(0, f.from);
  const future = st.showActual && !v.live ? v.ix.slice(f.from) : [];
  const series = lineSeries(v, f, an, choiceFor(v.choice, v.k));
  // 淘汰賽打開時不畫一般的相似日線（太亂）
  // 預測 K 棒就是方向預測主線畫成 K 棒：打開時不再畫主線（兩者重疊會把 K 棒蓋掉）
  const shown = LINE_IDS.filter((id) => series[id] && ((id === 'dir' && !st.showCandles) || id === 'blend' || id === 'model' || (st.showAnalogs && !ko)));
  const koLive = ko?.filter((l) => l.out == null) ?? [];
  const koAvg = koLive.length ? koLive[0].closes.map((_, j) => Math.exp(koLive.reduce((t, l) => t + Math.log(l.closes[j]), 0) / koLive.length)) : [];
  const vals = [
    ...(ko ?? []).flatMap((l) => l.closes.slice(0, (l.out ?? BARS) + 1)),
    ...known.flatMap((b) => [b[1], b[2]]),
    ...future.flatMap((b) => [b[1], b[2]]),
    ...shown.flatMap((id) => series[id]!.map((p) => p[1])),
    ...(st.showCandles ? predCandles(series, f).flatMap((k) => [k.h, k.l]) : []),
    f.dayHigh,
    f.dayLow,
    v.P0,
    ...(() => {
      const l2 = st.showLevels ? levelsFor(d, v) : null;
      return l2 ? [l2.lv.buy, l2.lv.short].filter((x) => x > 0 && Number.isFinite(x)) : [];
    })(),
  ].map(L);
  const span = Math.max(...vals) - Math.min(...vals) || 1;
  const lo = Math.min(...vals) - span * 0.04;
  const hi = Math.max(...vals) + span * 0.04;
  const bw = (W - pad.l - pad.r) / BARS;
  const cx = (bar: number) => pad.l + (bar + 0.5) * bw;
  /** c 的索引 → x（第 b 根收盤畫在那根 K 棒的右緣附近）。 */
  const xi = (i: number) => (i === 0 ? pad.l + bw * 0.15 : cx(i - 1) + bw * 0.35);
  const sy = (x: number) => pad.t + (1 - (L(x) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const candle = (bar: number, [o, h, l, c]: Bar, kind: string, span = 1) => {
    const x = cx(bar);
    const bwk = bw * span;
    const top = sy(Math.max(o, c));
    const bot = sy(Math.min(o, c));
    return `<g class="${c >= o ? 'k-up' : 'k-down'} ${kind}"><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${sy(h).toFixed(1)}" y2="${sy(l).toFixed(1)}"/><rect x="${(x - bwk * 0.34).toFixed(1)}" y="${top.toFixed(1)}" width="${(bwk * 0.68).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
  };
  const startX = pad.l + f.from * bw;
  const startY = sy(f.from === 0 ? f.open : v.ix[f.from - 1][3]);
  const band =
    st.showBand && f.bars.length
      ? `M${startX.toFixed(1)},${startY.toFixed(1)}${f.bars.map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.hi).toFixed(1)}`).join('')}${[...f.bars].reverse().map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.lo).toFixed(1)}`).join('')}Z`
      : '';
  const hline = (y: number, label: string, c: string) =>
    `<line class="pd-hl ${c}" x1="${startX.toFixed(1)}" x2="${W - pad.r}" y1="${sy(y).toFixed(1)}" y2="${sy(y).toFixed(1)}"/><text class="pd-tick ${c}" x="${W - pad.r - 2}" y="${(sy(y) + (c === 'is-hi' ? -4 : 12)).toFixed(1)}" text-anchor="end">${label} ${num(L(y), 2)}</text>`;
  // 先畫相似日（細線），模型主線最後畫（最上層）
  const order = [...shown].reverse();
  const path = (id: LineId) => `<path class="pd-ln ln-${id}" d="${series[id]!.map(([i, p], n) => `${n ? 'L' : 'M'}${xi(i).toFixed(1)},${sy(p).toFixed(1)}`).join('')}"/>`;
  const endLabel = (id: LineId) => {
    const pts = series[id]!;
    const [i, p] = pts[pts.length - 1];
    return `<circle class="pd-end ln-${id}" cx="${xi(i).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="3"/>`;
  };
  // 進出場價位線（從設定的時間點畫到收盤）
  const L2 = levelsFor(d, v);
  let levelSvg = '';
  if (L2 && st.showLevels) {
    const x0 = pad.l + L2.lv.k * bw;
    const seg = (y: number, cls2: string, label: string) =>
      y > 0 && Number.isFinite(y) ? `<line class="pd-lv ${cls2}" x1="${x0.toFixed(1)}" x2="${W - pad.r}" y1="${sy(y).toFixed(1)}" y2="${sy(y).toFixed(1)}"/><text class="pd-tick pd-lvt ${cls2}" x="${(x0 + 4).toFixed(1)}" y="${(sy(y) - 3).toFixed(1)}">${label} ${num(L(y), 2)}</text>` : '';
    const lv = L2.lv;
    levelSvg = [
      lv.buy > 0 ? seg(lv.buy, 'lv-buy', '買進') + seg(lv.buyTarget, 'lv-tp', '買進停利') + seg(lv.buyStop, 'lv-sl', '買進停損') : '',
      Number.isFinite(lv.short) ? seg(lv.short, 'lv-short', '放空') + seg(lv.shortTarget, 'lv-tp', '放空停利') + seg(lv.shortStop, 'lv-sl', '放空停損') : '',
    ].join('');
    const sm = L2.sim;
    if (sm && sm.side && st.showActual) {
      levelSvg += `<circle class="pd-fill" cx="${cx(sm.entryBar).toFixed(1)}" cy="${sy(sm.entry).toFixed(1)}" r="5"/><circle class="pd-exit ${sm.ret > 0 ? 'is-win' : 'is-loss'}" cx="${cx(sm.exitBar).toFixed(1)}" cy="${sy(sm.exit).toFixed(1)}" r="5"/>`;
    }
  }
  const ticks = [lo, (lo + hi) / 2, hi];
  const dates = an?.lines.slice(0, 3).map((l) => l.date) ?? [];
  return `<div class="pd-intra-scroll"><svg class="pd-chart pd-intra-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="整天 ${STEP} 分 K 預測線">
    <defs><clipPath id="pd-clip"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath></defs>
    <line class="pd-base" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v.P0).toFixed(1)}" y2="${sy(v.P0).toFixed(1)}"/>
    <text class="pd-tick" x="${pad.l + 4}" y="${(sy(v.P0) - 4).toFixed(1)}">昨收 ${num(L(v.P0), 2)}</text>
    ${band ? `<path class="pd-band" clip-path="url(#pd-clip)" d="${band}"/>` : ''}
    ${hline(f.dayHigh, '預估最高', 'is-hi')}${hline(f.dayLow, '預估最低', 'is-lo')}
    ${known.map((b, i) => candle(i, b, 'is-real')).join('')}
    ${future.map((b, i) => candle(f.from + i, b, 'is-actual')).join('')}
    ${st.showCandles ? predCandles(series, f).map((k) => candle(k.bar, [k.o, k.h, k.l, k.c], 'is-pred', k.span)).join('') : ''}
    <g clip-path="url(#pd-clip)">${ko ? koSvg(ko, koAvg, xi, sy) : ''}${levelSvg}${order.map(path).join('')}${order.map(endLabel).join('')}</g>
    ${f.from > 0 ? `<line class="pd-now" x1="${startX.toFixed(1)}" x2="${startX.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>` : ''}
    ${ticks.map((t) => `<text class="pd-tick" x="${pad.l - 6}" y="${(pad.t + (1 - (t - lo) / (hi - lo || 1)) * (H - pad.t - pad.b) + 4).toFixed(1)}" text-anchor="end">${num(t, 2)}</text>`).join('')}
    ${[0, 60, 120, 180, 240].map((mm) => mm / STEP).map((b) => `<text class="pd-tick" x="${(pad.l + b * bw).toFixed(1)}" y="${H - 6}" text-anchor="${b === 0 ? 'start' : 'middle'}">${clock(b)}</text>`).join('')}
    <text class="pd-tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end">13:30</text>
  </svg></div>
  <p class="pd-legend pd-intra-legend">
    ${series.dir ? (st.showCandles ? '<span class="pd-key-pred"><i></i>方向預測（畫成 K 棒）</span>' : '<span class="lg-dir"><i></i>方向預測（主線）</span>') : ''}${series.blend ? '<span class="lg-blend"><i></i>綜合預測</span>' : ''}<span class="lg-model"><i></i>模型主線</span>
    ${ko ? `<span class="lg-ko-live"><i></i>淘汰賽存活（${koLive.length}／${ko.length} 天：${koLive.slice(0, 6).map((l) => esc(l.date)).join('、')}${koLive.length > 6 ? '⋯' : ''}）</span><span class="lg-ko-avg"><i></i>存活平均</span><span class="lg-ko-out"><i></i>已淘汰（✕＝淘汰的時間點）</span><span class="muted">開盤時依開盤前條件與跳空挑 30 天，偏離超過容許範圍就淘汰。回測：存活平均預測之後的方向約 49～57%，沒有比 30 天全部平均準，當作「今天像哪幾天」來看。</span>` : ''}
    ${st.showAnalogs && !ko && series.avg ? `<span class="lg-avg"><i></i>相似日平均（前 ${choiceFor(v.choice, v.k).n} 名）</span>${dates.map((dt, i) => `<span class="lg-a${i + 1}"><i></i>相似日 ${i + 1}：${esc(dt)}</span>`).join('')}` : ''}
    <span class="pd-key-real"><i></i>已走完</span>${future.length ? '<span class="pd-key-actual"><i></i>實際走勢（當時還不知道）</span>' : ''}
    <span class="pd-key-hl"><i></i>預估今日最高／最低</span>${band ? '<span class="pd-band-key"><i></i>收盤約 80% 區間</span>' : ''}
  </p>`;
}

/** 回放：這一天每條線的誤差與收盤方向對不對。 */
function lineErrors(v: View, f: DayForecast, an: Analogs, lev: number): Array<{ id: LineId; rmse: number; dirOk: boolean }> | null {
  if (v.live || v.ix.length < BARS) return null;
  const series = lineSeries(v, f, an, choiceFor(v.choice, v.k));
  const ref = v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  const act = (i: number) => (i === 0 ? v.ix[0][0] : v.ix[i - 1][3]);
  const actClose = v.ix[BARS - 1][3];
  return LINE_IDS.filter((id) => series[id]).map((id) => {
    // 起點不算（開盤前的模型與相似日起點都是預測的開盤，要算）
    const pts = series[id]!.filter((_, n) => v.k < 0 || n > 0);
    const se = pts.reduce((s, [i, p]) => s + Math.log(p / act(i)) ** 2, 0);
    const lastP = pts[pts.length - 1][1];
    return { id, rmse: Math.sqrt(se / (pts.length || 1)) * lev, dirOk: Math.sign(lastP - ref) === Math.sign(actClose - ref) };
  });
}

/** 這一天（回放）預測的誤差：跟實際比。 */
function dayErrors(d: IntradayData, v: View, f: DayForecast) {
  const lev = v.L0 ? d.beta : 1;
  if (v.live || v.ix.length < BARS || !f.bars.length) return null;
  const ref = v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  let pe = 0;
  let pn = 0;
  let re = 0;
  let inBand = 0;
  for (const b of f.bars) {
    const a = v.ix[b.bar];
    pe += Math.log(b.c / a[3]) ** 2;
    pn += Math.log(ref / a[3]) ** 2;
    re += Math.abs(Math.log(b.h / b.l) - barRange(a));
    if (a[3] >= b.lo && a[3] <= b.hi) inBand++;
  }
  const n = f.bars.length;
  const hiA = Math.max(...v.ix.map((b) => b[1]));
  const loA = Math.min(...v.ix.map((b) => b[2]));
  return {
    path: Math.sqrt(pe / n) * lev,
    naive: Math.sqrt(pn / n) * lev,
    range: (re / n) * lev,
    inBand: inBand / n,
    hiErr: Math.log(f.dayHigh / hiA) * lev,
    loErr: Math.log(f.dayLow / loA) * lev,
  };
}

/** 00631L 當天進出場：建議、價位、回測。 */
function rangeHtml(d: IntradayData, v: View): string {
  const rt = d.rangeTrade;
  if (!rt) return '';
  const L = convOf(v, d);
  const P = (x: number) => (x > 0 && Number.isFinite(x) ? num(L(x), 2) : '—');
  const use = v.plan && !v.plan.noTrade ? v.plan : v.ref;
  const l2 = levelsFor(d, v);
  const when = use ? clock(use.k) : '09:30';
  const advice = v.plan?.noTrade
    ? `<p class="pd-advice is-warn">⚠️ <b>模型建議：${v.live ? '今天' : '這天'}不交易。</b>過去沒有任何一種進出場方式在統計上穩定賺過交易成本（${pctTxt(DAYTRADE_COST, 2).replace('+', '')}／次）。下面是「過去表現最好的設定」算出的<b>參考價位</b>，不是建議。</p>`
    : `<p class="pd-advice">✅ <b>模型建議：${when} 掛單。</b>過去這組設定的獲利在統計上顯著大於 0。</p>`;
  const lvTable = l2
    ? `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th></th><th class="num">進場</th><th class="num">停利</th><th class="num">停損</th><th>最晚</th></tr></thead><tbody>
        <tr><td><span class="up">往下買進</span></td><td class="num">${P(l2.lv.buy)}</td><td class="num">${P(l2.lv.buyTarget)}</td><td class="num">${P(l2.lv.buyStop)}</td><td>13:30 收盤出場</td></tr>
        <tr><td><span class="down">往上放空</span></td><td class="num">${P(l2.lv.short)}</td><td class="num">${P(l2.lv.shortTarget)}</td><td class="num">${P(l2.lv.shortStop)}</td><td>13:30 收盤出場</td></tr>
      </tbody></table></div>
      <p class="muted pd-small">${when} 依「剩下時間預估會往上、往下走多遠」同時掛兩張單，先成交的那邊算數、另一張取消；「—」代表預估幅度不夠大（停利扣掉成本不划算），那邊不掛。${l2.sim ? (l2.sim.side ? `這一天：${l2.sim.side > 0 ? '買進' : '放空'}在 ${clock(l2.sim.entryBar)}～ 成交，${l2.sim.how === 'target' ? '停利' : l2.sim.how === 'stop' ? '停損' : '收盤'}出場，00631L 約 <b class="${cls(l2.sim.ret)}">${pctTxt(l2.sim.ret * d.beta - DAYTRADE_COST)}</b>（扣成本）。` : '這一天兩邊都沒成交。') : ''}</p>`
    : `<p class="muted">${when} 之後（走完前 ${use?.k ?? 6} 根 ${STEP} 分 K）才算得出價位；把「預測時間」拉到 ${when} 以後。</p>`;
  const row = (name: string, x: RangeStat | null) =>
    x
      ? `<tr><td>${esc(name)}<br><small class="muted">${esc(x.from)}～${esc(x.to)}</small></td><td class="num">${num(x.days)}</td><td class="num">${num(x.trades)}</td><td class="num">${x.trades ? `${num(x.win * 100, 0)}%` : '—'}</td><td class="num ${cls(x.avg)}">${x.trades ? pctTxt(x.avg, 2) : '—'}</td><td class="num ${cls(x.total)}">${pctTxt(x.total)}</td><td class="num down">${pctTxt(x.maxDD)}</td><td class="num ${cls(x.hold)}">${pctTxt(x.hold)}</td></tr>`
      : '';
  // 模型建議不交易時，價位表與回測收起來（只留建議）
  const fold = v.plan?.noTrade;
  return `<div class="pd-range"><h3 class="pd-sub">00631L 當天進出場點</h3>${advice}${fold ? '<details class="pd-more"><summary>參考價位與進出場回測</summary>' : ''}${lvTable}
    <h3 class="pd-sub">進出場的回測（逐段往前滾：每天只用之前的日子挑設定；扣成本，00631L）</h3>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>期間</th><th class="num">天數</th><th class="num">出手</th><th class="num">勝率</th><th class="num">每次平均</th><th class="num">累計</th><th class="num">最大回落</th><th class="num">每天開盤買<br>收盤賣</th></tr></thead>
    <tbody>${row('從沒看過的期間', rt.hold)}${row('開發期間', rt.dev)}${row('全部', rt.all)}</tbody></table></div>
    <p class="muted pd-small">設定（幾點掛單、離現價多遠、停利停損多遠、幅度要超過成本幾倍才掛）有 144 組，每天只用「之前的日子」挑；而且要求過去的獲利在統計上明顯大於 0（t 值 > 2）才出手，否則選「不交易」。</p>${fold ? '</details>' : ''}</div>`;
}

const usedTxt = (u?: Record<string, string[]>) => {
  if (!u) return '—';
  const nm = (k: string) => (k === 'gap' ? '開盤跳空' : k === `path${BARS}` ? '到收盤' : `${Number(k.slice(4)) * STEP} 分鐘`);
  const g = (x: string[]) => (x.length ? x.map((v) => (v === 'us' ? '美股' : v === 'night' ? '夜盤' : '自創指標')).join('＋') : '都不用');
  return Object.entries(u).map(([k, v]) => `${nm(k)}：${g(v)}`).join('、');
};
const discTxt = (m: IntradayModel) =>
  m.disc?.length ? m.disc.map((s, i) => `「${esc(discName(s))}」（t＝${num(m.discT?.[i] ?? NaN, 1)}${(m.discT?.[i] ?? 0) > 0 ? '，越大越容易漲' : '，越大越容易跌'}）`).join('、') : '這次訓練沒有找到夠強的（寧缺勿濫）';
/** 預測邏輯（白話）。 */
/** 這一天（回放）的結果，一句話：主線方向對不對、誤差多少、哪條線最準。 */
function dayVerdict(lerr: ReturnType<typeof lineErrors>, err: ReturnType<typeof dayErrors>): string {
  if (!lerr?.length) return '';
  const main = lerr.find((e) => e.id === 'dir') ?? lerr.find((e) => e.id === 'blend');
  const best = [...lerr].sort((x, y) => x.rmse - y.rmse)[0];
  return `<p class="pd-day-err">${main ? `這天的${LINE_NAME[main.id]}：收盤方向 ${main.dirOk ? '<b class="ok">✓ 對</b>' : '<b class="ng">✗ 錯</b>'}・每根誤差 <b>${num(main.rmse * 100, 2)}%</b>` : ''}${err ? `（假設不會動 ${num(err.naive * 100, 2)}%）・區間涵蓋 ${num(err.inBand * 100, 0)}%` : ''}・這天最準：${LINE_NAME[best.id]}</p>`;
}

/** 方向預測（主線）各預測時間的收盤方向命中率（長條圖，50% 是擲銅板）。 */
function hitChart(d: IntradayData): string {
  const rows = (d.lines ?? []).filter((o) => o.dir);
  if (!rows.length) return '';
  const W = 640;
  const H = 190;
  const pad = { l: 34, r: 52, t: 18, b: 26 };
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = (v: number) => pad.t + (1 - (v - 0.4) / 0.4) * (H - pad.t - pad.b);
  const bars = rows
    .map((o, i) => {
      const v = o.dir.hit;
      const x = pad.l + i * bw + bw * 0.2;
      return `<rect class="${v >= 0.55 ? 'hc-good' : 'hc-weak'}" x="${x.toFixed(1)}" y="${y(Math.max(0.4, v)).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${(y(0.4) - y(Math.max(0.4, v))).toFixed(1)}" rx="3"/>
        <text class="hc-val" x="${(x + bw * 0.3).toFixed(1)}" y="${(y(Math.max(0.4, v)) - 4).toFixed(1)}" text-anchor="middle">${num(v * 100, 0)}%</text>
        <text class="pd-tick" x="${(x + bw * 0.3).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(o.label.replace(' 開盤', ''))}</text>`;
    })
    .join('');
  return `<h3 class="pd-sub">方向預測過去猜對收盤方向的比例</h3>
    <svg class="pd-chart pd-hitchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="方向命中率">
      ${[0.4, 0.5, 0.6, 0.7, 0.8].map((t) => `<line class="${t === 0.5 ? 'hc-coin' : 'hc-grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="pd-tick" x="${pad.l - 4}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t * 100}</text>`).join('')}
      ${bars}
      <text class="pd-tick hc-coin-t" x="${W - pad.r + 4}" y="${(y(0.5) + 4).toFixed(1)}">擲銅板</text>
    </svg>
    <p class="muted pd-small">逐段往前滾的樣本外回測（每天只用那天以前的資料）。開盤前最準，是因為前一晚美股、夜盤很能預測台股當天；開盤後越晚越接近擲銅板。</p>`;
}

function logicHtml(d: IntradayData): string {
  const ch = (d.choice ?? []).map((c) => `${c.origin < 0 ? '開盤前' : c.origin === 0 ? '開盤' : clock(c.origin)}：相似日 ${c.n} 天、模型 ${Math.round(c.w * 100)}%`).join('；');
  return `<details class="pd-more pd-logic"><summary>預測邏輯（怎麼算出這些線）</summary>
    <ol class="pd-logic-list">
      <li><b>資料</b>：2020 年以來每天的加權指數 5 分 K（證交所每 5 秒指數統計），加上日 K、外資台指期淨未平倉。00631L 沒有公開的歷史盤中資料，用「β × 加權指數報酬」換算（β ≈ ${num(d.beta, 2)}，近一年日報酬估計）。</li>
      <li><b>開盤前</b>：用昨天的漲跌、近 5 日、昨天開盤到收盤、昨天振幅、外資期貨增減，預測開盤跳空。</li>
      <li><b>模型主線</b>：每 5 分鐘看「現在的狀態」——時間、跳空、開盤到現在、最近 1／3／6 根的漲跌、今天的波動、在今天高低區間的位置、前一天的資料——用嶺迴歸分別預測接下來 1、2、3、6、12 根與到收盤的報酬，再連成一條線。每次訓練把最後 20% 的資料留做驗證，從幾種強度裡挑誤差最小的；方向越難預測，模型會自動越保守（線越平）。</li>
      <li><b>相似日走勢</b>：把歷史上每一天都跟今天比——開盤前的資料、跳空、到目前為止的走勢形狀（最近 6 根加重）都先除以各自的波動——找出最像的 20 天。前 3 名各畫一條（依波動比例縮放、接在現在的價格後面），前 n 名平均成「相似日平均」。</li>
      <li><b>綜合預測</b>：模型主線與相似日平均依權重混合。相似日要取幾天（5／10／20）、模型佔多少（0～100%），每個預測時間點分開挑：用「到前一天為止」所有回測日的實際誤差，選誤差最小的組合。目前：${esc(ch)}。</li>
      <li><b>振幅與高低點</b>：每根 K 棒的振幅＝這個時段平常的振幅 × 今天／昨天的波動延續；今天剩下時間的最高最低另外預測。80% 區間依時段與當天波動放大縮小，回測校準過。</li>
      <li><b>自己決定用哪些資料</b>：前一晚美股（費半、台積電 ADR、S&P 500）與臺指期夜盤可以整組不用；每次訓練用最後 20% 的資料比較「都不用／只用美股／只用夜盤／都用」，挑誤差最小的。目前：${esc(usedTxt(d.used))}。</li>
      <li><b>模型自創指標</b>：除了上面這些現成的數據，模型自己「發明」指標——把 24 種開盤前與盤中已知的原始數據（例如夜盤振幅、夜盤收在高點還是低點、費半減 S&amp;P、跳空減夜盤、VIX 變化、離今天高低點多遠）兩兩相乘、乘上另一個的大小或方向，產生約 1400 個候選；每次訓練只用訓練資料，挑出最能解釋「基本模型預測不到的部分」的最多 4 個（統計 t 值要超過 4，彼此不能太像），再交給上一條的驗證決定要不要用。目前：${discTxt(d.model)}。</li>
      <li><b>不看答案</b>：回測一律逐段往前滾；網頁的回放用「回放那幾天之前」訓練的模型；成績分成「從沒看過的期間」與「開發期間」（模型是看著開發期間調的，可能偏樂觀）；另外每天收盤後把隔天的預測事前存檔，之後才打「實盤成績」。</li>
      <li><b>持續修正</b>：每天資料更新、網站部署時，用最新的全部資料重新訓練、重新挑設定、重新計算所有回測成績；回測一律「逐段往前滾」——每一天只用那天以前的資料預測，跟實際使用時一樣。</li>
    </ol>
  </details>`;
}

/** 各條預測線的回測成績表。 */
function linesTable(d: IntradayData, lev: number): string {
  const hold = d.periods?.hold;
  const dev = d.periods?.dev;
  const blocks = [
    hold ? { title: `從沒看過的期間（${hold.from} ～ ${hold.to}，${num(hold.days)} 天）`, note: '調整模型時完全沒看過這段資料，這是公正的成績', lines: hold.lines } : null,
    dev ? { title: `開發期間（${dev.from} ～ ${dev.to}，${num(dev.days)} 天）`, note: '調整模型時看過這段的成績，可能偏樂觀', lines: dev.lines } : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
  if (!blocks.length) return linesTableOf(d.lines ?? [], lev, `每條線準不準（回測 ${esc(d.backtest.from)} ～ ${esc(d.backtest.to)}，樣本外）`, '');
  return blocks.map((b) => linesTableOf(b.lines, lev, `每條線準不準：${esc(b.title)}`, b.note)).join('') + (hold ? '' : '<p class="muted pd-small">「從沒看過的期間」等 5 分 K 回補到 2020 年後就會出現。</p>');
}

function linesTableOf(lines: NonNullable<IntradayData['lines']>, lev: number, title: string, note: string): string {
  const d = { lines };
  if (!d.lines?.length) return '';
  const head = d.lines.map((o) => `<th class="num">${esc(o.label)}</th>`).join('');
  // 舊的資料檔沒有「方向預測」：只列有資料的線
  const ids = LINE_IDS.filter((id) => d.lines!.every((o) => o[id]));
  const rows = ids.map((id) => {
    const cells = d.lines!.map((o) => {
      const x = o[id];
      const best = Math.min(...ids.map((j) => o[j].rmse));
      return `<td class="num"><b class="${x.rmse === best ? 'up' : ''}">${num(x.rmse * lev * 100, 2)}%</b><br><small>方向 ${num(x.hit * 100, 0)}%・最準 ${num(x.best * 100, 0)}%</small></td>`;
    });
    return `<tr><td><span class="lg-${id}"><i></i>${LINE_NAME[id]}</span></td>${cells.join('')}</tr>`;
  }).join('');
  return `<h3 class="pd-sub">${title}</h3>${note ? `<p class="muted pd-small">${esc(note)}</p>` : ''}
    <div class="pd-table-wrap"><table class="pd-table pd-lines-table"><thead><tr><th>預測線＼預測時間</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted pd-small">大字：每根 K 棒收盤價的平均誤差（換算成上面選的標的，越小越準，紅色是該時間點最準的線）。方向：預測的收盤比現在高或低，跟實際一致的比例（50% 等於擲硬幣）。最準：五條線裡這條最接近實際走勢的天數比例。</p>`;
}

/** 事前存檔的實盤成績：每天收盤後就存好的預測 vs 之後的實際走勢。 */
function forwardHtml(d: IntradayData, lev: number): string {
  const f = d.forward;
  const head = '<h3 class="pd-sub">實盤成績（事前存檔，完全不可能看答案）</h3>';
  const intro = '<p class="muted pd-small">每天收盤後，下一個交易日開盤前的預測就存進 forecasts 分支（只會新增、不會修改，git 時間證明是事前做的），之後只拿存檔的數字跟實際比。</p>';
  if (!f || !f.days) return `${head}${intro}<p class="muted">從今天開始存檔，下一個交易日收盤後就會出現第一筆。</p>`;
  const p = (x: number, ref: number) => pctTxt(Math.log(x / ref) * lev);
  const mark = (x: number, r: (typeof f.rows)[number]) => (Math.sign(x - r.P0) === Math.sign(r.actual - r.P0) ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>');
  return `${head}${intro}
    <dl class="pd-stats">
      <div><dt>存檔天數</dt><dd class="num">${num(f.days)}</dd></div>
      <div><dt>收盤方向猜對（綜合／模型／相似日）</dt><dd class="num">${f.hit.blend}／${f.hit.model}／${f.hit.avg} <small>共 ${f.days} 天</small></dd></div>
      <div><dt>每根誤差（綜合／不會動）</dt><dd class="num">${num(f.rmse.blend * lev * 100, 2)}%／${num(f.rmse.flat * lev * 100, 2)}%</dd></div>
    </dl>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>交易日</th><th class="num">綜合預測</th><th class="num">模型主線</th><th class="num">相似日平均</th><th class="num">實際</th><th class="num">每根誤差<br><small>綜合／不會動</small></th></tr></thead>
    <tbody>${f.rows
      .map((r) => `<tr><td class="num">${esc(r.date)}</td><td class="num ${cls(r.blend - r.P0)}">${p(r.blend, r.P0)} ${mark(r.blend, r)}</td><td class="num ${cls(r.model - r.P0)}">${p(r.model, r.P0)} ${mark(r.model, r)}</td><td class="num ${cls(r.avg - r.P0)}">${p(r.avg, r.P0)} ${mark(r.avg, r)}</td><td class="num ${cls(r.actual - r.P0)}">${p(r.actual, r.P0)}</td><td class="num">${num(r.rmse.blend * lev * 100, 2)}%／${num(r.rmse.flat * lev * 100, 2)}%</td></tr>`)
      .join('')}</tbody></table></div>`;
}

/** 最近的預測紀錄（開盤前預測的收盤 vs 實際）。 */
function recordTable(d: IntradayData, lev: number): string {
  const rec = (d.record ?? []).filter((r) => r.origin === -1).slice(-20).reverse();
  if (!rec.length) return '';
  const p = (x: number, ref: number) => Math.log(x / ref) * lev;
  const mark = (x: number, r: (typeof rec)[number]) => (Math.sign(x - r.ref) === Math.sign(r.actual - r.ref) ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>');
  const ok = (key: 'blend' | 'model' | 'avg') => rec.filter((r) => Math.sign((r[key] ?? r.model) - r.ref) === Math.sign(r.actual - r.ref)).length;
  return `<details class="pd-more"><summary>回測：最近 ${rec.length} 天的開盤前預測（逐段往前滾，只用那天以前的資料）</summary>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>日期</th><th class="num">綜合預測</th><th class="num">模型主線</th><th class="num">相似日平均</th><th class="num">實際</th></tr></thead>
    <tbody>${rec
      .map((r) => `<tr><td class="num">${esc(r.date)}</td><td class="num ${cls((r.blend ?? r.model) - r.ref)}">${pctTxt(p(r.blend ?? r.model, r.ref))} ${mark(r.blend ?? r.model, r)}</td><td class="num ${cls(r.model - r.ref)}">${pctTxt(p(r.model, r.ref))} ${mark(r.model, r)}</td><td class="num ${cls(r.avg - r.ref)}">${pctTxt(p(r.avg, r.ref))} ${mark(r.avg, r)}</td><td class="num ${cls(r.actual - r.ref)}">${pctTxt(p(r.actual, r.ref))}</td></tr>`)
      .join('')}
      <tr class="pd-sum-row"><td>方向猜對</td><td class="num">${ok('blend')}／${rec.length}</td><td class="num">${ok('model')}／${rec.length}</td><td class="num">${ok('avg')}／${rec.length}</td><td></td></tr></tbody></table></div>
  </details>`;
}

export interface IntradayState {
  /** 'live' 或回放日期。 */
  mode: string;
  /** -1 開盤前、0 開盤、1～BARS−1。 */
  k: number;
  /** K 線的時間單位（分鐘）。 */
  tf: 1 | 3 | 5;
  /** 看哪個標的。 */
  asset?: IntraAsset;
  /** 看日 K（未來約三個月）而不是盤中。 */
  daily?: boolean;
  showActual: boolean;
  /** 相似日走勢線、預測 K 棒、80% 區間要不要畫。 */
  showAnalogs: boolean;
  /** 相似日淘汰賽（開盤時 30 天，偏離的逐一淘汰）。 */
  knockout?: boolean;
  showCandles: boolean;
  showBand: boolean;
  /** 進出場價位線。 */
  showLevels: boolean;
}

export function intradayHtml(d: IntradayData | null | undefined, st: IntradayState, live: { open: number | null; bars: Bar[]; ok: boolean; why: string; lNow?: number | null }, lib: AnalogDay[] | null): string {
  const tfBtns = `<div class="pd-tf pd-intra-tf" role="group" aria-label="K 線週期">${([5, 3, 1] as const).map((t) => `<button type="button" data-intra-tf="${t}" class="${!st.daily && st.tf === t ? 'is-on' : ''}">${t} 分 K</button>`).join('')}<button type="button" data-intra-daily="1" class="${st.daily ? 'is-on' : ''}">日 K</button></div>`;
  const asset: IntraAsset = st.asset ?? 'L';
  const NAME = ASSET_NAME[asset];
  const assetBtns = `<div class="pd-tf pd-intra-asset" role="group" aria-label="標的">${(['L', 'ix', 'tx'] as const).map((a) => `<button type="button" data-intra-asset="${a}" class="${asset === a ? 'is-on' : ''}">${ASSET_NAME[a]}</button>`).join('')}</div>`;
  const head = (badge: string) =>
    st.daily
      ? `<header class="pd-head"><div><p class="eyebrow">Daily · 日 K</p><h2>${NAME} 日 K：未來約三個月</h2></div>${badge}</header><div class="pd-intra-pick">${assetBtns}${tfBtns}</div>`
      : `<header class="pd-head"><div><p class="eyebrow">Intraday · ${STEP} 分 K</p><h2>${NAME} 整天 ${STEP} 分 K 預測線</h2></div>${badge}</header><div class="pd-intra-pick">${assetBtns}${tfBtns}</div>`;
  if (st.daily) return `<section class="pd-card glass" id="pd-intra">${head('')}<div id="pd-intra-daily"><p class="muted">載入日 K⋯⋯</p></div></section>`;
  if (d === undefined) return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">載入中⋯⋯</p></section>`;
  if (!d || !d.ready || !d.day)
    return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">正在收集加權指數 ${STEP} 分 K 的歷史資料（目前 ${d?.days ?? 0} 天，至少要 60 天才會開始訓練；每小時往回補一批）。</p></section>`;
  const vb = (v: Verdict, yes: string, no: string) => `<span class="pd-verdict ${v === 'signal' ? 'is-ok' : 'is-warn'}">${v === 'signal' ? `✅ ${yes}` : `⚠️ ${no}`}</span>`;
  const badges = `<div class="pd-badges">${vb(d.rangeVerdict, '振幅與高低點：盤中比簡單猜法準', '振幅與高低點沒有比簡單猜法準')}${vb(d.verdict, '漲跌方向有預測能力', '漲跌方向沒有預測能力')}</div>`;
  let v: View;
  if (st.mode === 'live' && live.ok) {
    const k = Math.min(BARS - 1, live.bars.length);
    v = { live: true, P0: d.next.P0, L0: d.next.L0, Lnow: live.lNow ?? null, ctx: ctxOf(d.next.ctx), ix: live.bars, open: live.open, k: live.open == null ? -1 : k, m: d.model, dm: d.day, choice: d.choice, plan: d.rangeTrade?.plan, ref: d.rangeTrade?.refPlan };
  } else {
    const day = d.recent.find((r) => r.date === st.mode) ?? d.recent[d.recent.length - 1];
    st.mode = day.date;
    const rp = d.replay;
    v = { live: false, P0: day.P0, L0: day.L0, Lday: day.Lday ?? null, ctx: ctxOf(day.ctx), ix: day.ix, open: day.ix[0][0], k: Math.max(-1, Math.min(BARS - 1, st.k)), m: rp?.m ?? d.model, dm: rp?.dm ?? d.day, choice: rp?.choice ?? d.choice, plan: d.rangeTrade?.replayPlan, ref: d.rangeTrade?.replayRef };
  }
  if (asset !== 'L') {
    const T0 = v.live ? d.next.T0 : d.recent.find((r) => r.date === st.mode)?.T0;
    v.L0 = null;
    v.T0 = asset === 'tx' ? (T0 ?? null) : null;
  }
  const f = forecastDay(v.m, v.dm, v.ix, v.k, v.k < 0 ? null : v.open, v.P0, v.ctx);
  // 相似日：只從這一天以前的日子找（回放時不會用到之後的資料）
  const viewDate = v.live ? '9999' : st.mode;
  const an: Analogs = lib && lib.length
    ? analogLines(
        lib.filter((a) => a.date < viewDate),
        { k: v.k, gap: v.k < 0 ? NaN : Math.log(f.open / v.P0), r: [f.open, ...v.ix.slice(0, Math.max(0, v.k)).map((b) => b[3])].map((x) => Math.log(x / f.open)), ctx: v.ctx },
        v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3],
        20,
        20,
      )
    : null;
  // 淘汰賽：開盤後才有（候選天數只看開盤前的條件，所以整天是同一批）
  const ko: KnockoutLine[] | null =
    st.knockout && v.k >= 0 && v.open != null && lib && lib.length ? knockout(lib.filter((a) => a.date < viewDate), v.ctx, [v.open, ...v.ix.slice(0, Math.max(0, v.k)).map((b) => b[3])], 30, undefined, 3, v.P0) : null;
  const L = convOf(v, d);
  const lev = v.L0 ? d.beta : 1;
  const last = f.bars[f.bars.length - 1];
  const now = v.k < 0 ? null : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  const err = dayErrors(d, v, f);
  const lerr = lineErrors(v, f, an, lev);
  // 上方的「預測收盤」用方向預測（主線，一定押方向）；沒有相似日資料時用綜合預測、模型主線
  const ser = lineSeries(v, f, an, choiceFor(v.choice, v.k));
  const mainSeries = ser.dir ?? ser.blend;
  const mainClose = mainSeries?.length ? mainSeries[mainSeries.length - 1][1] : last?.c;
  const actualClose = !v.live && v.ix.length === BARS ? v.ix[BARS - 1][3] : null;
  const opts = [
    `<option value="live" ${st.mode === 'live' ? 'selected' : ''} ${live.ok ? '' : 'disabled'}>今天（即時）${live.ok ? '' : `－${esc(live.why)}`}</option>`,
    ...[...d.recent].reverse().map((r) => `<option value="${r.date}" ${st.mode === r.date ? 'selected' : ''}>回放 ${r.date}</option>`),
  ].join('');
  const b = d.backtest;
  const pct2 = (x: number) => `${num(x * lev * 100, 2)}%`;
  return `<section class="pd-card glass" id="pd-intra">${head(badges)}
    <p class="pd-lead">白色粗線＝<b>方向預測</b>（一定押漲或押跌），開盤前先預測跳空，盤中每走完一根重新預測。下面的圖是它過去的方向命中率。</p>
    <details class="pd-more"><summary>各條線怎麼算的</summary><p class="pd-small">以 ${STEP} 分鐘為單位畫出整天（09:00～13:30，${BARS} 根）的預測線。<b>方向預測（主線，藍色粗線）</b>一定押一個方向：方向＝綜合預測最後是漲還是跌，形狀與幅度＝相似日裡最後也往這個方向走的那幾天的真實走勢平均，所以會有一般盤中該有的起伏；它的方向命中率列在下面的表。<b>模型主線</b>是統計上誤差最小的預測（沒把握時會接近平線）；<b>相似日走勢線</b>是從歷史裡找出到目前為止跟今天最像的幾天，把它們接下來的真實走勢（依波動比例縮放）接在現在的價格後面。
      開盤前先預測跳空，盤中每走完一根就重新預測。下面列出每條線過去的準確度。
      ${asset === 'L' ? `00631L 的價格用「加權指數 × ${num(d.beta, 2)} 倍」換算（近一年日報酬估計）。` : asset === 'tx' ? `台指期（近月、日盤）的價位用「加權指數 × 前一天收盤時的期貨 ÷ 現貨」換算：盤中期貨跟現貨幾乎同步，差的是價差（逆價差、正價差）會慢慢變；夜盤（15:00～05:00）沒有現貨，不在這個預測裡。${v.T0 ? '' : '<b>（這一天沒有臺指期收盤資料，先顯示加權指數）</b>'}` : '直接預測加權指數（點數）。'}</p></details>
    <div class="pd-intra-ctrl">
      <label>看哪一天<select id="pd-intra-day">${opts}</select></label>
      ${v.live ? `<span class="muted">每 30 秒更新</span>` : `<span class="muted pd-small">回放用的是 ${esc(d.recent[0]?.date ?? '')} 之前訓練的模型，沒看過這幾天的答案</span>`}
      ${v.live ? '' : `<label class="pd-intra-k">預測時間 <b class="num" id="pd-intra-clock">${kLabel(v.k)}</b><input type="range" id="pd-intra-k" min="-1" max="${BARS - 1}" step="1" value="${v.k}" /></label>
      <label class="pd-check"><input type="checkbox" id="pd-intra-actual" ${st.showActual ? 'checked' : ''} />疊上實際走勢</label>`}
    </div>
    <div class="pd-intra-ctrl pd-intra-opts">
      <label class="pd-check"><input type="checkbox" data-opt="showAnalogs" ${st.showAnalogs ? 'checked' : ''} />相似日走勢線</label>
      <label class="pd-check"><input type="checkbox" data-opt="knockout" ${st.knockout ? 'checked' : ''} />相似日淘汰賽${v.k < 0 ? '<small class="muted">（開盤後開始）</small>' : ''}</label>
      <label class="pd-check"><input type="checkbox" data-opt="showCandles" ${st.showCandles ? 'checked' : ''} />主線畫成 K 棒</label>
      <label class="pd-check"><input type="checkbox" data-opt="showBand" ${st.showBand ? 'checked' : ''} />80% 區間</label>
      <label class="pd-check"><input type="checkbox" data-opt="showLevels" ${st.showLevels ? 'checked' : ''} />進出場點</label>
    </div>
    <dl class="pd-stats pd-intra-stats">
      <div><dt>預測時間</dt><dd class="num">${kLabel(v.k)}</dd></div>
      <div><dt>${now == null ? '預測開盤' : '現在'}</dt><dd class="num">${num(L(now ?? f.open), 2)}${now == null ? ` <small class="${cls(f.open - v.P0)}">${pctTxt(L(f.open) / L(v.P0) - 1)}</small>` : v.live && v.Lnow ? ' <small class="muted">00631L 實價；預測線從這裡出發</small>' : ''}</dd></div>
      <div><dt>${v.k >= 0 ? '預測收盤<small class="muted">（開盤後方向沒把握，回測約 52～57%）</small>' : '預測收盤（方向預測）'}</dt><dd class="num ${v.k >= 0 ? '' : cls((mainClose ?? v.P0) - v.P0)}">${mainClose ? num(L(mainClose), 2) : '—'} <small>${mainClose ? pctTxt(L(mainClose) / L(v.P0) - 1) : ''}</small></dd></div>
      <div><dt>收盤約 80% 區間</dt><dd class="num">${last ? `${num(L(last.lo), 2)}～${num(L(last.hi), 2)}` : '—'}</dd></div>
      <div><dt>預估今日最高／最低</dt><dd class="num"><span class="up">${num(L(f.dayHigh), 2)}</span>／<span class="down">${num(L(f.dayLow), 2)}</span></dd></div>
      ${actualClose != null ? (v.L0 && v.Lday ? `<div><dt>實際收盤／最高／最低<small class="muted">（00631L 實價）</small></dt><dd class="num">${num(v.Lday[3], 2)} <small>${num(v.Lday[1], 2)}／${num(v.Lday[2], 2)}</small></dd></div>` : `<div><dt>實際收盤／最高／最低</dt><dd class="num">${num(L(actualClose), 2)} <small>${num(L(Math.max(...v.ix.map((x) => x[1]))), 2)}／${num(L(Math.min(...v.ix.map((x) => x[2]))), 2)}</small></dd></div>`) : ''}
    </dl>
    ${chart(d, v, f, st, an, ko)}
    ${dayVerdict(lerr, err)}
    ${asset === 'L' ? rangeHtml(d, v) : ''}
    ${hitChart(d)}
    ${forwardHtml(d, lev)}
    <details class="pd-more"><summary>詳細回測數字（各條線、最近 20 天、振幅與區間）</summary>
    ${linesTable(d, lev)}
    ${recordTable(d, lev)}
    <h3 class="pd-sub">振幅、高低點與 80% 區間的回測（${b.from} ～ ${b.to}，${num(b.days)} 天，樣本外；誤差換算成 ${NAME}）</h3>
    <div class="pd-table-wrap"><table class="pd-table">
      <thead><tr><th>預測時間</th><th class="num">每根收盤誤差<br><small>模型／不會動</small></th><th class="num">80% 區間<br><small>實際涵蓋</small></th><th class="num">每根振幅誤差<br><small>模型／時段平均</small></th><th class="num">今日高低點誤差<br><small>模型／平均幅度</small></th></tr></thead>
      <tbody>${b.byOrigin
        .map(
          (x) => `<tr><td>${esc(x.label)}</td>
          <td class="num"><b class="${x.pathRmse < x.pathNaive ? 'up' : ''}">${pct2(x.pathRmse)}</b>／${pct2(x.pathNaive)}</td>
          <td class="num">${num(x.coverage * 100, 0)}%</td>
          <td class="num"><b class="${x.rangeMae < x.rangeNaive ? 'up' : ''}">${pct2(x.rangeMae)}</b>／${pct2(x.rangeNaive)}</td>
          <td class="num"><b class="${x.hlMae < x.hlNaive ? 'up' : ''}">${pct2(x.hlMae)}</b>／${pct2(x.hlNaive)}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <p class="pd-note">誤差越小越好；粗體標紅的是比簡單猜法準的項目。<b>K 棒的振幅、今天的高低點</b>有時段特性（開盤與收盤前最大）跟波動延續，可以預測得比平均準；
      <b>漲跌方向</b>幾乎無法預測，所以誤差最小的預測線會很平滑、貼近現價，預測 K 棒的實體會很小、主要看影線（振幅）與區間。
      80% 區間的實際涵蓋接近 80% 代表區間畫得準。5 分 K 正在往前回補到 2020 年，資料越多模型越穩定；每天部署時都會用最新資料重新訓練。</p>
    </details>
    ${logicHtml(d)}
  </section>`;
}
