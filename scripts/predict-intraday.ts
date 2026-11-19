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
  volScale,
  windowVol,
  analogLines,
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
} from '../web/src/domain/intradayModel.ts';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { mean, ridge, standardizer, std } from './lib/ml.ts';

const dir = process.argv[2] ?? 'data';
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
  };
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
  const j = read<{ ix?: Bar[] }>(join(idir, f), {});
  if (!j.ix || j.ix.length !== BARS) continue;
  days.push({ date, P0: taiex[i - 1][4], ix: j.ix, c: [j.ix[0][0], ...j.ix.map((b) => b[3])], ctx: dailyCtx(i)! });
}
const analogOf = (d: Day): AnalogDay => ({ date: d.date, gap: Math.log(d.c[0] / d.P0), r: d.c.map((v) => Math.log(v / d.c[0])), ctx: d.ctx });
const lib: AnalogDay[] = days.map(analogOf);
console.log(`5 分 K：${days.length} 天（${days[0]?.date ?? '—'} ～ ${days.at(-1)?.date ?? '—'}）`);
if (days.length < 60) {
  writeFileSync(join(dir, 'predict-intraday.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ready: false, days: days.length }));
  console.log('資料還不夠（少於 60 天），先輸出空的結果');
  process.exit(0);
}

// ---------------------------------------------------------------- 訓練工具
/** 樣本：特徵、目標（每一天一組，方便切驗證集）。 */
type Samples = Array<{ X: number[][]; y: number[] }>;
/** 用最後 20% 的日子挑 λ（驗證誤差最小），再用全部重新訓練。 */
function fitLin(byDay: Samples): LinModel & { lambda: number } {
  const flat = (s: Samples) => ({ X: s.flatMap((d) => d.X), y: s.flatMap((d) => d.y) });
  const cut = Math.floor(byDay.length * 0.8);
  const tr = flat(byDay.slice(0, cut));
  const va = flat(byDay.slice(cut));
  let best = { lambda: LAMBDAS[1], err: Infinity };
  if (tr.X.length > 50 && va.X.length > 10) {
    const st = standardizer(tr.X);
    const Zt = tr.X.map(st.apply);
    const Zv = va.X.map(st.apply);
    for (const lambda of LAMBDAS) {
      const b = ridge(Zt, tr.y, lambda);
      let err = 0;
      Zv.forEach((z, i) => (err += (va.y[i] - (b[0] + z.reduce((s, v, j) => s + b[j + 1] * v, 0))) ** 2));
      if (err < best.err) best = { lambda, err };
    }
  }
  const all = flat(byDay);
  const st = standardizer(all.X);
  return { mean: st.mean, sd: st.sd, coef: ridge(all.X.map(st.apply), all.y, best.lambda), lambda: best.lambda };
}
const target = (d: Day, k: number, h: number) => Math.log(d.c[h === 54 ? BARS : Math.min(BARS, k + h)] / d.c[k]);
const validK = (k: number, h: number) => (h === 54 ? k < BARS : k + h <= BARS);

function fitAll(train: Day[]): { m: IntradayModel & { inRes?: number[][] }; dm: DayModel; lambdas: Record<string, number> } {
  const lambdas: Record<string, number> = {};
  // 收盤走勢：每個長度一組
  const path = HORIZONS.map((h) => {
    const fit = fitLin(train.map((d) => {
      const X: number[][] = [];
      const y: number[] = [];
      for (let k = 0; k < BARS; k++) if (validK(k, h)) X.push(features(d.c, k, d.P0, d.ctx)), y.push(target(d, k, h) / horizonScale(h, k));
      return { X, y };
    }));
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
  const m: IntradayModel = { mean: st0.mean, sd: st0.sd, coef, resid: HORIZONS.map(() => new Array(TIME_BUCKETS).fill(0)) };
  const inSampleResid = () => m.resid; // 振幅模型訓練好後再算（要用波動倍率）
  // 振幅：每個時段的平均，再預測比平均大多少
  const base = Array.from({ length: BARS }, (_, b) => mean(train.map((d) => Math.log(barRange(d.ix[b])))));
  const rng = fitLin(train.map((d) => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let k = 0; k < BARS; k += 3) for (let j = k; j < BARS; j++) X.push(rangeFeatures(d.ix, k, j, d.c[0], d.P0, d.ctx, base)), y.push(Math.log(barRange(d.ix[j])) - base[j]);
    return { X, y };
  }));
  // 剩下時間的最高、最低
  const ex = (dirn: 1 | -1) =>
    fitLin(train.map((d) => {
      const X: number[][] = [];
      const y: number[] = [];
      for (let k = 0; k < BARS; k++) {
        let e = 0;
        for (let b = k; b < BARS; b++) e = Math.max(e, dirn > 0 ? Math.log(d.ix[b][1] / d.c[k]) : Math.log(d.c[k] / d.ix[b][2]));
        X.push(excursionFeatures(d.ix, d.c, k, d.P0, d.ctx, base));
        y.push(e);
      }
      return { X, y };
    }));
  const up = ex(1);
  const down = ex(-1);
  const gap = fitLin(train.map((d) => ({ X: [gapFeatures(d.ctx)], y: [Math.log(d.c[0] / d.P0)] })));
  // 跳空的誤差（訓練資料內；開盤前的區間要加上它）
  const gapSd = std(train.map((d) => Math.log(d.c[0] / d.P0) - (gap.coef[0] + gapFeatures(d.ctx).reduce((s, v, j) => s + gap.coef[j + 1] * (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - gap.mean[j]) / (gap.sd[j] || 1))) : 0), 0))));
  Object.assign(lambdas, { rng: rng.lambda, up: up.lambda, down: down.lambda, gap: gap.lambda });
  const strip = ({ mean, sd, coef }: LinModel) => ({ mean, sd, coef });
  // 訓練資料內的殘差（除以波動倍率）：樣本外殘差還不夠時當備案
  const dmTmp = { base, rng: strip(rng), up: strip(up), down: strip(down), gap: strip(gap), gapSd };
  const rb = HORIZONS.map(() => Array.from({ length: TIME_BUCKETS }, () => [] as number[]));
  for (const d of train.filter((_, i) => i % 3 === 0))
    for (let k = 0; k < BARS; k++) {
      const z = features(d.c, k, d.P0, d.ctx).map((v, j) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - m.mean[j]) / (m.sd[j] || 1))) : 0));
      const sc = volScale(dmTmp, d.ix, k, d.c[0], d.P0, d.ctx);
      HORIZONS.forEach((h, hi) => {
        if (!validK(k, h)) return;
        const p = (m.coef[hi][0] + z.reduce((s, v, j) => s + m.coef[hi][j + 1] * v, 0)) * horizonScale(h, k);
        rb[hi][timeBucket(k)].push((target(d, k, h) - p) / sc / windowVol(base, k, h === 54 ? BARS - k : h));
      });
    }
  m.resid = rb.map((row) => row.map((e) => (e.length > 10 ? std(e) : 0.5)));
  void inSampleResid;
  return { m, dm: { base, rng: strip(rng), up: strip(up), down: strip(down), gap: strip(gap), gapSd }, lambdas };
}

// ---------------------------------------------------------------- 逐段往前滾回測
const FIRST = Math.min(250, Math.floor(days.length / 2));
const REFIT = 20;
const ORIGINS = [-1, 0, 12, 24, 36, 48]; // 開盤前、開盤、10:00、11:00、12:00、13:00
const ORIGIN_LABEL: Record<number, string> = { [-1]: '開盤前', 0: '09:00 開盤', 12: '10:00', 24: '11:00', 36: '12:00', 48: '13:00' };
type Acc = { pe: number[]; pn: number[]; cov: number; covN: number; re: number[]; rn: number[]; rl: number[]; rlb: number[]; he: number[]; hn: number[] };
const acc: Record<number, Acc> = Object.fromEntries(ORIGINS.map((o) => [o, { pe: [], pn: [], cov: 0, covN: 0, re: [], rn: [], rl: [], rlb: [], he: [], hn: [] }]));
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
const lineAcc: Record<number, Record<string, { se: number; n: number; hit: number; days: number; best: number }>> = Object.fromEntries(
  ORIGINS.map((o) => [o, Object.fromEntries(LINES.map((l) => [l, { se: 0, n: 0, hit: 0, days: 0, best: 0 }]))]),
);
// 預測紀錄：開盤前與 10:00 的預測收盤 vs 實際
const record: Array<{ date: string; origin: number; ref: number; blend: number; model: number; avg: number; actual: number }> = [];
const dbg: number[][] = [];
for (let n = FIRST; n < days.length; n++) {
  if (!fitted || (n - FIRST) % REFIT === 0) {
    const train = days.slice(0, n);
    fitted = fitAll(train);
    for (const [k, v] of Object.entries(fitted.lambdas)) (lambdaLog[k] ??= []).push(v);
    avgEx = { up: [], down: [] };
    for (let k = 0; k < BARS; k++) {
      avgEx.up.push(mean(train.map((d) => Math.max(...d.ix.slice(k).map((b) => Math.log(b[1] / d.c[k]))))));
      avgEx.down.push(mean(train.map((d) => Math.max(...d.ix.slice(k).map((b) => Math.log(d.c[k] / b[2]))))));
    }
  }
  const { m, dm } = fitted;
  const d = days[n];
  // 區間用「之前的日子」累積的樣本外殘差（今天的還沒加進去）
  const inRes = fitted.m.inRes ?? (fitted.m.inRes = m.resid.map((r) => r.slice()));
  m.resid = residBy.map((row, hi) => row.map((e, tb) => (e.length > 30 ? std(e) : inRes[hi][tb])));
  for (const o of ORIGINS) {
    const k = Math.max(0, o);
    const f = forecastDay(m, dm, d.ix, o, o < 0 ? null : d.c[0], d.P0, d.ctx);
    const a = acc[o];
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
        const t = lineAcc[o][l];
        t.se += se;
        t.n += xs.length;
        t.days++;
        if (Math.sign(xs[xs.length - 1] - ref) === Math.sign(actual[actual.length - 1] - ref)) t.hit++;
        if (se < bestE) (bestE = se), (bestL = l);
      }
      if (bestL) lineAcc[o][bestL].best++;
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
  // 這一天收盤走勢的樣本外殘差（給之後的日子畫區間）
  for (let k = 0; k < BARS; k++) {
    const z = features(d.c, k, d.P0, d.ctx).map((v, j) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - m.mean[j]) / (m.sd[j] || 1))) : 0));
    HORIZONS.forEach((h, hi) => {
      if (!validK(k, h)) return;
      const p = (m.coef[hi][0] + z.reduce((s, v, j) => s + m.coef[hi][j + 1] * v, 0)) * horizonScale(h, k);
      residBy[hi][timeBucket(k)].push((target(d, k, h) - p) / volScale(dm, d.ix, k, d.c[0], d.P0, d.ctx) / windowVol(dm.base, k, h === 54 ? BARS - k : h));
    });
  }
}
const rmse = (a: number[]) => Math.sqrt(mean(a.map((v) => v * v)));
const mae = (a: number[]) => mean(a.map(Math.abs));
const byOrigin = ORIGINS.map((o) => {
  const a = acc[o];
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
console.log('回測（樣本外）：');
for (const b of byOrigin)
  console.log(`  ${b.label}：走勢 ${(b.pathRmse! * 100).toFixed(3)}% vs 不動 ${(b.pathNaive! * 100).toFixed(3)}%、區間涵蓋 ${(b.coverage! * 100).toFixed(0)}%、振幅誤差 ${(b.rangeMae! * 100).toFixed(3)}% vs ${(b.rangeNaive! * 100).toFixed(3)}%（R² ${b.rangeR2}）、高低點 ${(b.hlMae! * 100).toFixed(3)}% vs ${(b.hlNaive! * 100).toFixed(3)}%`);
if (process.env.DEBUG) console.log('開盤預測：每根 K 棒 實際誤差 ÷ 預測標準差 的標準差（應該約 1）', dbg.map((z, b) => `${b}:${std(z).toFixed(2)}`).filter((_, b) => b % 6 === 0).join(' '));
console.log('挑到的 λ：', Object.fromEntries(Object.entries(lambdaLog).map(([k, v]) => [k, v.at(-1)])));

// ---------------------------------------------------------------- 最終模型（全部資料）＋ 00631L 換算
const final = fitAll(days);
final.m.resid = residBy.map((row, hi) => row.map((e, tb) => r5(e.length > 30 ? std(e) : final.m.resid[hi][tb])!));

const exDays = new Set<string>();
for (const f of existsSync(join(dir, 'exrights')) ? readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) if (r[1] === '00631L') exDays.add(r[0]);
const lRaw = read<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', '00631L.json'), []);
const lBars = lRaw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
const lAdj = adjustForSplits(lBars, detectSplits(lBars, exDays), '9999-12-31');
const lClose = new Map(lAdj.map((b) => [b.date, b.close]));
let sxy = 0;
let sxx = 0;
for (let i = Math.max(1, taiex.length - 250); i < taiex.length; i++) {
  const a = lClose.get(taiex[i][0]);
  const b = lClose.get(taiex[i - 1][0]);
  if (!a || !b) continue;
  const x = Math.log(taiex[i][4] / taiex[i - 1][4]);
  sxy += x * Math.log(a / b);
  sxx += x * x;
}
const beta = sxx ? sxy / sxx : 2;
const prevL = (date: string) => lClose.get(taiex[dIdx.get(date)! - 1][0]) ?? null;
const lastDate = taiex[taiex.length - 1][0];
const ctxOut = (c: DailyCtx) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r5(v)]));
const lin = (x: LinModel) => ({ mean: x.mean.map(r5), sd: x.sd.map(r5), coef: x.coef.map(r5) });
const verdictOf = (b: (typeof byOrigin)[number]) => (b.pathRmse ?? 1) < (b.pathNaive ?? 0) * 0.995;

writeFileSync(
  join(dir, 'predict-intraday.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    ready: true,
    beta: r5(beta),
    model: { mean: final.m.mean.map(r5), sd: final.m.sd.map(r5), coef: final.m.coef.map((b) => b.map(r5)), resid: final.m.resid },
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
    lines: ORIGINS.map((o) => ({
      origin: o,
      label: ORIGIN_LABEL[o],
      ...Object.fromEntries(LINES.map((l) => {
        const t = lineAcc[o][l];
        return [l, { rmse: r5(Math.sqrt(t.se / (t.n || 1))), hit: r5(t.hit / (t.days || 1)), best: r5(t.best / (t.days || 1)) }];
      })),
    })),
    // 最近 20 天的預測紀錄
    record: record.slice(-40).map((r) => ({ ...r, ref: r5(r.ref), blend: r5(r.blend), model: r5(r.model), avg: r5(r.avg), actual: r5(r.actual) })),
    // 自動挑的設定（到最後一天為止誤差最小；網頁畫相似日平均與綜合預測用）
    choice: ORIGINS.map((o) => ({ origin: o, ...bestChoice(o) })),
  }),
);
// 相似日資料庫（網頁即時找相似日用）：[日期, 跳空, 走勢（×1e4 取整）, 開盤前資料]
const i4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) : null);
writeFileSync(join(dir, 'predict-analogs.json'), JSON.stringify(lib.map((a) => [a.date, i4(a.gap), a.r.map((v) => i4(v)), [a.ctx.prevDay, a.ctx.prev5, a.ctx.prevIntra, a.ctx.futChg, a.ctx.prevRange].map(i4)])));
for (const o of ORIGINS) console.log(`  ${ORIGIN_LABEL[o]}（n=${bestChoice(o).n}、w=${bestChoice(o).w}）：` + LINES.map((l) => { const t = lineAcc[o][l]; return `${l} ${(Math.sqrt(t.se / (t.n || 1)) * 100).toFixed(2)}%/${((t.hit / (t.days || 1)) * 100).toFixed(0)}%/${((t.best / (t.days || 1)) * 100).toFixed(0)}%`; }).join('  '));
console.log(`β ${beta.toFixed(3)}；predict-intraday.json 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
