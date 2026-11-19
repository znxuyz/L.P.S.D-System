/**
 * 訊號實驗室：用第一手資料的單一訊號選股，逐段往前滾，看能不能贏大盤。
 *
 *   node scripts/factor-lab.ts <資料資料夾>
 *
 * 想法（第一性原理）：股價長期由「公司能賺多少」與「市場願意付幾倍」決定；短期漲跌是有人知道了新資訊而買賣。
 * 所以要找「最早反映獲利改變」的第一手資料：
 * - 每月營收（次月 10 日前公告）：年增率、成長加速、創新高、比過去幾個月的趨勢好多少
 * - 季報毛利率變化（產品漲價、缺貨最早的證據）
 * - 法人買賣（拿到研究資料的人在買還是賣）
 * 每個月 12 日之後第一個交易日開盤換股（前一個月營收 11 日起才算知道），買訊號最強的 N 檔等權持有一個月。
 * 每一天只用當時已公布的資料；沒有任何參數是用回測結果挑的（N、換股日、門檻都事先定好）。
 *
 * 輸出 factor-lab.json，並在終端機印出逐年報酬。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { COMBO, SIGNAL_NAMES, makeSignals, rebalanceDays, type SignalId } from './lib/revSignals.ts';

const dir = process.argv[2] ?? 'data';
const N = Number(process.env.LAB_N ?? 20);
const COST = 0.001425 * 0.6 * 2 + 0.003;
const read = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
type Row = [string, number, number, number, number, number];
const taiex = read<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []);
const cal = taiex.map((r) => r[0]);
const T = cal.length;
const calIdx = new Map(cal.map((d, i) => [d, i]));
const exDays = new Map<string, Set<string>>();
for (const f of readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)))
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);

// ---------------------------------------------------------------- 個股日 K
interface Stock {
  code: string;
  open: Float64Array;
  close: Float64Array;
  turn: Float64Array;
  vol: Float64Array;
  first: number;
}
const stocks: Stock[] = [];
for (const f of readdirSync(join(dir, 'candles')).filter((f) => /^[1-9]\d{3}\.json$/.test(f))) {
  const code = f.slice(0, 4);
  const raw = read<Row[]>(join(dir, 'candles', f), []);
  if (raw.length < 250) continue;
  const bars = raw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  const adj = adjustForSplits(bars, detectSplits(bars, exDays.get(code)), '9999-12-31');
  const s: Stock = { code, open: new Float64Array(T).fill(NaN), close: new Float64Array(T).fill(NaN), turn: new Float64Array(T), vol: new Float64Array(T), first: T };
  bars.forEach((b, k) => {
    const i = calIdx.get(b.date);
    if (i == null || !(adj[k].close > 0)) return;
    s.open[i] = adj[k].open;
    s.close[i] = adj[k].close;
    s.vol[i] = b.volume;
    s.turn[i] = (b.volume * 1000 * b.close) / 1e8;
    s.first = Math.min(s.first, i);
  });
  for (let i = s.first + 1; i < T; i++) if (!(s.close[i] > 0)) s.close[i] = s.close[i - 1];
  stocks.push(s);
}
const byCode = new Map(stocks.map((s) => [s.code, s]));
console.log(`個股 ${stocks.length} 檔，${cal[0]} ～ ${cal[T - 1]}`);

// ---------------------------------------------------------------- 訊號（與正式預測共用）
const sig = makeSignals(dir, cal);
console.log(`月營收 ${sig.revMonths.length} 個月（${sig.revMonths[0] ?? '—'} ～ ${sig.revMonths.at(-1) ?? '—'}）`);

// ---------------------------------------------------------------- 換股日：每月 12 日後第一個交易日
const rebal = rebalanceDays(cal);
const FROM = process.env.LAB_FROM ?? '2021-01-01';
/** LAB_TREND=1：換股前一天加權指數在 200 日均線之下 → 這個月持有現金（大盤空頭時不選股）。 */
const TREND = process.env.LAB_TREND === '1';
const aboveMa = (i: number) => {
  if (i < 199) return true;
  let sm = 0;
  for (let j = i - 199; j <= i; j++) sm += taiex[j][4];
  return taiex[i][4] > sm / 200;
};
const rb = rebal.filter((i) => cal[i] >= FROM);

const results: Record<string, { name: string; periods: Array<[string, number, number]> }> = {};
const bench: Array<[string, number, number]> = []; // [日期, 加權指數, 全部等權]
const prevPicks: Record<string, Set<string>> = {};
for (let p = 0; p + 1 < rb.length; p++) {
  const i = rb[p];
  const j = rb[p + 1];
  const { uni, vals, combo } = sig.scoreAll(stocks, i, cal[i]);
  const ret = (s: Stock) => {
    if (!(s.open[i] > 0)) return NaN; // 換股日沒開盤（停牌）買不到
    const exit = s.open[j] > 0 ? s.open[j] : s.close[j - 1];
    return exit / s.open[i] - 1;
  };
  const uniRet = (uni as Stock[]).map(ret).filter(Number.isFinite);
  bench.push([cal[i], taiex[j - 1][4] / taiex[i - 1][4] - 1, uniRet.reduce((a, b) => a + b, 0) / uniRet.length]);
  const all: Record<string, number[]> = { ...vals, combo };
  for (const [id, v] of Object.entries(all)) {
    const ok = (uni as Stock[]).map((s, k) => [s, v[k]] as const).filter(([s, x]) => Number.isFinite(x) && s.open[i] > 0);
    if (ok.length < N * 3) continue;
    const picks = ok.sort((a, b) => b[1] - a[1]).slice(0, N).map(([s]) => s);
    const rs = picks.map(ret).filter(Number.isFinite);
    const prev = prevPicks[id] ?? new Set();
    const cashMonth = TREND && !aboveMa(i - 1);
    const turnover = picks.filter((s) => !prev.has(s.code)).length / picks.length;
    const r = cashMonth ? (prev.size ? -COST / 2 : 0) : rs.reduce((a, b) => a + b, 0) / rs.length - turnover * COST;
    prevPicks[id] = cashMonth ? new Set() : new Set(picks.map((s) => s.code));
    const res = (results[id] ??= { name: id === 'combo' ? `綜合（${COMBO.join('＋')} 排名平均）` : SIGNAL_NAMES[id as SignalId], periods: [] });
    res.periods.push([cal[i], r, bench.length - 1]);
  }
}

// ---------------------------------------------------------------- 報告
const years = [...new Set(bench.map((b) => b[0].slice(0, 4)))];
const comp = (xs: number[]) => xs.reduce((t, x) => t * (1 + x), 1) - 1;
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`.padStart(6);
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), N, from: bench[0]?.[0], to: cal[rb.at(-1)!], years, signals: {} };
const line = (name: string, per: Array<[string, number]>) => {
  const ys = years.map((y) => comp(per.filter((x) => x[0].startsWith(y)).map((x) => x[1])));
  console.log(name.padEnd(30 - (name.length - name.replace(/[^\x00-\xff]/g, '').length)), ys.map(pct).join(''), pct(comp(per.map((x) => x[1]))));
  return ys;
};
console.log(`\n每月換股、前 ${N} 檔等權（${bench[0]?.[0]} ～ ${cal[rb.at(-1)!]}，扣交易成本）`);
console.log(''.padEnd(30), years.map((y) => y.padStart(6)).join(''), '  總計');
const bx = line('加權指數', bench.map((b) => [b[0], b[1]]));
const bu = line('全部股票等權', bench.map((b) => [b[0], b[2]]));
(report.signals as Record<string, unknown>).taiex = { name: '加權指數', years: bx, total: comp(bench.map((b) => b[1])) };
(report.signals as Record<string, unknown>).universe = { name: '全部股票等權', years: bu, total: comp(bench.map((b) => b[2])) };
for (const [id, r] of Object.entries(results)) {
  const per = r.periods.map((x) => [x[0], x[1]] as [string, number]);
  const ys = line(r.name, per);
  // 每期贏加權指數的比例
  const win = r.periods.filter((x) => x[1] > bench[x[2]][1]).length / r.periods.length;
  (report.signals as Record<string, unknown>)[id] = { name: r.name, years: ys, total: comp(per.map((x) => x[1])), winVsTaiex: win, periods: r.periods.length };
}
writeFileSync(join(dir, 'factor-lab.json'), JSON.stringify(report));
