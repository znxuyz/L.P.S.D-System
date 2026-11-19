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
import { loadFinQuarters } from './lib/finQuarters.ts';
import { revenueKnownFrom } from './lib/revenueParse.ts';

const dir = process.argv[2] ?? 'data';
const N = Number(process.env.LAB_N ?? 20);
const MIN_TURN = 0.5; // 近 20 日平均成交額（億）
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

// ---------------------------------------------------------------- 月營收
const rev = new Map<string, Map<string, number>>(); // 代號 → 月份 → 營收
const revMonths: string[] = existsSync(join(dir, 'revenue')) ? readdirSync(join(dir, 'revenue')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)).sort() : [];
for (const ym of revMonths)
  for (const [code, [v]] of Object.entries(read<Record<string, [number, number | null]>>(join(dir, 'revenue', `${ym}.json`), {}))) (rev.get(code) ?? rev.set(code, new Map()).get(code)!).set(ym, v);
console.log(`月營收 ${revMonths.length} 個月（${revMonths[0] ?? '—'} ～ ${revMonths.at(-1) ?? '—'}）`);
const addM = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
/** 交易日 date 當天已經公布的最新營收月份。 */
const latestKnownMonth = (date: string) => {
  let ym = date.slice(0, 7);
  for (let k = 0; k < 3; k++) {
    ym = addM(ym, -1);
    if (revenueKnownFrom(ym) <= date) return ym;
  }
  return null;
};
const sumRev = (m: Map<string, number>, end: string, n: number) => {
  let s = 0;
  for (let k = 0; k < n; k++) {
    const v = m.get(addM(end, -k));
    if (v == null) return NaN;
    s += v;
  }
  return s;
};
const growth = (a: number, b: number) => (b > 0 && Number.isFinite(a) ? Math.max(-1, Math.min(5, a / b - 1)) : NaN);

// ---------------------------------------------------------------- 季報毛利率、法人
const { byCode: finBy } = loadFinQuarters(join(dir, 'fin'));
const inst = new Map<string, Float64Array>();
for (const f of existsSync(join(dir, 'inst')) ? readdirSync(join(dir, 'inst')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []) {
  const i = calIdx.get(f.slice(0, 10));
  if (i == null) continue;
  for (const [code, v] of Object.entries(read<Record<string, number>>(join(dir, 'inst', f), {}))) {
    if (!byCode.has(code)) continue;
    (inst.get(code) ?? inst.set(code, new Float64Array(T)).get(code)!)[i] = v / 1000; // 股 → 張
  }
}

// ---------------------------------------------------------------- 訊號
type Sig = (s: Stock, i: number) => number;
const SIGNALS: Record<string, { name: string; f: Sig; needRev?: boolean }> = {
  revYoy1: { name: '最新月營收年增率', needRev: true, f: (s, i) => { const m = rev.get(s.code); const ym = latestKnownMonth(cal[i]); return m && ym ? growth(m.get(ym) ?? NaN, m.get(addM(ym, -12)) ?? NaN) : NaN; } },
  revYoy3: { name: '近 3 個月營收年增率', needRev: true, f: (s, i) => { const m = rev.get(s.code); const ym = latestKnownMonth(cal[i]); return m && ym ? growth(sumRev(m, ym, 3), sumRev(m, addM(ym, -12), 3)) : NaN; } },
  revAccel: {
    name: '營收成長加速（近 3 月年增 − 近 12 月年增）',
    needRev: true,
    f: (s, i) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(cal[i]);
      if (!m || !ym) return NaN;
      return growth(sumRev(m, ym, 3), sumRev(m, addM(ym, -12), 3)) - growth(sumRev(m, ym, 12), sumRev(m, addM(ym, -12), 12));
    },
  },
  revHigh: {
    name: '近 3 月營收 ÷ 過去 3 年最高的 3 個月',
    needRev: true,
    f: (s, i) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(cal[i]);
      if (!m || !ym) return NaN;
      const now = sumRev(m, ym, 3);
      let mx = 0;
      for (let k = 3; k <= 36; k++) {
        const v = sumRev(m, addM(ym, -k), 3);
        if (Number.isFinite(v)) mx = Math.max(mx, v);
      }
      return mx > 0 ? now / mx : NaN;
    },
  },
  gmChg: {
    name: '最新一季毛利率 − 去年同季',
    f: (s, i) => {
      const qs = finBy.get(s.code);
      if (!qs) return NaN;
      let q: (typeof qs)[number] | undefined;
      for (const x of qs) if (x[1] < cal[i] && (!q || x[1] >= q[1])) q = x;
      if (!q || !(q[2]! > 0) || q[3] == null) return NaN;
      const ly = qs.find((x) => x[0] === `${Number(q![0].slice(0, 4)) - 1}${q![0].slice(4)}`);
      if (!ly || !(ly[2]! > 0) || ly[3] == null) return NaN;
      return q[3]! / q[2]! - ly[3]! / ly[2]!;
    },
  },
  inst20: {
    name: '法人近 20 日買超 ÷ 成交量',
    f: (s, i) => {
      const a = inst.get(s.code);
      if (!a) return NaN;
      let b = 0;
      let v = 0;
      for (let j = i - 20; j < i; j++) (b += a[j]), (v += s.vol[j]);
      return v > 0 ? b / v : NaN;
    },
  },
  mom: { name: '（對照）近 6 個月股價動能（不含最近 1 個月）', f: (s, i) => (s.close[i - 21] > 0 && s.close[i - 126] > 0 ? s.close[i - 21] / s.close[i - 126] - 1 : NaN) },
};

// 綜合：各訊號在當期的排名平均（缺的不算）
const COMBO = ['revAccel', 'revHigh', 'gmChg', 'inst20'];

// ---------------------------------------------------------------- 換股日：每月 12 日後第一個交易日
const rebal: number[] = [];
for (let i = 1; i < T; i++) if (cal[i].slice(8) >= '12' && (rebal.length === 0 || cal[rebal.at(-1)!].slice(0, 7) !== cal[i].slice(0, 7))) rebal.push(i);
const FROM = process.env.LAB_FROM ?? '2021-01-01';
const rb = rebal.filter((i) => cal[i] >= FROM);

const rankPct = (vals: Array<[Stock, number]>) => {
  const ok = vals.filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  return new Map(ok.map(([s], r) => [s.code, ok.length > 1 ? r / (ok.length - 1) : 0.5]));
};
const results: Record<string, { name: string; periods: Array<[string, number, number]>; names: number }> = {};
const bench: Array<[string, number, number]> = []; // [日期, 加權指數, 全部等權]
let prevPicks: Record<string, Set<string>> = {};
for (let p = 0; p + 1 < rb.length; p++) {
  const i = rb[p];
  const j = rb[p + 1];
  const uni = stocks.filter((s) => i - s.first >= 250 && s.open[i] > 0 && s.close[i - 1] > 0 && s.turn.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20 >= MIN_TURN);
  const ret = (s: Stock) => {
    const exit = s.open[j] > 0 ? s.open[j] : s.close[j - 1];
    return exit / s.open[i] - 1;
  };
  const uniRet = uni.map(ret).filter(Number.isFinite);
  bench.push([cal[i], taiex[j - 1][4] / taiex[i - 1][4] - 1, uniRet.reduce((a, b) => a + b, 0) / uniRet.length]);
  const vals: Record<string, Array<[Stock, number]>> = {};
  for (const [id, sg] of Object.entries(SIGNALS)) vals[id] = uni.map((s) => [s, sg.f(s, i)]);
  const ranks = Object.fromEntries(COMBO.map((id) => [id, rankPct(vals[id])]));
  vals.combo = uni.map((s) => {
    const r = COMBO.map((id) => ranks[id].get(s.code)).filter((x): x is number => x != null);
    return [s, r.length >= 3 ? r.reduce((a, b) => a + b, 0) / r.length : NaN];
  });
  for (const [id, v] of Object.entries(vals)) {
    const ok = v.filter(([, x]) => Number.isFinite(x));
    if (ok.length < N * 3) continue;
    const picks = ok.sort((a, b) => b[1] - a[1]).slice(0, N).map(([s]) => s);
    const rs = picks.map(ret).filter(Number.isFinite);
    const prev = prevPicks[id] ?? new Set();
    const turnover = picks.filter((s) => !prev.has(s.code)).length / picks.length;
    prevPicks[id] = new Set(picks.map((s) => s.code));
    const r = rs.reduce((a, b) => a + b, 0) / rs.length - turnover * COST;
    const res = (results[id] ??= { name: id === 'combo' ? `綜合（${COMBO.join('＋')} 排名平均）` : SIGNALS[id].name, periods: [], names: 0 });
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
