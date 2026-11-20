/**
 * 00631L 整天 5 分 K 預測（部署時執行，不連網）：
 *
 *   node scripts/predict-intraday.ts <資料資料夾>
 *
 * - 資料：加權指數 5 分 K（intraday/，證交所每 5 秒指數統計）＋日 K＋外資期貨。
 * - 模型（特徵與預測在 web/src/domain/intradayModel.ts，網頁共用）：
 *   收盤走勢（1／2／3／6／12 根與到收盤）、每根 K 棒的振幅、剩下時間的最高最低點、開盤跳空，各一組嶺迴歸。
 *   每次訓練時把訓練資料最後 20% 留做驗證，從幾個正則化強度裡挑誤差最小的，再用全部訓練資料重新訓練。
 * - 回測：逐段往前滾（每 20 個交易日重新訓練、只用之前的日子），在開盤前、開盤、10:00、11:00、12:00、13:00
 *   各做一次整天預測，跟最簡單的猜法（不會動、時段平均振幅、平均高低點）比誤差。
 * - 00631L 沒有公開的歷史盤中資料，用「β × 加權指數報酬」換算（β 用近一年日 K 估）。
 *
 * 輸出 predict-intraday.json：模型、回測、最近 10 天（回放用）。
 *
 * TF＝3 或 1：改用 3 分 K（ix3，90 根）或 1 分 K（ix1，270 根），輸出 predict-intraday-3m.json／-1m.json。
 * 預測長度、特徵的回看長度都以分鐘定義（見 setTimeframe），訓練時每 5 分鐘取一個時間點（速度跟 5 分 K 差不多）。
 * 事前存檔、實盤成績、區間進出場只做 5 分 K。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BARS,
  HORIZONS,
  barRange,
  excursionFeatures,
  features,
  forecastDay,
  gapFeatures,
  horizonScale,
  rangeFeatures,
  PATH_GROUPS,
  GAP_GROUPS,
  volScale,
  windowVol,
  analogLines,
  rangeLevels,
  simulateRange,
  DAYTRADE_COST,
  type RangePlan,
  avgOf,
  blendLine,
  ANALOG_NS,
  BLEND_WS,
  type AnalogDay,
  TIME_BUCKETS,
  timeBucket,
  type Bar,
  type DailyCtx,
  type DayModel,
  type IntradayModel,
  type LinModel,
  DISC_SLOTS,
  discCandidates,
  discValue,
  rawBlocks,
  discName,
  nb,
  setTimeframe,
  type DiscSpec,
} from '../web/src/domain/intradayModel.ts';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { canArchive, readPreOpen, writeArchive } from './lib/archive.ts';
import { loadUs, usMove } from './lib/us.ts';
import { loadTx, nightBar, nightMove } from './lib/txNight.ts';
import { mean, ridge, standardizer, std } from './lib/ml.ts';

const dir = process.argv[2] ?? 'data';
const TF = Number(process.env.TF ?? 5) as 1 | 3 | 5;
if (TF !== 5) setTimeframe(TF);
const IXKEY = TF === 5 ? 'ix' : TF === 3 ? 'ix3' : 'ix1';
const SUF = TF === 5 ? '' : `-${TF}m`;
/** 訓練時每隔幾根取一個時間點（約每 5 分鐘一個）。 */
const KS = nb(5);
const read = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
const r5 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : null);
const t0 = Date.now();
const LAMBDAS = [0.001, 0.01, 0.1, 1];

// ---------------------------------------------------------------- 日 K、外資期貨
const taiex = read<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []);
const dIdx = new Map(taiex.map((r, i) => [r[0], i]));
const fut = new Map<string, number>();
for (const r of read<{ rows: Array<[string, unknown, unknown, unknown, unknown, number | null]> }>(join(dir, 'market-risk.json'), { rows: [] }).rows) if (r[5] != null) fut.set(r[0], r[5]);

// 只存檔（ARCHIVE_ONLY）而且不在存檔時間內：不用算（整套要跑幾分鐘）
if (process.env.ARCHIVE_ONLY && !canArchive(taiex[taiex.length - 1][0], Date.now(), !!process.env.ARCHIVE_KIND_SUFFIX)) {
  console.log(`事前存檔：現在不是 ${taiex[taiex.length - 1][0]} 收盤後到下一個交易日開盤前，不算`);
  process.exit(0);
}
const usData = loadUs(dir);
const txData = loadTx(dir);
/** 第 i 天開盤前看得到的資料。 */
function dailyCtx(i: number): DailyCtx | null {
  if (i < 6) return null;
  const c = (j: number) => taiex[j][4];
  const f1 = fut.get(taiex[i - 1][0]);
  const f2 = fut.get(taiex[i - 2][0]);
  return {
    prevDay: Math.log(c(i - 1) / c(i - 2)),
    prev5: Math.log(c(i - 1) / c(i - 6)),
    prevIntra: Math.log(c(i - 1) / taiex[i - 1][1]),
    futChg: f1 != null && f2 != null ? (f1 - f2) / 1e4 : NaN,
    prevRange: Math.log(taiex[i - 1][2] / taiex[i - 1][3]),
    // 前一晚美股：上一個台股交易日（含）到今天（不含）之間收盤的美股；i＝最後＋1 時是「下一個交易日」
    usSox: usMove(usData.SOX, taiex[i - 1][0], taiex[i]?.[0] ?? '9999-12-31'),
    usTsm: usMove(usData.TSM, taiex[i - 1][0], taiex[i]?.[0] ?? '9999-12-31'),
    usSpx: usMove(usData.GSPC, taiex[i - 1][0], taiex[i]?.[0] ?? '9999-12-31'),
    night: nightMove(txData, taiex[i - 1][0], taiex[i]?.[0] ?? null),
    usVix: usMove(usData.VIX, taiex[i - 1][0], taiex[i]?.[0] ?? '9999-12-31'),
    ...nightShape(nightBar(txData, taiex[i - 1][0], taiex[i]?.[0] ?? null)),
  };
}
function nightShape(n: number[] | null): { nightRange: number; nightPos: number } {
  if (!n || !(n[1] > 0) || !(n[2] > 0)) return { nightRange: NaN, nightPos: NaN };
  return { nightRange: Math.log(n[1] / n[2]), nightPos: n[1] > n[2] ? (n[3] - n[2]) / (n[1] - n[2]) : 0.5 };
}

// ---------------------------------------------------------------- 5 分 K
interface Day {
  date: string;
  P0: number;
  c: number[]; // c[0]＝開盤、c[k]＝第 k 根收盤
  ix: Bar[];
  ctx: DailyCtx;
}
const idir = join(dir, 'intraday');
const days: Day[] = [];
for (const f of existsSync(idir) ? readdirSync(idir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []) {
  const date = f.slice(0, 10);
  const i = dIdx.get(date);
  if (i == null || i < 6) continue;
  const j = read<Record<string, Bar[] | undefined>>(join(idir, f), {});
  const ix = j[IXKEY];
  if (!ix || ix.length !== BARS) continue;
  days.push({ date, P0: taiex[i - 1][4], ix, c: [ix[0][0], ...ix.map((b) => b[3])], ctx: dailyCtx(i)! });
}
const analogOf = (d: Day): AnalogDay => ({ date: d.date, gap: Math.log(d.c[0] / d.P0), r: d.c.map((v) => Math.log(v / d.c[0])), ctx: d.ctx });
const lib: AnalogDay[] = days.map(analogOf);
console.log(`${TF} 分 K：${days.length} 天（${days[0]?.date ?? '—'} ～ ${days.at(-1)?.date ?? '—'}）`);
if (days.length < 60) {
  writeFileSync(join(dir, `predict-intraday${SUF}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), ready: false, days: days.length, tf: TF }));
  console.log('資料還不夠（少於 60 天），先輸出空的結果');
  process.exit(0);
}

// ---------------------------------------------------------------- 訓練工具
/** 樣本：特徵、目標（每一天一組，方便切驗證集）。 */
type Samples = Array<{ X: number[][]; y: number[] }>;
/** 用最後 20% 的日子挑 λ（驗證誤差最小），再用全部重新訓練。 */
/**
 * 用最後 20% 的日子挑 λ 與「要用哪些資料」（驗證誤差最小），再用全部重新訓練。
 * groups：可以整組拿掉的特徵（例如美股、夜盤）；不用的那組係數為 0。模型每次訓練自己決定，資料有用就用、沒用就不用。
 */
function fitLin(byDay: Samples, groups: Record<string, readonly number[]> = {}): LinModel & { lambda: number; use: string[] } {
  const flat = (s: Samples) => ({ X: s.flatMap((d) => d.X), y: s.flatMap((d) => d.y) });
  const names = Object.keys(groups);
  // 所有組合：每一組用或不用
  const masks = Array.from({ length: 1 << names.length }, (_, b) => names.filter((_, i) => b & (1 << i)));
  const dropOf = (use: string[]) => new Set(names.filter((n) => !use.includes(n)).flatMap((n) => groups[n]));
  const zap = (z: number[], drop: Set<number>) => (drop.size ? z.map((v, j) => (drop.has(j) ? 0 : v)) : z);
  const cut = Math.floor(byDay.length * 0.8);
  const tr = flat(byDay.slice(0, cut));
  const va = flat(byDay.slice(cut));
  let best = { lambda: LAMBDAS[1], use: names, err: Infinity };
  if (tr.X.length > 50 && va.X.length > 10) {
    const st = standardizer(tr.X);
    const Zt0 = tr.X.map(st.apply);
    const Zv0 = va.X.map(st.apply);
    for (const use of masks) {
      const drop = dropOf(use);
      const Zt = Zt0.map((z) => zap(z, drop));
      const Zv = Zv0.map((z) => zap(z, drop));
      for (const lambda of LAMBDAS) {
        const b = ridge(Zt, tr.y, lambda);
        let err = 0;
        Zv.forEach((z, i) => (err += (va.y[i] - (b[0] + z.reduce((s, v, j) => s + b[j + 1] * v, 0))) ** 2));
        if (err < best.err) best = { lambda, use, err };
      }
    }
  }
  const all = flat(byDay);
  const st = standardizer(all.X);
  const drop = dropOf(best.use);
  return { mean: st.mean, sd: st.sd, coef: ridge(all.X.map((x) => zap(st.apply(x), drop)), all.y, best.lambda), lambda: best.lambda, use: best.use };
}
const target = (d: Day, k: number, h: number) => Math.log(d.c[h === BARS ? BARS : Math.min(BARS, k + h)] / d.c[k]);
const validK = (k: number, h: number) => (h === BARS ? k < BARS : k + h <= BARS);

// ---------------------------------------------------------------- 自創指標
/**
 * 從約 1400 個候選組合裡，挑出最能解釋「基本模型預測不到的部分」的幾個（只用訓練資料）。
 * 1. 用基本特徵做一個簡單的線性模型，算出「到收盤」與「之後 30 分鐘」的殘差；
 * 2. 每個候選指標跟殘差的關係換成 t 值（以天為單位計算，同一天的樣本互相相關，不會高估）；
 * 3. |t| > DISC_T 才算數（候選很多，門檻要高，避免挑到運氣），而且跟已經挑的不能太像（相關 < 0.7），最多 DISC_SLOTS 個。
 */
const DISC_ON = process.env.DISC !== '0';
const DISC_T = Number(process.env.DISC_T ?? 4);
const CANDS = discCandidates();
function discover(train: Day[]): { disc: DiscSpec[]; t: number[] } {
  if (!DISC_ON || train.length < 120) return { disc: [], t: [] };
  const X: number[][] = [];
  const R: number[][] = [];
  const ys: number[][] = [[], []];
  const dayOf: number[] = [];
  for (const [di, d] of train.entries())
    for (let k = 0; k < BARS; k += nb(15)) {
      dayOf.push(di);
      X.push(features(d.c, k, d.P0, d.ctx));
      R.push(rawBlocks(d.c, k, d.P0, d.ctx));
      ys[0].push(target(d, k, BARS) / horizonScale(BARS, k));
      ys[1].push(validK(k, nb(30)) ? target(d, k, nb(30)) : NaN);
    }
  const st = standardizer(X);
  const Z = X.map(st.apply);
  const res = ys.map((y) => {
    const ok = y.map((v) => Number.isFinite(v));
    const b = ridge(Z.filter((_, i) => ok[i]), y.filter((_, i) => ok[i]), 10);
    return y.map((v, i) => (ok[i] ? v - (b[0] + Z[i].reduce((s, z, j) => s + b[j + 1] * z, 0)) : NaN));
  });
  const n = X.length;
  // 候選指標：標準化、截斷在 ±4、沒有值當 0
  const col = (s: DiscSpec): Float64Array | null => {
    const v = new Float64Array(n);
    let sm = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      v[i] = discValue(R[i], s);
      if (Number.isFinite(v[i])) (sm += v[i]), c++;
    }
    if (c < n * 0.5) return null;
    const mu = sm / c;
    let ss = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(v[i])) ss += (v[i] - mu) ** 2;
    const sd = Math.sqrt(ss / c);
    if (!(sd > 0)) return null;
    for (let i = 0; i < n; i++) v[i] = Number.isFinite(v[i]) ? Math.max(-4, Math.min(4, (v[i] - mu) / sd)) : 0;
    return v;
  };
  const corr = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, c = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(b[i])) continue;
      sa += a[i]; sb += b[i]; sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; c++;
    }
    const cov = sab / c - (sa / c) * (sb / c);
    const va = saa / c - (sa / c) ** 2;
    const vb = sbb / c - (sb / c) ** 2;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
  };
  // t 值以「天」為單位（同一天的樣本互相相關）：每天加總 指標×殘差，t＝Σ ÷ √Σ²
  const rMean = res.map((r) => mean(r.filter(Number.isFinite)));
  const tOf = (v: Float64Array, hi: number) => {
    const r = res[hi];
    let vm = 0, c = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(r[i])) (vm += v[i]), c++;
    vm /= c || 1;
    let s = 0, ss = 0, cur = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(r[i])) cur += (v[i] - vm) * (r[i] - rMean[hi]);
      if (i === n - 1 || dayOf[i + 1] !== dayOf[i]) (s += cur), (ss += cur * cur), (cur = 0);
    }
    return ss > 0 ? s / Math.sqrt(ss) : 0;
  };
  const scored: Array<{ s: DiscSpec; t: number; v: Float64Array }> = [];
  for (const s of CANDS) {
    const v = col(s);
    if (!v) continue;
    const ts = [tOf(v, 0), tOf(v, 1)];
    const t = Math.abs(ts[0]) >= Math.abs(ts[1]) ? ts[0] : ts[1];
    if (Math.abs(t) > DISC_T) scored.push({ s, t, v });
  }
  scored.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  if (process.env.DISC_PROBE) for (const c of scored.slice(0, 15)) console.log(`  t=${c.t.toFixed(2)}  ${discName(c.s)}`);
  const pick: typeof scored = [];
  for (const c of scored) {
    if (pick.length >= DISC_SLOTS) break;
    if (pick.every((p) => Math.abs(corr(p.v, c.v)) < 0.7)) pick.push(c);
  }
  return { disc: pick.map((p) => p.s), t: pick.map((p) => Math.round(p.t * 10) / 10) };
}

// 診斷用：只看開發期間（2025-11-03 起，見 DEV_START）的資料，列出最強的候選（不影響模型；「從沒看過的期間」不碰）
if (process.env.DISC_PROBE) {
  const pre = days.filter((d) => d.date >= '2025-11-03');
  console.log(`自創指標候選（${pre.length} 天，${pre[0]?.date} ～ ${pre.at(-1)?.date}）：`);
  discover(pre);
  process.exit(0);
}

function fitAll(train: Day[]): { m: IntradayModel & { inRes?: number[][] }; dm: DayModel; lambdas: Record<string, number>; used: Record<string, string[]> } {
  const lambdas: Record<string, number> = {};
  const used: Record<string, string[]> = {};
  const { disc, t: discT } = discover(train);
  // 收盤走勢：每個長度一組
  const path = HORIZONS.map((h) => {
    const fit = fitLin(train.map((d) => {
      const X: number[][] = [];
      const y: number[] = [];
      for (let k = 0; k < BARS; k += KS) if (validK(k, h)) X.push(features(d.c, k, d.P0, d.ctx, disc)), y.push(target(d, k, h) / horizonScale(h, k));
      return { X, y };
    }), disc.length ? PATH_GROUPS : { us: PATH_GROUPS.us, night: PATH_GROUPS.night });
    used[`path${h}`] = fit.use;
    lambdas[`path${h}`] = fit.lambda;
    return fit;
  });
  // 各長度共用同一組標準化（網頁的 predictAt 這樣算）：用第一組的 mean／sd，係數換算到同一組尺度
  const st0 = path[0];
  const coef = path.map((p) => {
    // z_p = (x - mean_p)/sd_p = (z0*sd0 + mean0 - mean_p)/sd_p
    const out = [p.coef[0]];
    for (let j = 0; j < p.mean.length; j++) {
      const a = st0.sd[j] / (p.sd[j] || 1);
      const b = (st0.mean[j] - p.mean[j]) / (p.sd[j] || 1);
      out.push(p.coef[j + 1] * a);
      out[0] += p.coef[j + 1] * b;
    }
    return out;
  });
  const m: IntradayModel = { mean: st0.mean, sd: st0.sd, coef, resid: HORIZONS.map(() => new Array(TIME_BUCKETS).fill(0)), disc, discT };
  const inSampleResid = () => m.resid; // 振幅模型訓練好後再算（要用波動倍率）
  // 振幅：每個時段的平均，再預測比平均大多少
  const base = Array.from({ length: BARS }, (_, b) => mean(train.map((d) => Math.log(barRange(d.ix[b])))));
  const rng = fitLin(train.map((d) => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let k = 0; k < BARS; k += nb(15)) for (let j = k; j < BARS; j += KS) X.push(rangeFeatures(d.ix, k, j, d.c[0], d.P0, d.ctx, base)), y.push(Math.log(barRange(d.ix[j])) - base[j]);
    return { X, y };
  }));
  // 剩下時間的最高、最低
  const ex = (dirn: 1 | -1) =>
    fitLin(train.map((d) => {
      const X: number[][] = [];
      const y: number[] = [];
      for (let k = 0; k < BARS; k += KS) {
        let e = 0;
        for (let b = k; b < BARS; b++) e = Math.max(e, dirn > 0 ? Math.log(d.ix[b][1] / d.c[k]) : Math.log(d.c[k] / d.ix[b][2]));
        X.push(excursionFeatures(d.ix, d.c, k, d.P0, d.ctx, base));
        y.push(e);
      }
      return { X, y };
    }));
  const up = ex(1);
  const down = ex(-1);
  const gap = fitLin(train.map((d) => ({ X: [gapFeatures(d.ctx)], y: [Math.log(d.c[0] / d.P0)] })), GAP_GROUPS);
  used.gap = gap.use;
  // 跳空的誤差（訓練資料內；開盤前的區間要加上它）
  const gapSd = std(train.map((d) => Math.log(d.c[0] / d.P0) - (gap.coef[0] + gapFeatures(d.ctx).reduce((s, v, j) => s + gap.coef[j + 1] * (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - gap.mean[j]) / (gap.sd[j] || 1))) : 0), 0))));
  Object.assign(lambdas, { rng: rng.lambda, up: up.lambda, down: down.lambda, gap: gap.lambda });
  const strip = ({ mean, sd, coef }: LinModel) => ({ mean, sd, coef });
  // 訓練資料內的殘差（除以波動倍率）：樣本外殘差還不夠時當備案
  const dmTmp = { base, rng: strip(rng), up: strip(up), down: strip(down), gap: strip(gap), gapSd };
  const rb = HORIZONS.map(() => Array.from({ length: TIME_BUCKETS }, () => [] as number[]));
  for (const d of train.filter((_, i) => i % 3 === 0))
    for (let k = 0; k < BARS; k += KS) {
      const z = features(d.c, k, d.P0, d.ctx, m.disc).map((v, j) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - m.mean[j]) / (m.sd[j] || 1))) : 0));
      const sc = volScale(dmTmp, d.ix, k, d.c[0], d.P0, d.ctx);
      HORIZONS.forEach((h, hi) => {
        if (!validK(k, h)) return;
        const p = (m.coef[hi][0] + z.reduce((s, v, j) => s + m.coef[hi][j + 1] * v, 0)) * horizonScale(h, k);
        rb[hi][timeBucket(k)].push((target(d, k, h) - p) / sc / windowVol(base, k, h === BARS ? BARS - k : h));
      });
    }
  m.resid = rb.map((row) => row.map((e) => (e.length > 10 ? std(e) : 0.5)));
  void inSampleResid;
  return { m, dm: { base, rng: strip(rng), up: strip(up), down: strip(down), gap: strip(gap), gapSd }, lambdas, used };
}

// ---------------------------------------------------------------- 00631L 日 K（槓桿倍數）
const exDays = new Set<string>();
for (const f of existsSync(join(dir, 'exrights')) ? readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) if (r[1] === '00631L') exDays.add(r[0]);
const lRaw = read<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', '00631L.json'), []);
const lBars = lRaw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
const lAdj = adjustForSplits(lBars, detectSplits(lBars, exDays), '9999-12-31');
const lClose = new Map(lAdj.map((b) => [b.date, b.close]));
/** 00631L 對加權指數的槓桿倍數：用第 end 天（不含）以前 250 個交易日的日報酬估（回測時不偷看之後的資料）。 */
function betaBefore(end: number): number {
  let sxy = 0;
  let sxx = 0;
  for (let i = Math.max(1, end - 250); i < end; i++) {
    const a = lClose.get(taiex[i][0]);
    const b = lClose.get(taiex[i - 1][0]);
    if (!a || !b) continue;
    const x = Math.log(taiex[i][4] / taiex[i - 1][4]);
    sxy += x * Math.log(a / b);
    sxx += x * x;
  }
  return sxx > 1e-6 ? sxy / sxx : 2;
}
const beta = betaBefore(taiex.length);

// ---------------------------------------------------------------- 逐段往前滾回測
const FIRST = Math.min(250, Math.floor(days.length / 2));
const REFIT = 20;
const ORIGINS = [-1, 0, nb(60), nb(120), nb(180), nb(240)]; // 開盤前、開盤、10:00、11:00、12:00、13:00
const ORIGIN_LABEL: Record<number, string> = { [-1]: '開盤前', 0: '09:00 開盤', [nb(60)]: '10:00', [nb(120)]: '11:00', [nb(180)]: '12:00', [nb(240)]: '13:00' };
type Acc = { pe: number[]; pn: number[]; cov: number; covN: number; re: number[]; rn: number[]; rl: number[]; rlb: number[]; he: number[]; hn: number[] };
/**
 * 成績分期間記：開發期間（我調整模型時看過的回測，從 DEV_START 起）與「從沒看過的期間」（之前回補的歷史）。
 * 開發期間的成績可能偏樂觀；沒看過的期間才是公正的成績。
 */
const DEV_START = '2025-11-03';
type Period = 'all' | 'hold' | 'dev';
const PERIODS: Period[] = ['all', 'hold', 'dev'];
const newAcc = (): Record<number, Acc> => Object.fromEntries(ORIGINS.map((o) => [o, { pe: [], pn: [], cov: 0, covN: 0, re: [], rn: [], rl: [], rlb: [], he: [], hn: [] }]));
const accBy: Record<Period, Record<number, Acc>> = { all: newAcc(), hold: newAcc(), dev: newAcc() };
const acc = accBy.all;
/** 同時寫進「全部」與所屬期間的累計器（陣列 push 兩邊、數字 += 兩邊）。 */
function tee<T extends object>(a: T, b: T): T {
  return new Proxy(a, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (Array.isArray(v)) return { push: (...xs: unknown[]) => (v.push(...xs), ((b as Record<string | symbol, unknown[]>)[k]).push(...xs)) };
      return v;
    },
    set(t, k, val) {
      const rec = t as Record<string | symbol, number>;
      const d = (val as number) - rec[k];
      rec[k] = val as number;
      (b as Record<string | symbol, number>)[k] += d;
      return true;
    },
  });
}
const periodOf = (date: string): Period => (date >= DEV_START ? 'dev' : 'hold');
// 樣本外殘差（收盤走勢），給網頁畫區間
const residBy = HORIZONS.map(() => Array.from({ length: TIME_BUCKETS }, () => [] as number[]));
let fitted: ReturnType<typeof fitAll> | null = null;
// 「平均高低點」的猜法：訓練資料裡各時間點剩下時間的平均最高、最低
let avgEx: { up: number[]; down: number[] } | null = null;
const lambdaLog: Record<string, number[]> = {};
// 各種預測線的成績：[時間點][線] → 平方誤差、筆數、收盤方向猜對、最接近實際的次數
const LINES = ['blend', 'model', 'avg', 'a1', 'a2', 'a3'] as const;
// 自動挑設定：每個時間點、每組（相似日天數 n、模型權重 w）到前一天為止的累計平方誤差
const choiceSE: Record<number, Map<string, number>> = Object.fromEntries(ORIGINS.map((o) => [o, new Map<string, number>()]));
const choiceDays: Record<number, number> = Object.fromEntries(ORIGINS.map((o) => [o, 0]));
/** 到目前為止誤差最小的設定（累計不到 20 天時用預設：5 天、全部給模型）。 */
function bestChoice(o: number): { n: number; w: number } {
  if (choiceDays[o] < 20) return { n: 5, w: 1 };
  let best = { n: 5, w: 1, se: Infinity };
  for (const [key, se] of choiceSE[o]) if (se < best.se) best = { n: Number(key.split('|')[0]), w: Number(key.split('|')[1]), se };
  return best;
}
const choiceLog: Record<number, Array<{ n: number; w: number }>> = Object.fromEntries(ORIGINS.map((o) => [o, []]));
type LineAcc = Record<number, Record<string, { se: number; n: number; hit: number; days: number; best: number }>>;
const newLineAcc = (): LineAcc => Object.fromEntries(ORIGINS.map((o) => [o, Object.fromEntries(LINES.map((l) => [l, { se: 0, n: 0, hit: 0, days: 0, best: 0 }]))]));
const lineAccBy: Record<Period, LineAcc> = { all: newLineAcc(), hold: newLineAcc(), dev: newLineAcc() };
const lineAcc = lineAccBy.all;
// 回放用的模型：回放的最後 10 天開始之前那一刻的模型與設定（回放時不會看到答案）
const REPLAY = 10;
let replaySnap: { m: IntradayModel; dm: DayModel; choice: Array<{ origin: number; n: number; w: number }> } | null = null;
// 預測紀錄：開盤前與 10:00 的預測收盤 vs 實際
const record: Array<{ date: string; origin: number; ref: number; blend: number; model: number; avg: number; actual: number }> = [];
// 00631L 當天進出場（區間來回）：每一組設定每天的淨損益，挑「到昨天為止」賺最多的那組來用
const RANGE_PLANS: RangePlan[] = [];
for (const k of TF === 5 ? [6, 12] : []) for (const e of [0.4, 0.6, 0.8, 1]) for (const tp of [0.5, 1, 1.5]) for (const sl of [0.5, 1]) for (const m of [0, 1, 2]) RANGE_PLANS.push({ k, e, tp, sl, m });
// 「今天不交易」也是選項：過去怎麼做都虧時，模型應該選擇不交易
RANGE_PLANS.push({ k: 6, e: 1, tp: 1, sl: 1, m: Infinity });
const RANGE_DEFAULT = Math.max(0, RANGE_PLANS.findIndex((p) => p.k === 6 && p.e === 0.8 && p.tp === 1 && p.sl === 1 && p.m === 1));
const rangeCum = new Array(RANGE_PLANS.length).fill(0);
const rangeSq = new Array(RANGE_PLANS.length).fill(0);
let rangeDays = 0;
const NO_TRADE = RANGE_PLANS.length - 1;
/**
 * 挑設定：從 145 組裡挑過去賺最多的，常常只是運氣好。所以要求它過去每天的損益在統計上明顯大於 0
 * （t 值 > 2）才出手，否則就「今天不交易」。
 */
const bestRange = () => {
  if (rangeDays < 40) return NO_TRADE;
  const bi = rangeCum.reduce((b, v, i, a) => (v > a[b] ? i : b), 0);
  const m = rangeCum[bi] / rangeDays;
  const sd = Math.sqrt(Math.max(1e-12, rangeSq[bi] / rangeDays - m * m));
  return (m / sd) * Math.sqrt(rangeDays) > 2 ? bi : NO_TRADE;
};
const rangeRows: Array<{ date: string; plan: number; side: number; entryBar: number; exitBar: number; how: string; pnl: number; hold: number }> = [];
let replayRange = RANGE_DEFAULT;
let replayRef = RANGE_DEFAULT;
const dbg: number[][] = [];
for (let n = FIRST; n < days.length; n++) {
  if (!fitted || (n - FIRST) % REFIT === 0) {
    const train = days.slice(0, n);
    fitted = fitAll(train);
    for (const [k, v] of Object.entries(fitted.lambdas)) (lambdaLog[k] ??= []).push(v);
    avgEx = { up: [], down: [] };
    // 每個時間點之後的最高、最低（從後面往前算，1 分 K 也快）
    const su = new Array(BARS).fill(0);
    const sd = new Array(BARS).fill(0);
    for (const d of train) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = BARS - 1; k >= 0; k--) {
        hi = Math.max(hi, d.ix[k][1]);
        lo = Math.min(lo, d.ix[k][2]);
        su[k] += Math.log(hi / d.c[k]);
        sd[k] += Math.log(d.c[k] / lo);
      }
    }
    for (let k = 0; k < BARS; k++) avgEx.up.push(su[k] / train.length), avgEx.down.push(sd[k] / train.length);
  }
  const { m, dm } = fitted;
  const d = days[n];
  // 區間用「之前的日子」累積的樣本外殘差（今天的還沒加進去）
  const inRes = fitted.m.inRes ?? (fitted.m.inRes = m.resid.map((r) => r.slice()));
  m.resid = residBy.map((row, hi) => row.map((e, tb) => (e.length > 30 ? std(e) : inRes[hi][tb])));
  if (n === days.length - REPLAY) replaySnap = JSON.parse(JSON.stringify({ m, dm, choice: ORIGINS.map((o) => ({ origin: o, ...bestChoice(o) })) }));
  for (const o of ORIGINS) {
    const k = Math.max(0, o);
    const f = forecastDay(m, dm, d.ix, o, o < 0 ? null : d.c[0], d.P0, d.ctx);
    const per = periodOf(d.date);
    const a = tee(acc[o], accBy[per][o]);
    const ref = o < 0 ? d.P0 : d.c[k]; // 「不會動」的猜法：開盤前用昨收，盤中用現價
    // 相似日：只能從之前的日子找
    {
      const today = { k: o, gap: o < 0 ? NaN : Math.log(d.c[0] / d.P0), r: d.c.slice(0, k + 1).map((v) => Math.log(v / d.c[0])), ctx: d.ctx };
      const an = analogLines(lib.slice(0, n), today, o < 0 ? d.P0 : d.c[k], 20, 20);
      const modelCloses = o < 0 ? [f.open, ...f.bars.map((b) => b.c)] : f.bars.map((b) => b.c);
      const actual = d.c.slice(an.from);
      // 用「到昨天為止」最準的設定畫相似日平均與綜合預測
      const ch = bestChoice(o);
      choiceLog[o].push(ch);
      const avgN = avgOf(an.lines, ch.n);
      const lines: Record<string, number[]> = {
        blend: avgN.length ? blendLine(modelCloses, avgN, ch.w) : modelCloses,
        model: modelCloses,
        avg: avgN,
        a1: an.lines[0]?.closes ?? [],
        a2: an.lines[1]?.closes ?? [],
        a3: an.lines[2]?.closes ?? [],
      };
      // 今天結束後，更新每一組設定的累計誤差（明天才用得到）
      if (an.lines.length >= 20 && modelCloses.length === actual.length) {
        for (const nn of ANALOG_NS) {
          const av = avgOf(an.lines, nn);
          for (const w of BLEND_WS) {
            const bl = blendLine(modelCloses, av, w);
            let se = 0;
            bl.forEach((v, i) => (se += Math.log(v / actual[i]) ** 2));
            const key = `${nn}|${w}`;
            choiceSE[o].set(key, (choiceSE[o].get(key) ?? 0) + se);
          }
        }
        choiceDays[o]++;
      }
      let bestL = '';
      let bestE = Infinity;
      for (const l of LINES) {
        const xs = lines[l];
        if (xs.length !== actual.length) continue;
        let se = 0;
        xs.forEach((v, i) => (se += Math.log(v / actual[i]) ** 2));
        const t = tee(lineAcc[o][l], lineAccBy[per][o][l]);
        t.se += se;
        t.n += xs.length;
        t.days++;
        if (Math.sign(xs[xs.length - 1] - ref) === Math.sign(actual[actual.length - 1] - ref)) t.hit++;
        if (se < bestE) (bestE = se), (bestL = l);
      }
      if (bestL) tee(lineAcc[o][bestL], lineAccBy[per][o][bestL]).best += 1;
      if (o === -1 || o === 12) record.push({ date: d.date, origin: o, ref, blend: lines.blend[lines.blend.length - 1], model: modelCloses[modelCloses.length - 1], avg: avgN[avgN.length - 1] ?? NaN, actual: d.c[BARS] });
    }
    for (const b of f.bars) {
      const act = d.ix[b.bar];
      a.pe.push(Math.log(b.c / act[3]));
      a.pn.push(Math.log(ref / act[3]));
      a.covN++;
      if (act[3] >= b.lo && act[3] <= b.hi) a.cov++;
      if (process.env.DEBUG && o === 0) { const z = Math.log(act[3] / b.c) / (Math.log(b.hi / b.c) / 1.28 || 1e-9); (dbg[b.bar] ??= []).push(z); }
      const R = Math.log(b.h / b.l);
      a.re.push(Math.abs(R - barRange(act)));
      a.rn.push(Math.abs(Math.exp(dm.base[b.bar]) - barRange(act)));
      a.rl.push(Math.log(R) - Math.log(barRange(act)));
      a.rlb.push(dm.base[b.bar] - Math.log(barRange(act)));
    }
    // 最高、最低點
    const hiAct = Math.max(...d.ix.map((b) => b[1]));
    const loAct = Math.min(...d.ix.map((b) => b[2]));
    const known = d.ix.slice(0, k);
    const kh = Math.max(o < 0 ? f.open : d.c[0], ...known.map((b) => b[1]));
    const kl = Math.min(o < 0 ? f.open : d.c[0], ...known.map((b) => b[2]));
    const now = o < 0 ? f.open : d.c[k];
    a.he.push(Math.abs(Math.log(f.dayHigh / hiAct)), Math.abs(Math.log(f.dayLow / loAct)));
    a.hn.push(Math.abs(Math.log(Math.max(kh, now * Math.exp(avgEx!.up[k])) / hiAct)), Math.abs(Math.log(Math.min(kl, now * Math.exp(-avgEx!.down[k])) / loAct)));
  }
  // 00631L 當天進出場：用到昨天為止最好的設定交易今天；今天結束後再更新每組設定的成績
  {
    const bL = betaBefore(dIdx.get(d.date)!);
    const pick = bestRange();
    if (n === days.length - REPLAY) (replayRange = pick), (replayRef = rangeCum.slice(0, NO_TRADE).reduce((b, v, i, a) => (v > a[b] ? i : b), 0));
    const pnlOf = (r: ReturnType<typeof simulateRange>) => (r.side ? bL * r.ret - DAYTRADE_COST : 0);
    RANGE_PLANS.forEach((pl, pi) => {
      const r = simulateRange(d.ix, rangeLevels(dm, d.ix, pl, d.P0, d.ctx, bL));
      const v = pnlOf(r);
      if (pi === pick) rangeRows.push({ date: d.date, plan: pi, side: r.side, entryBar: r.entryBar, exitBar: r.exitBar, how: r.how, pnl: v, hold: bL * Math.log(d.c[BARS] / d.c[0]) - DAYTRADE_COST });
      rangeCum[pi] += v;
      rangeSq[pi] += v * v;
    });
    rangeDays++;
    // 歷史模擬存檔（給模擬帳戶回測）：前一個交易日收盤後「會存下來」的區間進出場設定
    const asOf = taiex[dIdx.get(d.date)! - 1][0];
    if (TF === 5 && process.env.BACKFILL_DIR && asOf >= (process.env.BACKFILL_FROM ?? '0000') && asOf <= (process.env.BACKFILL_TO ?? '9999')) {
      const pl = RANGE_PLANS[pick];
      writeArchive(process.env.BACKFILL_DIR, 'intraday', asOf, { P0: d.P0, ctx: d.ctx, range: { plan: { ...pl, m: Number.isFinite(pl.m ?? 0) ? pl.m : 1e9 }, dm, beta: bL } });
    }
  }
  // 這一天收盤走勢的樣本外殘差（給之後的日子畫區間）
  for (let k = 0; k < BARS; k += KS) {
    const z = features(d.c, k, d.P0, d.ctx, m.disc).map((v, j) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - m.mean[j]) / (m.sd[j] || 1))) : 0));
    HORIZONS.forEach((h, hi) => {
      if (!validK(k, h)) return;
      const p = (m.coef[hi][0] + z.reduce((s, v, j) => s + m.coef[hi][j + 1] * v, 0)) * horizonScale(h, k);
      residBy[hi][timeBucket(k)].push((target(d, k, h) - p) / volScale(dm, d.ix, k, d.c[0], d.P0, d.ctx) / windowVol(dm.base, k, h === BARS ? BARS - k : h));
    });
  }
}
const rmse = (a: number[]) => Math.sqrt(mean(a.map((v) => v * v)));
const mae = (a: number[]) => mean(a.map(Math.abs));
/** 各預測時間點的成績（振幅、高低點、區間、走勢）。 */
const summarize = (set: Record<number, Acc>) =>
  ORIGINS.map((o) => {
    const a = set[o];
    return {
      origin: o,
      label: ORIGIN_LABEL[o],
      // 收盤走勢：每根 K 棒收盤價的誤差（RMSE），模型 vs 不會動
      pathRmse: r5(rmse(a.pe)),
      pathNaive: r5(rmse(a.pn)),
      // 約 80% 區間實際涵蓋的比例
      coverage: r5(a.cov / (a.covN || 1)),
      // 每根 K 棒振幅的平均誤差，模型 vs 時段平均
      rangeMae: r5(mean(a.re)),
      rangeNaive: r5(mean(a.rn)),
      // 振幅（ln）的 R²：比時段平均好多少
      rangeR2: r5(1 - mean(a.rl.map((v) => v * v)) / (mean(a.rlb.map((v) => v * v)) || 1)),
      // 今天最高、最低點的平均誤差，模型 vs 平均高低點
      hlMae: r5(mae(a.he)),
      hlNaive: r5(mae(a.hn)),
    };
  });
/** 各條預測線的成績（每根收盤誤差、收盤方向命中率、最接近實際的比例）。 */
const summarizeLines = (set: LineAcc) =>
  ORIGINS.map((o) => ({
    origin: o,
    label: ORIGIN_LABEL[o],
    ...Object.fromEntries(
      LINES.map((l) => {
        const t = set[o][l];
        return [l, { rmse: r5(Math.sqrt(t.se / (t.n || 1))), hit: r5(t.hit / (t.days || 1)), best: r5(t.best / (t.days || 1)) }];
      }),
    ),
  }));
const byOrigin = summarize(acc);
const oosDays = days.slice(FIRST);
const periodInfo = (p: Period) => {
  const ds = oosDays.filter((d) => p === 'all' || periodOf(d.date) === p);
  return ds.length ? { from: ds[0].date, to: ds[ds.length - 1].date, days: ds.length, byOrigin: summarize(accBy[p]), lines: summarizeLines(lineAccBy[p]) } : null;
};
console.log('回測（樣本外）：');
for (const b of byOrigin)
  console.log(`  ${b.label}：走勢 ${(b.pathRmse! * 100).toFixed(3)}% vs 不動 ${(b.pathNaive! * 100).toFixed(3)}%、區間涵蓋 ${(b.coverage! * 100).toFixed(0)}%、振幅誤差 ${(b.rangeMae! * 100).toFixed(3)}% vs ${(b.rangeNaive! * 100).toFixed(3)}%（R² ${b.rangeR2}）、高低點 ${(b.hlMae! * 100).toFixed(3)}% vs ${(b.hlNaive! * 100).toFixed(3)}%`);
if (process.env.DEBUG) console.log('開盤預測：每根 K 棒 實際誤差 ÷ 預測標準差 的標準差（應該約 1）', dbg.map((z, b) => `${b}:${std(z).toFixed(2)}`).filter((_, b) => b % 6 === 0).join(' '));
console.log('挑到的 λ：', Object.fromEntries(Object.entries(lambdaLog).map(([k, v]) => [k, v.at(-1)])));

// ---------------------------------------------------------------- 最終模型（全部資料）＋ 00631L 換算
const final = fitAll(days);
console.log('最終模型自己選用的資料：', JSON.stringify(final.used));
final.m.resid = residBy.map((row, hi) => row.map((e, tb) => r5(e.length > 30 ? std(e) : final.m.resid[hi][tb])!));

const prevL = (date: string) => lClose.get(taiex[dIdx.get(date)! - 1][0]) ?? null;
const lastDate = taiex[taiex.length - 1][0];
const ctxOut = (c: DailyCtx) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r5(v)]));
const lin = (x: LinModel) => ({ mean: x.mean.map(r5), sd: x.sd.map(r5), coef: x.coef.map(r5) });
const verdictOf = (b: (typeof byOrigin)[number]) => (b.pathRmse ?? 1) < (b.pathNaive ?? 0) * 0.995;

// ---------------------------------------------------------------- 00631L 當天進出場的成績
function rangeSummary() {
  const stat = (rows: typeof rangeRows) => {
    const taken = rows.filter((r) => r.side);
    let eq = 1;
    const curve: number[] = [];
    for (const r of rows) curve.push((eq *= 1 + r.pnl));
    let peak = 1;
    let dd = 0;
    for (const v of curve) (peak = Math.max(peak, v)), (dd = Math.min(dd, v / peak - 1));
    return rows.length
      ? {
          from: rows[0].date,
          to: rows[rows.length - 1].date,
          days: rows.length,
          trades: taken.length,
          win: r5(taken.filter((r) => r.pnl > 0).length / (taken.length || 1)),
          avg: r5(mean(taken.map((r) => r.pnl))),
          total: r5(eq - 1),
          maxDD: r5(dd),
          target: r5(taken.filter((r) => r.how === 'target').length / (taken.length || 1)),
          stop: r5(taken.filter((r) => r.how === 'stop').length / (taken.length || 1)),
          // 對照：每天開盤買、收盤賣
          hold: r5(rows.reduce((t, r) => t * (1 + r.hold), 1) - 1),
        }
      : null;
  };
  const out = (pl: RangePlan) => ({ ...pl, m: Number.isFinite(pl.m ?? 0) ? (pl.m ?? 0) : null, noTrade: !Number.isFinite(pl.m ?? 0) });
  return {
    plan: out(RANGE_PLANS[bestRange()]),
    // 參考設定：不管顯不顯著，過去累計賺最多（或虧最少）的那組，畫參考價位用
    refPlan: out(RANGE_PLANS[rangeCum.slice(0, NO_TRADE).reduce((b, v, i, a) => (v > a[b] ? i : b), 0)]),
    replayPlan: out(RANGE_PLANS[replayRange]),
    replayRef: out(RANGE_PLANS[replayRef]),
    cost: r5(DAYTRADE_COST),
    all: stat(rangeRows),
    hold: stat(rangeRows.filter((r) => periodOf(r.date) === 'hold')),
    dev: stat(rangeRows.filter((r) => periodOf(r.date) === 'dev')),
    curve: (() => {
      let eq = 1;
      let eh = 1;
      return rangeRows.map((r) => [r.date, r5((eq *= 1 + r.pnl))!, r5((eh *= 1 + r.hold))!]).filter((_, i, a) => i % 3 === 0 || i === a.length - 1);
    })(),
    recent: rangeRows.slice(-20).reverse().map((r) => ({ ...r, pnl: r5(r.pnl), hold: r5(r.hold) })),
  };
}
console.log('00631L 進出場：', JSON.stringify({ plan: RANGE_PLANS[bestRange()], ...rangeSummary().all }));

// ---------------------------------------------------------------- 事前存檔與實盤成績
const finalChoice = ORIGINS.map((o) => ({ origin: o, ...bestChoice(o) }));
/** 下一個交易日開盤前的預測（全部資料訓練的模型，只用到最後一個交易日收盤為止）。 */
function nextDayForecast() {
  const ctx = dailyCtx(taiex.length)!;
  const P0 = taiex[taiex.length - 1][4];
  const f = forecastDay(final.m, final.dm, [], -1, null, P0, ctx);
  const model = [f.open, ...f.bars.map((b) => b.c)];
  const an = analogLines(lib, { k: -1, gap: NaN, r: [0], ctx }, P0, 20, 20);
  const ch = finalChoice.find((c) => c.origin === -1)!;
  const avg = avgOf(an.lines, ch.n);
  const r = (xs: number[]) => xs.map((v) => r5(v));
  return { P0, model: r(model), avg: r(avg), blend: r(blendLine(model, avg, ch.w)), analogs: an.lines.slice(0, 3).map((l) => ({ date: l.date, closes: r(l.closes) })), dayHigh: r5(f.dayHigh), dayLow: r5(f.dayLow), choice: ch, ctx, range: { plan: { ...RANGE_PLANS[bestRange()], m: Number.isFinite(RANGE_PLANS[bestRange()].m ?? 0) ? RANGE_PLANS[bestRange()].m : 1e9 }, dm: final.dm, beta } };
}
const ARCHIVE_DIR = TF === 5 ? process.env.ARCHIVE_DIR : undefined;
if (ARCHIVE_DIR) {
  if (canArchive(lastDate, Date.now(), !!process.env.ARCHIVE_KIND_SUFFIX)) console.log(writeArchive(ARCHIVE_DIR, 'intraday' + (process.env.ARCHIVE_KIND_SUFFIX ?? ''), lastDate, nextDayForecast()) ? `事前存檔：${lastDate} 收盤後 → 下一個交易日` : `事前存檔：${lastDate} 已經存過`);
  else console.log(`事前存檔：現在不是 ${lastDate} 收盤後到下一個交易日開盤前，不存`);
}
// 實盤成績：存檔裡的預測 vs 之後實際的走勢（只用存檔的數字）
type Arch = { P0: number; model: number[]; avg: number[]; blend: number[]; dayHigh: number; dayLow: number };
const fwRows: Array<{ asOf: string; date: string; P0: number; actual: number; blend: number; model: number; avg: number; rmse: Record<string, number>; hiErr: number; loErr: number }> = [];
for (const a of readPreOpen<Arch>(TF === 5 ? process.env.FORECASTS_DIR : undefined, 'intraday')) {
  const i = dIdx.get(a.asOf);
  const next = i == null ? undefined : taiex[i + 1]?.[0];
  const d = next ? days.find((x) => x.date === next) : undefined;
  if (!d) continue;
  const rm = (xs: number[]) => Math.sqrt(mean(xs.map((v, j) => Math.log(v / d.c[j]) ** 2)));
  fwRows.push({
    asOf: a.asOf,
    date: d.date,
    P0: a.P0,
    actual: d.c[BARS],
    blend: a.blend.at(-1)!,
    model: a.model.at(-1)!,
    avg: a.avg.at(-1)!,
    rmse: { blend: r5(rm(a.blend))!, model: r5(rm(a.model))!, avg: r5(rm(a.avg))!, flat: r5(rm(a.model.map(() => a.P0)))! },
    hiErr: r5(Math.log(a.dayHigh / Math.max(...d.ix.map((b) => b[1]))))!,
    loErr: r5(Math.log(a.dayLow / Math.min(...d.ix.map((b) => b[2]))))!,
  });
}
const hitOf = (k: 'blend' | 'model' | 'avg') => fwRows.filter((r) => Math.sign(r[k] - r.P0) === Math.sign(r.actual - r.P0)).length;
const forward = {
  days: fwRows.length,
  hit: { blend: hitOf('blend'), model: hitOf('model'), avg: hitOf('avg') },
  rmse: Object.fromEntries(['blend', 'model', 'avg', 'flat'].map((k) => [k, r5(Math.sqrt(mean(fwRows.map((r) => r.rmse[k] ** 2))))])),
  rows: fwRows.slice(-30).reverse(),
};
// 進出場的實盤成績：用存檔的模型與規則，在實際走勢上算出當天的價位並模擬
type RangeArch = { P0: number; ctx: DailyCtx; range?: { plan: RangePlan; dm: DayModel; beta: number } };
const fwRange: Array<{ date: string; side: number; how: string; pnl: number }> = [];
for (const a of readPreOpen<RangeArch>(TF === 5 ? process.env.FORECASTS_DIR : undefined, 'intraday')) {
  if (!a.range || !a.ctx) continue;
  const i = dIdx.get(a.asOf);
  const next = i == null ? undefined : taiex[i + 1]?.[0];
  const d = next ? days.find((x) => x.date === next) : undefined;
  if (!d) continue;
  const r = simulateRange(d.ix, rangeLevels(a.range.dm, d.ix, a.range.plan, a.P0, a.ctx, a.range.beta));
  fwRange.push({ date: d.date, side: r.side, how: r.how, pnl: r5(r.side ? a.range.beta * r.ret - DAYTRADE_COST : 0)! });
}
Object.assign(forward, { range: { days: fwRange.length, trades: fwRange.filter((x) => x.side).length, total: r5(fwRange.reduce((t, x) => t + x.pnl, 0)), rows: fwRange.slice(-20).reverse() } });
console.log(`實盤成績：${forward.days} 天（事前存檔）`);
if (process.env.ARCHIVE_ONLY) process.exit(0);

writeFileSync(
  join(dir, `predict-intraday${SUF}.json`),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    ready: true,
    tf: TF,
    beta: r5(beta),
    model: { mean: final.m.mean.map(r5), sd: final.m.sd.map(r5), coef: final.m.coef.map((b) => b.map(r5)), resid: final.m.resid, disc: final.m.disc, discT: final.m.discT },
    day: { base: final.dm.base.map(r5), rng: lin(final.dm.rng), up: lin(final.dm.up), down: lin(final.dm.down), gap: lin(final.dm.gap), gapSd: r5(final.dm.gapSd) },
    // 走勢：至少一半的預測時間點比「不會動」誤差小 0.5% 以上才算有預測能力
    verdict: byOrigin.filter(verdictOf).length >= ORIGINS.length / 2 ? 'signal' : 'none',
    // 振幅與高低點：半數以上的預測時間點比簡單猜法誤差小 3% 以上，而且沒有任何時間點差超過 3%
    rangeVerdict:
      byOrigin.filter((b) => b.rangeMae! < b.rangeNaive! * 0.97 && b.hlMae! < b.hlNaive! * 0.97).length >= ORIGINS.length / 2 &&
      byOrigin.every((b) => b.rangeMae! < b.rangeNaive! * 1.03 && b.hlMae! < b.hlNaive! * 1.03)
        ? 'signal'
        : 'none',
    backtest: { from: days[FIRST]?.date, to: days.at(-1)!.date, days: days.length - FIRST, byOrigin },
    next: { after: lastDate, P0: taiex[taiex.length - 1][4], L0: lClose.get(lastDate) ?? null, ctx: ctxOut(dailyCtx(taiex.length)!) },
    recent: days.slice(-10).map((d) => ({ date: d.date, P0: d.P0, L0: prevL(d.date), ix: d.ix, ctx: ctxOut(d.ctx) })),
    // 各種預測線的樣本外成績（每根收盤誤差 RMSE、收盤方向命中率、最接近實際的比例）
    lines: summarizeLines(lineAcc),
    // 分期間：hold＝調整模型時從沒看過的期間（公正）、dev＝開發期間（看過，可能偏樂觀）
    periods: { hold: periodInfo('hold'), dev: periodInfo('dev') },
    devStart: DEV_START,
    // 最終模型自己選擇要用的資料（每個預測長度、開盤跳空）
    used: final.used,
    // 回放用的模型（回放那幾天開始之前的模型，不會看到答案）
    replay: replaySnap,
    // 事前存檔的實盤成績
    forward,
    // 00631L 當天進出場（區間來回）：目前的設定、樣本外回測（逐段往前滾挑設定）
    rangeTrade: rangeSummary(),
    // 最近 20 天的預測紀錄
    record: record.slice(-40).map((r) => ({ ...r, ref: r5(r.ref), blend: r5(r.blend), model: r5(r.model), avg: r5(r.avg), actual: r5(r.actual) })),
    // 自動挑的設定（到最後一天為止誤差最小；網頁畫相似日平均與綜合預測用）
    choice: ORIGINS.map((o) => ({ origin: o, ...bestChoice(o) })),
  }),
);
// 相似日資料庫（網頁即時找相似日用）：[日期, 跳空, 走勢（×1e4 取整）, 開盤前資料]
const i4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) : null);
writeFileSync(join(dir, `predict-analogs${SUF}.json`), JSON.stringify(lib.map((a) => [a.date, i4(a.gap), a.r.map((v) => i4(v)), [a.ctx.prevDay, a.ctx.prev5, a.ctx.prevIntra, a.ctx.futChg, a.ctx.prevRange, a.ctx.usSox ?? NaN, a.ctx.usTsm ?? NaN, a.ctx.usSpx ?? NaN, a.ctx.night ?? NaN, a.ctx.usVix ?? NaN, a.ctx.nightRange ?? NaN, a.ctx.nightPos ?? NaN].map(i4)])));
for (const o of ORIGINS) console.log(`  ${ORIGIN_LABEL[o]}（n=${bestChoice(o).n}、w=${bestChoice(o).w}）：` + LINES.map((l) => { const t = lineAcc[o][l]; return `${l} ${(Math.sqrt(t.se / (t.n || 1)) * 100).toFixed(2)}%/${((t.hit / (t.days || 1)) * 100).toFixed(0)}%/${((t.best / (t.days || 1)) * 100).toFixed(0)}%`; }).join('  '));
console.log(`β ${beta.toFixed(3)}；predict-intraday${SUF}.json 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
