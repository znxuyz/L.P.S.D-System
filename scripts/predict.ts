/**
 * L.P.L.C. 預測（部署時執行，不連網）：
 *
 *   node scripts/predict.ts <資料資料夾>
 *
 * 三個模型，全部「逐段往前滾」訓練（walk-forward）：每個時間點只用那天以前、結果已經揭曉的資料訓練，
 * 再預測之後；回測成績都是樣本外的，跟實際使用時一樣。
 *
 * 1. 個股 20 日排名：每 5 個交易日一個截面，16 個因子（動能、量能、法人、融資、估值、財報成長…）各自排名，
 *    用嶺迴歸預測未來 20 日報酬的排名；每 20 個交易日重新訓練。
 * 2. 大盤 20 日方向：加權指數走勢、市場廣度、融資維持率、外資期貨淨未平倉、法人買賣超…，
 *    邏輯迴歸算上漲機率、嶺迴歸算預期報酬。
 * 3. 00631L 當沖：開盤跳空＋前一天的資料，預測當天「開盤買、收盤賣」的報酬；扣掉交易成本還有優勢才出手。
 *
 * 輸出 predict.json（網頁「預測」頁）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { canArchive, readPreOpen, writeArchive } from './lib/archive.ts';
import { loadUs, usMove } from './lib/us.ts';
import { loadTx, nightMove } from './lib/txNight.ts';
import { loadFinQuarters } from './lib/finQuarters.ts';
import { dot, logistic, maxDrawdown, mean, rankCenter, ridge, sigmoid, spearman, standardizer, std } from './lib/ml.ts';

type Row = [string, number, number, number, number, number];
const dir = process.argv[2] ?? 'data';
const read = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
const listDates = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() : []);
const r4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const t0 = Date.now();

const H = 20; // 預測天數
const STEP = 5; // 截面間隔
const REFIT = 20; // 重新訓練間隔
/**
 * 歷史模擬存檔（給模擬帳戶回測用）：BACKFILL_DIR 有設時，把逐段往前滾回測裡「每一天開盤前會做出的預測」
 * 照存檔的格式寫出來（只寫 BACKFILL_FROM～BACKFILL_TO 之間）。每一天的預測只用那天以前的資料，跟事前存檔一樣不會看答案。
 */
const BF_DIR = process.env.BACKFILL_DIR;
const BF_FROM = process.env.BACKFILL_FROM ?? '0000';
const BF_TO = process.env.BACKFILL_TO ?? '9999';
const bfDaily = new Map<string, { stocks?: { top: string[]; all?: Record<string, number>; turn?: Record<string, number> }; dayTrade?: unknown }>();
const bfPut = (asOf: string, part: object) => {
  if (!BF_DIR || asOf < BF_FROM || asOf > BF_TO) return;
  bfDaily.set(asOf, { ...(bfDaily.get(asOf) ?? {}), ...part });
};

// ---------------------------------------------------------------- 日曆與大盤
// 加權指數下午就更新，個股日 K 晚上才更新：以「大型股都已經有資料」的最後一天為準，避免用到抓一半的資料
const SAMPLE = ['2330', '2317', '2454', '2412', '2882'];
const sampleLast = SAMPLE.map((c) => read<Row[]>(join(dir, 'candles', `${c}.json`), []).at(-1)?.[0]).filter((d): d is string => !!d).sort();
const cutoff = sampleLast.length >= 3 ? sampleLast[sampleLast.length - 3] : '9999-12-31';
const taiex = read<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []).filter((r) => r[0] <= cutoff);
const cal = taiex.map((r) => r[0]);
const T = cal.length;
const calIdx = new Map(cal.map((d, i) => [d, i]));
const ixOpen = taiex.map((r) => r[1]);
const ixClose = taiex.map((r) => r[4]);
console.log(`日曆 ${T} 天：${cal[0]} ～ ${cal[T - 1]}`);
// 只存檔（ARCHIVE_ONLY）而且不在存檔時間內：不用算
if (process.env.ARCHIVE_ONLY && !canArchive(cal[T - 1])) {
  console.log(`事前存檔：現在不是 ${cal[T - 1]} 收盤後到下一個交易日開盤前，不算`);
  process.exit(0);
}

// ---------------------------------------------------------------- 個股日 K（分割還原、對齊日曆）
const exDays = new Map<string, Set<string>>();
for (const f of existsSync(join(dir, 'exrights')) ? readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);

interface Stock {
  code: string;
  open: Float64Array;
  close: Float64Array; // 往前補值（停牌沿用）
  has: Uint8Array; // 當天有交易
  high: Float64Array;
  low: Float64Array;
  vol: Float64Array; // 張
  turn: Float64Array; // 億元
  first: number;
}
const nanArr = () => new Float64Array(T).fill(NaN);
function loadStock(code: string): Stock | null {
  const raw = read<Row[]>(join(dir, 'candles', `${code}.json`), []);
  if (raw.length < 80) return null;
  const bars = raw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  const adj = adjustForSplits(bars, detectSplits(bars, exDays.get(code)), '9999-12-31');
  const s: Stock = { code, open: nanArr(), close: nanArr(), has: new Uint8Array(T), high: nanArr(), low: nanArr(), vol: new Float64Array(T), turn: new Float64Array(T), first: T };
  for (let k = 0; k < bars.length; k++) {
    const i = calIdx.get(bars[k].date);
    if (i == null || !(adj[k].close > 0)) continue;
    s.open[i] = adj[k].open;
    s.close[i] = adj[k].close;
    s.high[i] = adj[k].high;
    s.low[i] = adj[k].low;
    s.vol[i] = bars[k].volume;
    s.turn[i] = (bars[k].volume * 1000 * ((bars[k].open + bars[k].high + bars[k].low + bars[k].close) / 4)) / 1e8;
    s.has[i] = 1;
    s.first = Math.min(s.first, i);
  }
  for (let i = s.first + 1; i < T; i++) if (!s.has[i]) s.close[i] = s.close[i - 1];
  return s;
}
const stocks: Stock[] = [];
// 只放個股（00 開頭的是 ETF）
for (const f of readdirSync(join(dir, 'candles')).filter((f) => /^[1-9]\d{3}\.json$/.test(f))) {
  const s = loadStock(f.slice(0, 4));
  if (s) stocks.push(s);
}
const N = stocks.length;
const sIdx = new Map(stocks.map((s, i) => [s.code, i]));
const names = read<Record<string, string>>(join(dir, 'names.json'), {});
console.log(`個股 ${N} 檔（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

// ---------------------------------------------------------------- 每日的法人、估值、融資（對齊成 [股票][日]）
const grid = () => Array.from({ length: N }, () => nanArr());
const inst = grid(); // 外資＋投信＋自營（股）
const pe = grid();
const yld = grid();
const pb = grid();
const marginLots = grid();
const instTotal = new Float64Array(T); // 全市場法人買賣超（億元）
for (const d of listDates('inst')) {
  const i = calIdx.get(d);
  if (i == null) continue;
  const day = read<Record<string, number>>(join(dir, 'inst', `${d}.json`), {});
  for (const [code, v] of Object.entries(day)) {
    const k = sIdx.get(code);
    if (k == null) continue;
    inst[k][i] = v;
    const c = stocks[k].close[i];
    if (Number.isFinite(c)) instTotal[i] += (v * c) / 1e8;
  }
}
for (const d of listDates('ratios')) {
  const i = calIdx.get(d);
  if (i == null) continue;
  for (const [code, [p, y, b]] of Object.entries(read<Record<string, [number, number, number]>>(join(dir, 'ratios', `${d}.json`), {}))) {
    const k = sIdx.get(code);
    if (k == null) continue;
    pe[k][i] = p;
    yld[k][i] = y;
    pb[k][i] = b;
  }
}
for (const d of listDates('margin')) {
  const i = calIdx.get(d);
  if (i == null) continue;
  const m = read<{ perStock?: Record<string, number> }>(join(dir, 'margin', `${d}.json`), {});
  for (const [code, lots] of Object.entries(m.perStock ?? {})) {
    const k = sIdx.get(code);
    if (k != null) marginLots[k][i] = lots;
  }
}
// 估值資料不是每天都有（假日、缺檔）：往前補值最多 5 天
for (const g of [pe, yld, pb])
  for (const a of g)
    for (let i = 1, gap = 0; i < T; i++) {
      if (Number.isFinite(a[i])) gap = 0;
      else if (++gap <= 5) a[i] = a[i - 1];
    }
console.log(`法人、估值、融資（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

// 財報：最新已公布一季的 EPS 年增、營收年增
const { byCode: finBy } = loadFinQuarters(join(dir, 'fin'));
const epsYoy = grid();
const revYoy = grid();
for (const [code, qs] of finBy) {
  const k = sIdx.get(code);
  if (k == null) continue;
  const byLabel = new Map(qs.map((q) => [q[0], q]));
  const sorted = [...qs].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  let p = -1;
  for (let i = 0; i < T; i++) {
    while (p + 1 < sorted.length && sorted[p + 1][1] < cal[i]) p++;
    if (p < 0) continue;
    const q = sorted[p];
    const ly = byLabel.get(`${Number(q[0].slice(0, 4)) - 1}${q[0].slice(4)}`);
    const g = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b !== 0 ? Math.max(-3, Math.min(3, (a - b) / Math.abs(b))) : NaN);
    epsYoy[k][i] = g(q[6], ly?.[6]);
    revYoy[k][i] = g(q[2], ly?.[2]);
  }
}

// 大盤風險（融資維持率、外資期貨）
const risk = read<{ rows: Array<[string, number | null, number, number, number, number | null]> }>(join(dir, 'market-risk.json'), { rows: [] });
const mRatio = nanArr();
const mAmt = nanArr();
const mShort = nanArr();
const futNet = nanArr();
for (const r of risk.rows) {
  const i = calIdx.get(r[0]);
  if (i == null) continue;
  if (r[1] != null) mRatio[i] = r[1];
  if (r[2]) mAmt[i] = r[2];
  if (r[3]) mShort[i] = r[4] / r[3];
  if (r[5] != null) futNet[i] = r[5];
}

// ---------------------------------------------------------------- 滾動計算的小工具
function rollMean(a: ArrayLike<number>, n: number, i: number): number {
  let s = 0;
  let c = 0;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (Number.isFinite(a[j])) (s += a[j]), c++;
  return c >= n / 2 ? s / c : NaN;
}
function rollSum(a: ArrayLike<number>, n: number, i: number): number {
  let s = 0;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (Number.isFinite(a[j])) s += a[j];
  return s;
}
const ret = (a: ArrayLike<number>, i: number, n: number) => (i - n >= 0 && a[i - n] > 0 && a[i] > 0 ? a[i] / a[i - n] - 1 : NaN);
function retStd(a: ArrayLike<number>, i: number, n: number): number {
  const r: number[] = [];
  for (let j = Math.max(1, i - n + 1); j <= i; j++) if (a[j] > 0 && a[j - 1] > 0) r.push(a[j] / a[j - 1] - 1);
  return r.length >= n / 2 ? std(r) : NaN;
}
function rollMax(a: ArrayLike<number>, n: number, i: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (a[j] > m) m = a[j];
  return Number.isFinite(m) ? m : NaN;
}

// ================================================================ 1. 個股 20 日排名
const FEATS = [
  { id: 'r5', name: '近 5 日漲跌', hi: '近一週強勢', lo: '近一週弱勢' },
  { id: 'r20', name: '近 20 日漲跌', hi: '近一個月強勢', lo: '近一個月弱勢' },
  { id: 'mom', name: '中期動能（12－1 個月）', hi: '中期趨勢向上', lo: '中期趨勢向下' },
  { id: 'dist52', name: '離一年高點', hi: '接近一年高點', lo: '離一年高點很遠' },
  { id: 'ma60', name: '站上季線幅度', hi: '站穩季線之上', lo: '在季線之下' },
  { id: 'vol20', name: '波動度', hi: '波動大', lo: '波動小、走勢穩' },
  { id: 'turnRatio', name: '量能（5 日／60 日）', hi: '最近成交量放大', lo: '最近量縮' },
  { id: 'size', name: '成交規模', hi: '大型熱門股', lo: '冷門小型股' },
  { id: 'inst5', name: '法人近 5 日買賣超', hi: '法人近一週買超', lo: '法人近一週賣超' },
  { id: 'inst20', name: '法人近 20 日買賣超', hi: '法人近一個月買超', lo: '法人近一個月賣超' },
  { id: 'margin20', name: '融資近 20 日增減', hi: '融資增加（散戶追價）', lo: '融資減少（籌碼較乾淨）' },
  { id: 'ep', name: '盈餘殖利率（1／本益比）', hi: '本益比低', lo: '本益比高或虧損' },
  { id: 'yld', name: '現金殖利率', hi: '殖利率高', lo: '殖利率低' },
  { id: 'bp', name: '淨值股價比（1／PB）', hi: '股價淨值比低', lo: '股價淨值比高' },
  { id: 'epsYoy', name: 'EPS 年增', hi: '獲利成長', lo: '獲利衰退' },
  { id: 'revYoy', name: '營收年增', hi: '營收成長', lo: '營收衰退' },
] as const;
const K = FEATS.length;

function stockFeatures(s: Stock, k: number, i: number): number[] {
  const c = s.close;
  const avgVol20 = rollMean(s.vol, 20, i) * 1000;
  const f = new Array(K).fill(NaN);
  f[0] = ret(c, i, 5);
  f[1] = ret(c, i, 20);
  f[2] = i >= 250 && c[i - 250] > 0 ? c[i - 20] / c[i - 250] - 1 : NaN;
  const h = rollMax(s.high, 250, i);
  f[3] = h > 0 ? c[i] / h - 1 : NaN;
  const m60 = rollMean(c, 60, i);
  f[4] = m60 > 0 ? c[i] / m60 - 1 : NaN;
  f[5] = retStd(c, i, 20);
  const t60 = rollMean(s.turn, 60, i);
  f[6] = t60 > 0 ? rollMean(s.turn, 5, i) / t60 : NaN;
  f[7] = Math.log(Math.max(1e-3, rollMean(s.turn, 20, i)));
  f[8] = avgVol20 > 0 ? rollSum(inst[k], 5, i) / avgVol20 : NaN;
  f[9] = avgVol20 > 0 ? rollSum(inst[k], 20, i) / avgVol20 : NaN;
  const ml = marginLots[k];
  f[10] = avgVol20 > 0 && Number.isFinite(ml[i]) && i >= 20 && Number.isFinite(ml[i - 20]) ? ((ml[i] - ml[i - 20]) * 1000) / avgVol20 : NaN;
  f[11] = Number.isFinite(pe[k][i]) ? (pe[k][i] > 0 ? 1 / pe[k][i] : 0) : NaN;
  f[12] = yld[k][i];
  f[13] = Number.isFinite(pb[k][i]) && pb[k][i] > 0 ? 1 / pb[k][i] : NaN;
  f[14] = epsYoy[k][i];
  f[15] = revYoy[k][i];
  return f;
}

// 截面日：從最後一天往回每 5 天
const sectionDays: number[] = [];
for (let i = T - 1; i >= 260; i -= STEP) sectionDays.unshift(i);
interface Section {
  i: number;
  codes: number[];
  X: Float64Array[]; // 每個因子一欄（已排名）
  raw: number[][];
  fwd: Float64Array; // 未來 20 日報酬
  y: Float64Array; // 未來報酬排名
}
const sections: Section[] = [];
for (const i of sectionDays) {
  const codes: number[] = [];
  const raw: number[][] = [];
  for (let k = 0; k < N; k++) {
    const s = stocks[k];
    if (!s.has[i] || i - s.first < 120) continue;
    // 流動性：近 20 日平均成交額至少 0.3 億
    if (!(rollMean(s.turn, 20, i) >= 0.3)) continue;
    codes.push(k);
    raw.push(stockFeatures(s, k, i));
  }
  const X = FEATS.map((_, j) => rankCenter(raw.map((r) => r[j])));
  const fwd = new Float64Array(codes.length).fill(NaN);
  if (i + H < T) codes.forEach((k, n) => (fwd[n] = ret(stocks[k].close, i + H, H)));
  sections.push({ i, codes, X, raw, fwd, y: rankCenter(fwd) });
}
console.log(`截面 ${sections.length} 個（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

// 每個因子放「排名」和「排名平方」：平方項抓「太極端反而不好」（例如漲太多、波動太大）的非線性關係
const QUAD = process.env.QUAD !== '0';
const rowOf = (sec: Section, n: number) => {
  const r = FEATS.map((_, j) => sec.X[j][n]);
  return QUAD ? [...r, ...r.map((v) => v * v - 1 / 12)] : r;
};
let beta: number[] | null = null;
let lastFit = -Infinity;
const FIRST_FIT = 250 + 250; // 至少一年的訓練資料
const scoreBy: Array<Float64Array | null> = [];
for (let si = 0; si < sections.length; si++) {
  const sec = sections[si];
  if (sec.i < FIRST_FIT) {
    scoreBy.push(null);
    continue;
  }
  if (sec.i - lastFit >= REFIT || !beta) {
    // 只用「結果已經揭曉」的截面：sec' + 20 天 ≤ 今天
    const Xs: number[][] = [];
    const ys: number[] = [];
    for (const p of sections) {
      if (p.i + H > sec.i) break;
      for (let n = 0; n < p.codes.length; n++) if (Number.isFinite(p.fwd[n])) Xs.push(rowOf(p, n)), ys.push(p.y[n]);
    }
    beta = ridge(Xs, ys, 0.002);
    lastFit = sec.i;
  }
  const sc = new Float64Array(sec.codes.length);
  for (let n = 0; n < sec.codes.length; n++) sc[n] = dot(beta, rowOf(sec, n));
  scoreBy.push(sc);
  if (BF_DIR) {
    const ord = [...sec.codes.keys()].sort((a, b) => sc[b] - sc[a]);
    // all：每檔的排名分數（100＝最看好）；turn：近 20 日平均成交額（億），給「只在大型股裡挑」之類的策略用
    bfPut(cal[sec.i], {
      stocks: {
        top: ord.slice(0, 30).map((n) => stocks[sec.codes[n]].code),
        all: Object.fromEntries(ord.map((n, r) => [stocks[sec.codes[n]].code, Math.round((1 - r / Math.max(1, ord.length - 1)) * 1000) / 10])),
        turn: Object.fromEntries(sec.codes.map((k) => [stocks[k].code, Math.round(rollMean(stocks[k].turn, 20, sec.i) * 100) / 100])),
      },
    });
  }
}

// 回測：每個截面的 IC；每 20 天換一次的「前 10%」組合
const COST = 0.001425 * 2 * 0.6 + 0.003; // 手續費 6 折來回＋證交稅
const ics: Array<[string, number]> = [];
const curve: Array<[string, number, number, number]> = []; // [日期, 前 10% 淨值, 全部平均, 大盤]
let eqTop = 1;
let eqAll = 1;
let eqMkt = 1;
let beat = 0;
let periods = 0;
const topRets: number[] = [];
const excessRets: number[] = [];
let lastReb = -Infinity;
for (let si = 0; si < sections.length; si++) {
  const sec = sections[si];
  const sc = scoreBy[si];
  if (!sc || sec.i + H >= T) continue;
  const ic = spearman(sc, sec.fwd);
  if (Number.isFinite(ic)) ics.push([cal[sec.i], ic]);
  if (sec.i - lastReb < H) continue;
  lastReb = sec.i;
  const order = [...sec.codes.keys()].filter((n) => Number.isFinite(sec.fwd[n])).sort((a, b) => sc[b] - sc[a]);
  const top = order.slice(0, Math.max(10, Math.round(order.length * 0.1)));
  const rTop = mean(top.map((n) => sec.fwd[n])) - COST;
  const rAll = mean(order.map((n) => sec.fwd[n]));
  const rMkt = ixClose[sec.i + H] / ixClose[sec.i] - 1;
  if (!curve.length) curve.push([cal[sec.i], 1, 1, 1]);
  eqTop *= 1 + rTop;
  eqAll *= 1 + rAll;
  eqMkt *= 1 + rMkt;
  curve.push([cal[sec.i + H], r4(eqTop)!, r4(eqAll)!, r4(eqMkt)!]);
  topRets.push(rTop);
  excessRets.push(rTop - rMkt);
  if (rTop > rMkt) beat++;
  periods++;
}
if (process.env.DIAG) {
  const dec = Array.from({ length: 10 }, () => [] as number[]);
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const sc = scoreBy[si];
    if (!sc || sec.i + H >= T) continue;
    const ord = [...sec.codes.keys()].filter((n) => Number.isFinite(sec.fwd[n])).sort((a, b) => sc[b] - sc[a]);
    const all = mean(ord.map((n) => sec.fwd[n]));
    for (let d = 0; d < 10; d++) dec[d].push(mean(ord.slice(Math.floor((d * ord.length) / 10), Math.floor(((d + 1) * ord.length) / 10)).map((n) => sec.fwd[n])) - all);
  }
  console.log('十分位（20 日報酬減全體平均，%）', dec.map((d) => (mean(d) * 100).toFixed(2)).join(' '));
  console.log('各因子權重', FEATS.map((f, j) => `${f.id}:${beta![j + 1].toFixed(3)}`).join(' '));
}
const icVals = ics.map((x) => x[1]);
const years = periods * H / 250;
const stockBacktest = {
  from: curve[0]?.[0] ?? null,
  to: curve.at(-1)?.[0] ?? null,
  periods,
  icMean: r4(mean(icVals)),
  icPositive: r4(icVals.filter((v) => v > 0).length / (icVals.length || 1)),
  // 截面重疊（每 5 天一個、看 20 天），t 值用約 1／4 的有效樣本數
  icT: r4((mean(icVals) / (std(icVals) || 1)) * Math.sqrt(icVals.length / 4)),
  hitRate: r4(beat / (periods || 1)),
  cagrTop: r4(eqTop ** (1 / (years || 1)) - 1),
  cagrMarket: r4(eqMkt ** (1 / (years || 1)) - 1),
  avgExcess: r4(mean(excessRets)),
  maxDD: r4(maxDrawdown(curve.map((c) => c[1]))),
  cost: r4(COST),
  curve,
  ic: ics.filter((_, i) => i % 2 === 0).map(([d, v]) => [d, r4(v)]),
};

// ---------------------------------------------------------------- 進場、出場點（最看好的股票）
/**
 * 訊號在第 i0 天收盤後產生。依這檔近 14 天的平均振幅（ATR%）：
 * - 進場：a＝0 隔天開盤買；a＞0 掛「收盤 ×（1 − a×ATR）」的限價，3 個交易日內沒買到就放棄（跳空開更低時用開盤價成交）。
 * - 停利 收盤價 ×（1 ＋ b×ATR）、停損 ×（1 − c×ATR），以「進場價」為基準；Infinity＝不設。
 * - 最晚在第 i0＋20 天收盤出場。
 * 模擬保守：同一天同時碰到停利與停損當作先停損；買進當天只檢查停損。
 */
interface Plan { a: number; b: number; c: number }
const PLANS: Plan[] = [];
for (const a of [0, 0.5, 1, 1.5]) for (const b of [Infinity, 2, 3, 4]) for (const c of [Infinity, 1.5, 2.5, 4]) PLANS.push({ a, b, c });
function atrPct(st: Stock, i: number): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - 13); j <= i; j++) if (st.has[j] && st.close[j] > 0) (sum += (st.high[j] - st.low[j]) / st.close[j]), n++;
  return n >= 7 ? sum / n : NaN;
}
/** 回傳淨報酬（沒成交是 null）與持有天數。 */
function simTrade(st: Stock, i0: number, pl: Plan): { r: number | null; days: number; exit: string } {
  const atr = atrPct(st, i0);
  const c0 = st.close[i0];
  if (!(atr > 0) || !(c0 > 0)) return { r: null, days: 0, exit: 'none' };
  const end = Math.min(T - 1, i0 + H);
  let entry = NaN;
  let fillDay = -1;
  for (let d = i0 + 1; d <= Math.min(end, i0 + (pl.a > 0 ? 3 : 1)); d++) {
    if (!st.has[d]) continue;
    if (pl.a === 0) entry = st.open[d];
    else {
      const lim = c0 * (1 - pl.a * atr);
      if (st.low[d] <= lim) entry = Math.min(st.open[d], lim);
    }
    if (entry > 0) {
      fillDay = d;
      break;
    }
  }
  if (fillDay < 0) return { r: null, days: 0, exit: 'none' };
  const tgt = entry * (1 + pl.b * atr);
  const stp = entry * (1 - pl.c * atr);
  for (let d = fillDay; d <= end; d++) {
    if (!st.has[d]) continue;
    if (d > fillDay) {
      if (st.open[d] <= stp) return { r: st.open[d] / entry - 1 - COST, days: d - fillDay, exit: 'stop' };
      if (st.open[d] >= tgt) return { r: st.open[d] / entry - 1 - COST, days: d - fillDay, exit: 'target' };
    }
    if (st.low[d] <= stp) return { r: stp / entry - 1 - COST, days: d - fillDay, exit: 'stop' };
    if (d > fillDay && st.high[d] >= tgt) return { r: tgt / entry - 1 - COST, days: d - fillDay, exit: 'target' };
  }
  return { r: st.close[end] / entry - 1 - COST, days: end - fillDay, exit: 'time' };
}
// 每 20 天一期：這一期最看好的 30 檔，模擬每一種進出場方式
interface EePeriod { i: number; picks: number[]; res: Array<Array<{ r: number | null; days: number; exit: string }>> }
const eePeriods: EePeriod[] = [];
{
  let lastP = -Infinity;
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const sc = scoreBy[si];
    if (!sc || sec.i - lastP < H) continue;
    lastP = sec.i;
    const picks = [...sec.codes.keys()].sort((a, b) => sc[b] - sc[a]).slice(0, 30).map((n) => sec.codes[n]);
    eePeriods.push({ i: sec.i, picks, res: PLANS.map((pl) => picks.map((k) => simTrade(stocks[k], sec.i, pl))) });
  }
}
/** 一種進出場方式在一組期間的平均報酬（每個訊號平均，沒成交算 0：沒買到的錢沒在賺）。 */
const planScore = (ps: EePeriod[], pi: number) => mean(ps.flatMap((p) => p.res[pi].filter((x) => p.i + H + 1 < T || x.r != null).map((x) => x.r ?? 0)));
// 逐段往前滾：每一期只用「已經結束的期間」挑最好的方式（不看答案）
const BASE_PLAN = PLANS.findIndex((p) => p.a === 0 && p.b === Infinity && p.c === Infinity);
const chosen: Array<{ p: EePeriod; pi: number }> = [];
for (let k = 0; k < eePeriods.length; k++) {
  const done = eePeriods.slice(0, k).filter((p) => p.i + H + 1 <= eePeriods[k].i);
  let best = BASE_PLAN;
  if (done.length >= 6) {
    let bs = -Infinity;
    PLANS.forEach((_, pi) => {
      const v = planScore(done, pi);
      if (v > bs) (bs = v), (best = pi);
    });
  }
  chosen.push({ p: eePeriods[k], pi: best });
}
const evalSet = chosen.filter(({ p }) => p.i + H < T);
const statOf = (rows: Array<{ r: number | null; days: number; exit: string }>) => {
  const filled = rows.filter((x) => x.r != null) as Array<{ r: number; days: number; exit: string }>;
  return {
    signals: rows.length,
    fill: r4(filled.length / (rows.length || 1)),
    perSignal: r4(mean(rows.map((x) => x.r ?? 0))),
    perTrade: r4(mean(filled.map((x) => x.r))),
    win: r4(filled.filter((x) => x.r > 0).length / (filled.length || 1)),
    days: r4(mean(filled.map((x) => x.days))),
    // 風險：最慘的一筆、最差 10% 的那一筆（第 10 百分位）
    worst: r4(Math.min(...filled.map((x) => x.r))),
    p10: r4([...filled.map((x) => x.r)].sort((a, b) => a - b)[Math.floor(filled.length * 0.1)] ?? NaN),
    target: r4(filled.filter((x) => x.exit === 'target').length / (filled.length || 1)),
    stop: r4(filled.filter((x) => x.exit === 'stop').length / (filled.length || 1)),
  };
};
const planName = (pl: Plan) =>
  `${pl.a === 0 ? '隔天開盤買' : `拉回 ${pl.a}×ATR 限價買`}、${pl.b === Infinity ? '不設停利' : `停利 +${pl.b}×ATR`}、${pl.c === Infinity ? '不設停損' : `停損 −${pl.c}×ATR`}`;
const nowPlan = (() => {
  const done = eePeriods.filter((p) => p.i + H + 1 <= T - 1);
  let best = BASE_PLAN;
  let bs = -Infinity;
  if (done.length >= 6) PLANS.forEach((_, pi) => {
    const v = planScore(done, pi);
    if (v > bs) (bs = v), (best = pi);
  });
  return PLANS[best];
})();
const entryExit = {
  plan: { ...nowPlan, b: Number.isFinite(nowPlan.b) ? nowPlan.b : null, c: Number.isFinite(nowPlan.c) ? nowPlan.c : null, name: planName(nowPlan) },
  // 樣本外（逐段往前滾挑方式）vs 一律隔天開盤買、20 天後賣
  backtest: {
    periods: evalSet.length,
    strategy: statOf(evalSet.flatMap(({ p, pi }) => p.res[pi])),
    baseline: statOf(evalSet.flatMap(({ p }) => p.res[BASE_PLAN])),
    // 幾種固定的參考方式（事先定好、不是看結果挑的）：看報酬與風險的取捨
    reference: [
      { a: 0, b: Infinity, c: 2.5 },
      { a: 0, b: 3, c: 2.5 },
      { a: 1, b: Infinity, c: Infinity },
      { a: 1, b: 3, c: 2.5 },
    ].map((pl) => {
      const pi = PLANS.findIndex((x) => x.a === pl.a && x.b === pl.b && x.c === pl.c);
      return { name: planName(pl), ...statOf(evalSet.flatMap(({ p }) => p.res[pi])) };
    }),
    // 每一期挑到哪一種
    picked: evalSet.map(({ p, pi }) => [cal[p.i], planName(PLANS[pi])]).slice(-12),
  },
};
console.log(`進出場：目前用「${planName(nowPlan)}」；樣本外每個訊號 ${entryExit.backtest.strategy.perSignal}（成交率 ${entryExit.backtest.strategy.fill}、勝率 ${entryExit.backtest.strategy.win}） vs 隔天買抱 20 天 ${entryExit.backtest.baseline.perSignal}`);
/** 最看好的股票：用目前挑到的方式算出價位。 */
function levelsOf(k: number) {
  const st = stocks[k];
  const i = T - 1;
  const atr = atrPct(st, i);
  const c0 = st.close[i];
  if (!(atr > 0) || !(c0 > 0)) return null;
  const entry = nowPlan.a === 0 ? null : c0 * (1 - nowPlan.a * atr);
  const base = entry ?? c0;
  return {
    atr: r4(atr),
    entry: entry == null ? null : r4(entry),
    target: Number.isFinite(nowPlan.b) ? r4(base * (1 + nowPlan.b * atr)) : null,
    stop: Number.isFinite(nowPlan.c) ? r4(base * (1 - nowPlan.c * atr)) : null,
    // 參考停損（想控制風險時用）：收盤 ×（1 − 2.5×ATR）
    refStop: r4(c0 * (1 - 2.5 * atr)),
  };
}

// 最新一天的排名與原因
const last = sections[sections.length - 1];
const lastScore = scoreBy[scoreBy.length - 1]!;
const order = [...last.codes.keys()].sort((a, b) => lastScore[b] - lastScore[a]);
const pctOf = new Map(order.map((n, r) => [n, 1 - r / Math.max(1, order.length - 1)]));
function reasons(n: number, sign: 1 | -1): Array<[string, number]> {
  const contrib = FEATS.map((f, j) => {
    const x = last.X[j][n];
    return { j, c: beta![j + 1] * x + (QUAD ? beta![j + 1 + K] * (x * x - 1 / 12) : 0) };
  });
  return contrib
    .filter((x) => sign * x.c > 0)
    .sort((a, b) => sign * (b.c - a.c))
    .slice(0, 3)
    .map(({ j, c }) => [last.X[j][n] > 0 ? FEATS[j].hi : FEATS[j].lo, r4(c)!]);
}
const pickRow = (n: number, sign: 1 | -1) => {
  const code = stocks[last.codes[n]].code;
  return { code, name: names[code] ?? '', score: Math.round(pctOf.get(n)! * 100), close: r4(stocks[last.codes[n]].close[last.i]), reasons: reasons(n, sign), ...(sign > 0 ? { levels: levelsOf(last.codes[n]) } : {}) };
};
const stockOut = {
  asOf: cal[last.i],
  universe: last.codes.length,
  top: order.slice(0, 30).map((n) => pickRow(n, 1)),
  bottom: order.slice(-15).reverse().map((n) => pickRow(n, -1)),
  // 全部的分數（0～100），個股頁或之後的功能用
  all: Object.fromEntries(order.map((n) => [stocks[last.codes[n]].code, Math.round(pctOf.get(n)! * 100)])),
  weights: FEATS.map((f, j) => ({ id: f.id, name: f.name, w: r4(beta![j + 1]) })),
  backtest: stockBacktest,
  entryExit,
  // 有沒有預測能力：排名相關係數顯著為正（t > 2）
  verdict: (stockBacktest.icT ?? 0) > 2 ? 'signal' : 'none',
};
console.log(`個股：IC ${stockBacktest.icMean}（t ${stockBacktest.icT}）、勝大盤 ${stockBacktest.hitRate}、前 10% 年化 ${stockBacktest.cagrTop} vs 大盤 ${stockBacktest.cagrMarket}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

// ================================================================ 2. 大盤 20 日方向
// 市場廣度：站上季線的股票比例
const breadth = nanArr();
for (let i = 60; i < T; i++) {
  let up = 0;
  let n = 0;
  for (const s of stocks) {
    if (!s.has[i] || i - s.first < 60) continue;
    const m = rollMean(s.close, 60, i);
    if (!(m > 0)) continue;
    n++;
    if (s.close[i] > m) up++;
  }
  breadth[i] = n ? up / n : NaN;
}
const MKT = [
  { id: 'r5', name: '大盤近 5 日漲跌' },
  { id: 'r20', name: '大盤近 20 日漲跌' },
  { id: 'r60', name: '大盤近 60 日漲跌' },
  { id: 'ma60', name: '大盤離季線' },
  { id: 'vol20', name: '大盤波動度' },
  { id: 'breadth', name: '站上季線的股票比例' },
  { id: 'breadth20', name: '廣度近 20 日變化' },
  { id: 'mRatio', name: '融資維持率' },
  { id: 'mAmt20', name: '融資餘額 20 日增減' },
  { id: 'short', name: '券資比' },
  { id: 'fut', name: '外資台指期淨未平倉' },
  { id: 'fut5', name: '外資期貨 5 日增減' },
  { id: 'inst20', name: '法人近 20 日買賣超' },
] as const;
function marketFeatures(i: number): number[] {
  const m60 = rollMean(ixClose, 60, i);
  return [
    ret(ixClose, i, 5),
    ret(ixClose, i, 20),
    ret(ixClose, i, 60),
    m60 > 0 ? ixClose[i] / m60 - 1 : NaN,
    retStd(ixClose, i, 20),
    breadth[i],
    i >= 20 ? breadth[i] - breadth[i - 20] : NaN,
    mRatio[i],
    i >= 20 && mAmt[i - 20] > 0 ? mAmt[i] / mAmt[i - 20] - 1 : NaN,
    mShort[i],
    futNet[i] / 1e4,
    i >= 5 && Number.isFinite(futNet[i - 5]) ? (futNet[i] - futNet[i - 5]) / 1e4 : NaN,
    rollSum(instTotal, 20, i) / 100,
  ];
}
const mX = cal.map((_, i) => (i >= 120 ? marketFeatures(i) : null));
const mY = cal.map((_, i) => (i + H < T ? ixClose[i + H] / ixClose[i] - 1 : NaN));
const MFIRST = 500;
// 獨立樣本很少（6 年約 80 段不重疊的 20 天），用較強的 L2 讓模型沒有足夠證據時貼近基本上漲率
const MLAMBDA = Number(process.env.MLAMBDA ?? 0.5);
let mFit: { st: ReturnType<typeof standardizer>; logit: number[]; lin: number[] } | null = null;
let mLast = -Infinity;
const mPred: Array<{ i: number; p: number; e: number }> = [];
for (let i = MFIRST; i < T; i++) {
  if (!mFit || i - mLast >= REFIT) {
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let j = 120; j + H <= i; j++) if (mX[j] && Number.isFinite(mY[j])) rows.push(mX[j]!), ys.push(mY[j]);
    const st = standardizer(rows);
    const Z = rows.map(st.apply);
    mFit = { st, logit: logistic(Z, ys.map((v) => (v > 0 ? 1 : 0)), MLAMBDA), lin: ridge(Z, ys, MLAMBDA) };
    mLast = i;
  }
  const z = mFit.st.apply(mX[i]!);
  mPred.push({ i, p: sigmoid(dot(mFit.logit, z)), e: dot(mFit.lin, z) });
}
// 回測
const mOOS = mPred.filter((x) => x.i + H < T);
const acc = mean(mOOS.map((x) => ((x.p > 0.5) === (mY[x.i] > 0) ? 1 : 0)));
const baseUp = mean(mOOS.map((x) => (mY[x.i] > 0 ? 1 : 0)));
const brier = mean(mOOS.map((x) => (x.p - (mY[x.i] > 0 ? 1 : 0)) ** 2));
const brierBase = mean(mOOS.map((x) => (baseUp - (mY[x.i] > 0 ? 1 : 0)) ** 2));
const mCurve: Array<[string, number, number]> = [];
let eqS = 1;
let eqB = 1;
for (let k = 0; k < mOOS.length; k += H) {
  const x = mOOS[k];
  if (!mCurve.length) mCurve.push([cal[x.i], 1, 1]);
  eqB *= 1 + mY[x.i];
  eqS *= 1 + (x.p > 0.5 ? mY[x.i] : 0);
  mCurve.push([cal[x.i + H], r4(eqS)!, r4(eqB)!]);
}
const mNow = mPred[mPred.length - 1];
const zNow = mFit!.st.apply(mX[T - 1]!);
const marketOut = {
  asOf: cal[T - 1],
  probUp: r4(mNow.p),
  // 有沒有預測能力：方向準確率高於「一直猜漲」，而且機率比基本上漲率準（Brier 分數較低）
  verdict: acc > baseUp && brier < brierBase ? 'signal' : 'none',
  expReturn: r4(mNow.e),
  drivers: MKT.map((f, j) => ({ name: f.name, value: r4(mX[T - 1]![j]), z: r4(zNow[j]), contrib: r4(mFit!.logit[j + 1] * zNow[j]) }))
    .sort((a, b) => Math.abs(b.contrib ?? 0) - Math.abs(a.contrib ?? 0)),
  backtest: {
    from: cal[mOOS[0]?.i ?? 0],
    days: mOOS.length,
    accuracy: r4(acc),
    baseRate: r4(baseUp),
    brier: r4(brier),
    brierBase: r4(brierBase),
    curve: mCurve,
    // 最近一年每天的預測機率與實際結果
    history: mPred.slice(-260).map((x) => [cal[x.i], r4(x.p), x.i + H < T ? r4(mY[x.i]) : null]),
  },
};
console.log(`大盤：上漲機率 ${marketOut.probUp}、方向準確率 ${marketOut.backtest.accuracy}（一直猜漲 ${marketOut.backtest.baseRate}）（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

// ================================================================ 3. 00631L 當沖（開盤買／賣、收盤平倉）
const DT_CODE = '00631L';
const dt = loadStock(DT_CODE);
let dayTradeOut: unknown = null;
if (dt) {
  const DT = [
    { id: 'gap', name: '開盤跳空' },
    { id: 'prevIntra', name: '昨天開盤到收盤' },
    { id: 'r1', name: '昨天漲跌' },
    { id: 'r5', name: '近 5 日漲跌' },
    { id: 'r20', name: '近 20 日漲跌' },
    { id: 'range', name: '昨天振幅' },
    { id: 'vol20', name: '近 20 日波動度' },
    { id: 'inst', name: '昨天法人買賣超（全市場）' },
    { id: 'fut', name: '昨天外資期貨增減' },
    { id: 'mRatio', name: '融資維持率變化' },
    { id: 'usSox', name: '前一晚費城半導體' },
    { id: 'usTsm', name: '前一晚台積電 ADR' },
    { id: 'usSpx', name: '前一晚 S&P 500' },
    { id: 'night', name: '臺指期夜盤' },
  ] as const;
  // 前一晚美股：上一個台股交易日（含）到第 i 天（不含）之間收盤的美股；i＝最後＋1 時是下一個交易日（晚上存檔時還沒收盤 → NaN）
  const usD = loadUs(dir);
  const txD = loadTx(dir);
  const usAt = (i: number) => [...(['SOX', 'TSM', 'GSPC'] as const).map((k) => usMove(usD[k], cal[i - 1], cal[i] ?? '9999-12-31')), nightMove(txD, cal[i - 1], cal[i] ?? null)];
  // 美股（第 11～13 個）、夜盤（第 14 個）可以整組拿掉：每次訓練用最後 20% 的資料決定要不要用
  const DT_GROUPS: Record<string, number[]> = { us: [10, 11, 12], night: [13] };
  const fitDT = (rows: number[][], ys: number[]) => {
    const st = standardizer(rows);
    const Z = rows.map(st.apply);
    const names = Object.keys(DT_GROUPS);
    const cut = Math.floor(Z.length * 0.8);
    let best = { use: names, err: Infinity };
    for (let b = 0; b < 1 << names.length; b++) {
      const use = names.filter((_, i) => b & (1 << i));
      const drop = new Set(names.filter((n) => !use.includes(n)).flatMap((n) => DT_GROUPS[n]));
      const zz = Z.map((z) => z.map((v, j) => (drop.has(j) ? 0 : v)));
      const beta = ridge(zz.slice(0, cut), ys.slice(0, cut), 0.05);
      let err = 0;
      for (let i = cut; i < zz.length; i++) err += (ys[i] - dot(beta, zz[i])) ** 2;
      if (err < best.err) best = { use, err };
    }
    const drop = new Set(names.filter((n) => !best.use.includes(n)).flatMap((n) => DT_GROUPS[n]));
    return { st, b: ridge(Z.map((z) => z.map((v, j) => (drop.has(j) ? 0 : v))), ys, 0.05), use: best.use };
  };
  // 第 i 天開盤時看得到的資料（只有開盤價是當天的）
  const feat = (i: number): number[] | null => {
    const o = dt.open;
    const c = dt.close;
    if (i < 22 || !dt.has[i - 1] || !(c[i - 1] > 0)) return null;
    return [
      Number.isFinite(o[i]) ? o[i] / c[i - 1] - 1 : NaN,
      o[i - 1] > 0 ? c[i - 1] / o[i - 1] - 1 : NaN,
      ret(c, i - 1, 1),
      ret(c, i - 1, 5),
      ret(c, i - 1, 20),
      (dt.high[i - 1] - dt.low[i - 1]) / c[i - 1],
      retStd(c, i - 1, 20),
      instTotal[i - 1] / 100,
      Number.isFinite(futNet[i - 1]) && Number.isFinite(futNet[i - 2]) ? (futNet[i - 1] - futNet[i - 2]) / 1e4 : NaN,
      Number.isFinite(mRatio[i - 1]) && Number.isFinite(mRatio[i - 2]) ? mRatio[i - 1] - mRatio[i - 2] : NaN,
      ...usAt(i),
    ];
  };
  const y = (i: number) => (dt.has[i] && dt.open[i] > 0 ? dt.close[i] / dt.open[i] - 1 : NaN);
  // 當沖成本：手續費 6 折來回＋ETF 證交稅 0.1%
  const DCOST = 0.001425 * 2 * 0.6 + 0.001;
  const start = Math.max(dt.first + 260, 300);
  let fit: { st: ReturnType<typeof standardizer>; b: number[] } | null = null;
  let fLast = -Infinity;
  const trades: Array<[string, number, number, number, number, number]> = []; // [日期, 跳空, 預測, 實際, 動作 1/-1/0, 淨損益]
  let eq = 1;
  let eqLong = 1;
  const eqCurve: Array<[string, number, number]> = [];
  for (let i = start; i < T; i++) {
    if (!fit || i - fLast >= REFIT) {
      const rows: number[][] = [];
      const ys: number[] = [];
      for (let j = dt.first + 22; j < i; j++) {
        const x = feat(j);
        const v = y(j);
        if (x && Number.isFinite(v) && Number.isFinite(x[0])) rows.push(x), ys.push(v);
      }
      fit = fitDT(rows, ys);
      fLast = i;
    }
    const x = feat(i);
    const v = y(i);
    if (!x || !Number.isFinite(v) || !Number.isFinite(x[0])) continue;
    const z = fit.st.apply(x);
    const p = dot(fit.b, z);
    bfPut(cal[i - 1], { dayTrade: { code: DT_CODE, lastClose: dt.close[i - 1], cost: DCOST, rule: { a: fit.b[0] + z.slice(1).reduce((s, v, j) => s + fit!.b[j + 2] * v, 0), b: fit.b[1], gapMean: fit.st.mean[0], gapSd: fit.st.sd[0] } } });
    const act = p > DCOST ? 1 : p < -DCOST ? -1 : 0;
    const pnl = act ? act * v - DCOST : 0;
    eq *= 1 + pnl;
    eqLong *= 1 + v - DCOST;
    trades.push([cal[i], r4(x[0])!, r4(p)!, r4(v)!, act, r4(pnl)!]);
    if (trades.length % 5 === 1) eqCurve.push([cal[i], r4(eq)!, r4(eqLong)!]);
  }
  eqCurve.push([cal[T - 1], r4(eq)!, r4(eqLong)!]);
  const taken = trades.filter((t) => t[4] !== 0);
  const wins = taken.filter((t) => t[5] > 0).length;
  // 下一個交易日：除了開盤跳空，其他因子今天收盤就知道 → 預測 = a + b × 標準化(跳空)
  const xNext = (() => {
    const o = dt.open;
    const c = dt.close;
    const i = T; // 下一天
    const f = [NaN, o[i - 1] > 0 ? c[i - 1] / o[i - 1] - 1 : NaN, ret(c, i - 1, 1), ret(c, i - 1, 5), ret(c, i - 1, 20), (dt.high[i - 1] - dt.low[i - 1]) / c[i - 1], retStd(c, i - 1, 20), instTotal[i - 1] / 100,
      Number.isFinite(futNet[i - 1]) && Number.isFinite(futNet[i - 2]) ? (futNet[i - 1] - futNet[i - 2]) / 1e4 : NaN,
      Number.isFinite(mRatio[i - 1]) && Number.isFinite(mRatio[i - 2]) ? mRatio[i - 1] - mRatio[i - 2] : NaN, ...usAt(i)];
    return f;
  })();
  // 用最新資料重新訓練一次（給下一天用）
  {
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let j = dt.first + 22; j < T; j++) {
      const x = feat(j);
      const v = y(j);
      if (x && Number.isFinite(v) && Number.isFinite(x[0])) rows.push(x), ys.push(v);
    }
    fit = fitDT(rows, ys);
  }
  const zNext = fit.st.apply(xNext);
  const a = fit.b[0] + zNext.slice(1).reduce((s, v, j) => s + fit!.b[j + 2] * v, 0);
  dayTradeOut = {
    code: DT_CODE,
    name: names[DT_CODE] ?? '元大台灣50正2',
    lastDate: cal[T - 1],
    lastClose: r4(dt.close[T - 1]),
    cost: r4(DCOST),
    // 有沒有預測能力：扣成本後累計賺錢、而且交易筆數夠多
    verdict: eq > 1 && taken.length >= 30 ? 'signal' : 'none',
    // 預測（開盤到收盤的報酬）＝ a ＋ b ×（跳空－平均）÷ 標準差（截斷在 ±4）
    rule: { a: r4(a), b: r4(fit.b[1]), gapMean: r4(fit.st.mean[0]), gapSd: r4(fit.st.sd[0]) },
    drivers: DT.map((d, j) => ({ name: d.name, value: j === 0 ? null : r4(xNext[j]), contrib: j === 0 ? null : r4(fit!.b[j + 1] * zNext[j]), w: r4(fit!.b[j + 1]) })),
    backtest: {
      from: trades[0]?.[0] ?? null,
      days: trades.length,
      trades: taken.length,
      winRate: r4(wins / (taken.length || 1)),
      avgNet: r4(mean(taken.map((t) => t[5]))),
      total: r4(eq - 1),
      maxDD: r4(maxDrawdown(eqCurve.map((c) => c[1]))),
      alwaysLong: r4(eqLong - 1),
      longs: taken.filter((t) => t[4] === 1).length,
      shorts: taken.filter((t) => t[4] === -1).length,
      curve: eqCurve,
      recent: trades.slice(-30).reverse(),
    },
  };
  const b = (dayTradeOut as { backtest: { trades: number; winRate: number; total: number; alwaysLong: number } }).backtest;
  console.log(`00631L 當沖（自己選用：${(fit as { use?: string[] }).use?.join('、') || '基本資料'}）：${b.trades} 筆、勝率 ${b.winRate}、累計 ${b.total}（一直做多 ${b.alwaysLong}）`);
}

// ================================================================ 事前存檔與實盤成績
// 收盤後把「今天收盤算出來的預測」存進 forecasts 分支（只新增不覆蓋），之後只用存檔的數字打分數
type DayTradeRule = { lastClose: number; cost: number; rule: { a: number; b: number; gapMean: number; gapSd: number } };
const asOf = cal[T - 1];
if (process.env.ARCHIVE_DIR) {
  const dtr = dayTradeOut as (DayTradeRule & { code: string }) | null;
  const data = {
    market: { probUp: marketOut.probUp, expReturn: marketOut.expReturn },
    stocks: { all: stockOut.all, top: stockOut.top.map((x) => x.code), bottom: stockOut.bottom.map((x) => x.code) },
    dayTrade: dtr ? { code: dtr.code, lastClose: dtr.lastClose, cost: dtr.cost, rule: dtr.rule } : null,
  };
  if (canArchive(asOf)) console.log(writeArchive(process.env.ARCHIVE_DIR, 'daily' + (process.env.ARCHIVE_KIND_SUFFIX ?? ''), asOf, data) ? `事前存檔：${asOf} 收盤後的預測` : `事前存檔：${asOf} 已經存過`);
  else console.log(`事前存檔：現在不是 ${asOf} 收盤後到下一個交易日開盤前，不存`);
}
type DailyArch = { market: { probUp: number; expReturn: number }; stocks: { all: Record<string, number>; top: string[]; bottom: string[] }; dayTrade: DayTradeRule | null };
const fw = {
  stocks: [] as Array<{ asOf: string; ic: number; top: number; bottom: number; all: number; market: number }>,
  market: [] as Array<{ asOf: string; probUp: number; actual: number }>,
  dayTrade: [] as Array<{ asOf: string; date: string; gap: number; pred: number; action: number; actual: number; pnl: number }>,
};
for (const a of readPreOpen<DailyArch>(process.env.FORECASTS_DIR, 'daily')) {
  const i = calIdx.get(a.asOf);
  if (i == null) continue;
  // 個股與大盤：20 個交易日後才知道結果
  if (i + H < T) {
    const codes = Object.keys(a.stocks.all).filter((c) => sIdx.has(c));
    const r = (c: string) => ret(stocks[sIdx.get(c)!].close, i + H, H);
    const rets = codes.map(r);
    const ok = codes.map((c, n) => [a.stocks.all[c], rets[n]] as [number, number]).filter(([, v]) => Number.isFinite(v));
    const allMean = mean(ok.map((x) => x[1]));
    const avgOf = (cs: string[]) => mean(cs.map(r).filter(Number.isFinite));
    fw.stocks.push({ asOf: a.asOf, ic: r4(spearman(ok.map((x) => x[0]), ok.map((x) => x[1])))!, top: r4(avgOf(a.stocks.top))!, bottom: r4(avgOf(a.stocks.bottom))!, all: r4(allMean)!, market: r4(ixClose[i + H] / ixClose[i] - 1)! });
    fw.market.push({ asOf: a.asOf, probUp: a.market.probUp, actual: r4(ixClose[i + H] / ixClose[i] - 1)! });
  }
  // 00631L 當沖：下一個交易日開盤進場、收盤出場
  if (a.dayTrade && dt && i + 1 < T && dt.has[i + 1]) {
    const o = dt.open[i + 1];
    const c = dt.close[i + 1];
    const { a: ra, b: rb, gapMean, gapSd } = a.dayTrade.rule;
    const gap = o / a.dayTrade.lastClose - 1;
    const pred = ra + rb * Math.max(-4, Math.min(4, (gap - gapMean) / (gapSd || 1)));
    const action = pred > a.dayTrade.cost ? 1 : pred < -a.dayTrade.cost ? -1 : 0;
    const actual = c / o - 1;
    fw.dayTrade.push({ asOf: a.asOf, date: cal[i + 1], gap: r4(gap)!, pred: r4(pred)!, action, actual: r4(actual)!, pnl: r4(action ? action * actual - a.dayTrade.cost : 0)! });
  }
}
const forward = {
  stocks: { n: fw.stocks.length, icMean: r4(mean(fw.stocks.map((x) => x.ic))), topExcess: r4(mean(fw.stocks.map((x) => x.top - x.all))), bottomExcess: r4(mean(fw.stocks.map((x) => x.bottom - x.all))), rows: fw.stocks.slice(-20).reverse() },
  market: { n: fw.market.length, hit: fw.market.filter((x) => (x.probUp > 0.5) === (x.actual > 0)).length, rows: fw.market.slice(-20).reverse() },
  dayTrade: { n: fw.dayTrade.length, trades: fw.dayTrade.filter((x) => x.action).length, total: r4(fw.dayTrade.reduce((s, x) => s + x.pnl, 0)), rows: fw.dayTrade.slice(-20).reverse() },
};
console.log(`實盤成績（事前存檔）：個股 ${forward.stocks.n} 期、大盤 ${forward.market.n} 期、當沖 ${forward.dayTrade.n} 天`);
if (process.env.ARCHIVE_ONLY) process.exit(0);

if (BF_DIR) {
  for (const [asOf, v] of bfDaily) writeArchive(BF_DIR, 'daily', asOf, v);
  console.log(`歷史模擬存檔：${bfDaily.size} 天（${BF_FROM} ～ ${BF_TO}）→ ${BF_DIR}`);
}
writeFileSync(join(dir, 'predict.json'), JSON.stringify({ generatedAt: new Date().toISOString(), horizon: H, market: marketOut, stocks: stockOut, dayTrade: dayTradeOut, forward }));
console.log(`predict.json 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
