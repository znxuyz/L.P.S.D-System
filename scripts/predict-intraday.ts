/**
 * 00631L 5 分 K 走勢預測（部署時執行，不連網）：
 *
 *   node scripts/predict-intraday.ts <資料資料夾>
 *
 * - 資料：加權指數 5 分 K（intraday/，證交所每 5 秒指數統計）＋日 K＋外資期貨。
 * - 模型：每個時間點（開盤後、每根 5 分 K 收盤後）預測接下來 1、2、3、6、12 根與到收盤的報酬，
 *   每個長度一組嶺迴歸（特徵見 web/src/domain/intradayModel.ts）。逐段往前滾：每 20 個交易日只用之前的日子重新訓練。
 * - 00631L：沒有公開的歷史盤中資料，用「00631L 日報酬 ≈ β × 加權指數日報酬」換算（β 用近一年日 K 估）。
 *
 * 輸出 predict-intraday.json：模型（網頁即時預測用）、樣本外回測、最近幾天的 5 分 K（回放用）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BARS, HORIZONS, features, horizonScale, predictAt, timeBucket, type DailyCtx, type IntradayModel } from '../web/src/domain/intradayModel.ts';
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
  };
}

// ---------------------------------------------------------------- 5 分 K
interface Day {
  date: string;
  P0: number;
  c: number[]; // c[0]＝開盤、c[k]＝第 k 根收盤
  ix: Array<[number, number, number, number]>;
  ctx: DailyCtx;
}
const idir = join(dir, 'intraday');
const days: Day[] = [];
for (const f of existsSync(idir) ? readdirSync(idir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []) {
  const date = f.slice(0, 10);
  const i = dIdx.get(date);
  if (i == null || i < 6) continue;
  const j = read<{ ix?: Array<[number, number, number, number]> }>(join(idir, f), {});
  if (!j.ix || j.ix.length !== BARS) continue;
  const ctx = dailyCtx(i)!;
  const P0 = taiex[i - 1][4];
  days.push({ date, P0, ix: j.ix, c: [j.ix[0][0], ...j.ix.map((b) => b[3])], ctx });
}
console.log(`5 分 K：${days.length} 天（${days[0]?.date ?? '—'} ～ ${days.at(-1)?.date ?? '—'}）`);
if (days.length < 60) {
  writeFileSync(join(dir, 'predict-intraday.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ready: false, days: days.length }));
  console.log('資料還不夠（少於 60 天），先輸出空的結果');
  process.exit(0);
}

// 樣本：每天每個時間點 k、每個 horizon 的目標
const target = (d: Day, k: number, h: number) => Math.log(d.c[h === 54 ? BARS : Math.min(BARS, k + h)] / d.c[k]);
const validK = (k: number, h: number) => (h === 54 ? k < BARS : k + h <= BARS);

function fit(train: Day[]): IntradayModel {
  const X: number[][] = [];
  const meta: Array<[Day, number]> = [];
  for (const d of train) for (let k = 0; k < BARS; k++) X.push(features(d.c, k, d.P0, d.ctx)), meta.push([d, k]);
  const st = standardizer(X);
  const Z = X.map(st.apply);
  const coef = HORIZONS.map((h) => {
    const rows: number[][] = [];
    const ys: number[] = [];
    meta.forEach(([d, k], n) => {
      if (validK(k, h)) rows.push(Z[n]), ys.push(target(d, k, h) / horizonScale(h, k));
    });
    return ridge(rows, ys, 0.01);
  });
  // 殘差標準差（訓練資料內，給還沒有樣本外資料時用；回測後會換成樣本外的）
  const resid = HORIZONS.map((h, hi) => {
    const by: number[][] = Array.from({ length: 6 }, () => []);
    meta.forEach(([d, k], n) => {
      if (!validK(k, h)) return;
      const p = (coef[hi][0] + Z[n].reduce((s, v, j) => s + coef[hi][j + 1] * v, 0)) * horizonScale(h, k);
      by[timeBucket(k)].push(target(d, k, h) - p);
    });
    return by.map((a) => (a.length > 5 ? std(a) : 0));
  });
  return { mean: st.mean, sd: st.sd, coef, resid };
}
// 跟網頁用同一個函式預測
const predict = (m: IntradayModel, d: Day, k: number) => predictAt(m, d.c, k, d.P0, d.ctx);

// ---------------------------------------------------------------- 逐段往前滾回測
const FIRST = Math.min(250, Math.floor(days.length / 2));
const REFIT = 20;
let model: IntradayModel | null = null;
// 每個 horizon：預測、實際、時段
const oos = HORIZONS.map(() => ({ p: [] as number[], y: [] as number[], tb: [] as number[] }));
for (let n = FIRST; n < days.length; n++) {
  if (!model || (n - FIRST) % REFIT === 0) model = fit(days.slice(0, n));
  const d = days[n];
  for (let k = 0; k < BARS; k++) {
    const p = predict(model, d, k);
    HORIZONS.forEach((h, hi) => {
      if (!validK(k, h)) return;
      oos[hi].p.push(p[hi]);
      oos[hi].y.push(target(d, k, h));
      oos[hi].tb.push(timeBucket(k));
    });
  }
}
const stats = (p: number[], y: number[]) => {
  let sse = 0;
  let sse0 = 0;
  let hit = 0;
  let cnt = 0;
  for (let i = 0; i < p.length; i++) {
    sse += (y[i] - p[i]) ** 2;
    sse0 += y[i] ** 2;
    if (y[i] !== 0 && p[i] !== 0) (cnt++, Math.sign(y[i]) === Math.sign(p[i]) && hit++);
  }
  const mp = mean(p);
  const my = mean(y);
  let cov = 0;
  let vp = 0;
  let vy = 0;
  for (let i = 0; i < p.length; i++) (cov += (p[i] - mp) * (y[i] - my)), (vp += (p[i] - mp) ** 2), (vy += (y[i] - my) ** 2);
  return { n: p.length, r2: 1 - sse / (sse0 || 1), acc: hit / (cnt || 1), corr: vp && vy ? cov / Math.sqrt(vp * vy) : 0 };
};
const TIME_LABEL = ['09:00–09:45', '09:45–10:30', '10:30–11:15', '11:15–12:00', '12:00–12:45', '12:45–13:30'];
const byH = HORIZONS.map((h, hi) => {
  const s = stats(oos[hi].p, oos[hi].y);
  return { h, n: s.n, r2: r5(s.r2), acc: r5(s.acc), corr: r5(s.corr) };
});
const closeByTime = TIME_LABEL.map((label, tb) => {
  const hi = HORIZONS.length - 1;
  const idx = oos[hi].tb.map((v, i) => (v === tb ? i : -1)).filter((i) => i >= 0);
  const s = stats(idx.map((i) => oos[hi].p[i]), idx.map((i) => oos[hi].y[i]));
  return { label, n: s.n, r2: r5(s.r2), acc: r5(s.acc) };
});
// 樣本外殘差標準差：給網頁畫預測區間
const residOOS = HORIZONS.map((_, hi) =>
  [0, 1, 2, 3, 4, 5].map((tb) => {
    const e = oos[hi].tb.map((v, i) => (v === tb ? oos[hi].y[i] - oos[hi].p[i] : NaN)).filter(Number.isFinite);
    return e.length > 20 ? r5(std(e))! : 0;
  }),
);
// 有沒有預測能力：至少一個 horizon 的樣本外 R² > 0 而且方向準確率 > 51%
const useful = byH.filter((b) => (b.r2 ?? 0) > 0 && (b.acc ?? 0) > 0.51);
console.log('回測（樣本外）：');
for (const b of byH) console.log(`  ${b.h === 54 ? '到收盤' : `${b.h} 根`}：R² ${b.r2}、方向 ${b.acc}、相關 ${b.corr}（${b.n} 筆）`);
for (const b of closeByTime) console.log(`  到收盤 ${b.label}：R² ${b.r2}、方向 ${b.acc}`);

// ---------------------------------------------------------------- 最終模型（全部資料）＋ 00631L 換算
const final = fit(days);
final.resid = residOOS.map((row, hi) => row.map((v, tb) => v || final.resid[hi][tb]));

const exDays = new Set<string>();
for (const f of existsSync(join(dir, 'exrights')) ? readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) if (r[1] === '00631L') exDays.add(r[0]);
const lRaw = read<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', '00631L.json'), []);
const lBars = lRaw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
const lAdj = adjustForSplits(lBars, detectSplits(lBars, exDays), '9999-12-31');
const lClose = new Map(lAdj.map((b) => [b.date, b.close]));
// β：近 250 天 00631L 日報酬對加權指數日報酬（不含截距）
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
// 原始價格（沒有還原）：網頁顯示用；分割後的價格比例不變，用還原後的最近收盤即可
const lastL = (date: string) => {
  const i = dIdx.get(date)!;
  return lClose.get(taiex[i - 1][0]) ?? null;
};
// 下一個交易日開盤前的資料（網頁即時預測用）
const nextCtx = dailyCtx(taiex.length)!;
const lastDate = taiex[taiex.length - 1][0];

writeFileSync(
  join(dir, 'predict-intraday.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    ready: true,
    beta: r5(beta),
    model: {
      mean: final.mean.map(r5),
      sd: final.sd.map(r5),
      coef: final.coef.map((b) => b.map(r5)),
      resid: final.resid.map((row) => row.map(r5)),
    },
    verdict: useful.length ? 'signal' : 'none',
    backtest: { from: days[FIRST]?.date, to: days.at(-1)!.date, days: days.length - FIRST, byH, closeByTime },
    next: { after: lastDate, P0: taiex[taiex.length - 1][4], L0: lClose.get(lastDate) ?? null, ctx: Object.fromEntries(Object.entries(nextCtx).map(([k, v]) => [k, r5(v)])) },
    // 最近 10 天（回放用）：當天 5 分 K、昨收、00631L 昨收、開盤前資料
    recent: days.slice(-10).map((d) => ({ date: d.date, P0: d.P0, L0: lastL(d.date), ix: d.ix, ctx: Object.fromEntries(Object.entries(d.ctx).map(([k, v]) => [k, r5(v)])) })),
  }),
);
console.log(`β ${beta.toFixed(3)}；predict-intraday.json 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
