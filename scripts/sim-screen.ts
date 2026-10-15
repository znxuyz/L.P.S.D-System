/**
 * 模擬盤的「五大選股」：每個交易日收盤後，用「當時看得到的資料」對全市場跑一次首頁的五大選股條件。
 * 模擬時顯示前一個交易日收盤後的結果，不會偷看當天或之後。
 *
 *   node scripts/sim-screen.ts <資料資料夾>
 *
 * 輸出 simscreen/<YYYY-MM>.json：{ days: { 日期: { 策略 id: [[代號, [欄位值…]], …] } } }，每個策略最多 20 檔（依策略排序）。
 *
 * 用到的資料（都只用到那一天為止）：
 * - 日 K（分割、減資已還原）：3 年位階、一年高點、均線、20 日高點、成交量。
 * - 每日本益比、殖利率（ratios/）：本益比、殖利率、本益比在自己近 5 年的分位。
 * - 季報（fin/，過了申報期限才算）：近四季 EPS 年增、毛利率與營益率變化、營業現金流。
 *   季報還不到 8 季時（2021 年），EPS 年增改用每日本益比反推的近四季 EPS 跟一年前比。
 * - 配息年度（div/）：連續配息年數。資料從 2016 年起，早期算不到 10 年：資料起點以來每年都配息（至少 5 年）就算通過。
 * - 外資＋投信買賣超（inst/）：連買天數。千張大戶（tdcc/）只有最近一年，沒有資料時這個條件略過。
 * - 重大訊息（events/）：近 45 天的特殊事件。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent } from '../web/src/data/mopsParse.ts';
import type { Fundamentals, StockEvent } from '../web/src/data/types.ts';
import type { StockMetrics } from '../web/src/domain/metrics.ts';
import { STRATEGIES, type StockView } from '../web/src/domain/screens.ts';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { loadFinQuarters, type Quarter } from './lib/finQuarters.ts';

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

// ---------- 除權息日（分割判斷要排除）
const exDays = new Map<string, Set<string>>();
for (const f of existsSync(join(dir, 'exrights')) ? readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);

// ---------- 每檔的日 K 與滾動指標（一次算好）
interface Series {
  dates: string[];
  idx: Map<string, number>;
  close: number[];
  high: number[];
  low: number[];
  /** 當天成交額估計（億元）。 */
  turn: number[];
  ma5: number[];
  ma20: number[];
  ma60: number[];
  /** 不含當天的近 20 日最高。 */
  high20: number[];
  high250: number[];
  low750: number[];
  high750: number[];
  avgTurn20: number[];
}

/** 滾動視窗最大值（含當天，長度 n）：單調佇列 O(長度)。 */
function rollMax(a: number[], n: number, sign = 1): number[] {
  const out: number[] = new Array(a.length);
  const q: number[] = [];
  for (let i = 0; i < a.length; i++) {
    while (q.length && sign * a[q[q.length - 1]] <= sign * a[i]) q.pop();
    q.push(i);
    if (q[0] <= i - n) q.shift();
    out[i] = a[q[0]];
  }
  return out;
}
function rollMean(a: number[], n: number): number[] {
  const out: number[] = new Array(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i >= n) sum -= a[i - n];
    out[i] = sum / Math.min(i + 1, n);
  }
  return out;
}

const series = new Map<string, Series>();
for (const f of readdirSync(join(dir, 'candles')).filter((f) => /^\d{4}\.json$/.test(f))) {
  const code = f.slice(0, 4);
  const raw = read<Row[]>(join(dir, 'candles', f), []);
  if (raw.length < 60) continue;
  const bars = raw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  const adj = adjustForSplits(bars, detectSplits(bars, exDays.get(code)), '9999-12-31');
  const close = adj.map((b) => b.close);
  const high = adj.map((b) => b.high);
  const low = adj.map((b) => b.low);
  // 成交額用原始價格與張數估算（分割不影響金額）
  const turn = bars.map((b) => (b.volume * 1000 * ((b.open + b.high + b.low + b.close) / 4)) / 1e8);
  const h20 = rollMax(high, 20);
  const avgTurn = rollMean(turn, 20);
  series.set(code, {
    dates: bars.map((b) => b.date),
    idx: new Map(bars.map((b, i) => [b.date, i])),
    close,
    high,
    low,
    turn,
    ma5: rollMean(close, 5),
    ma20: rollMean(close, 20),
    ma60: rollMean(close, 60),
    high20: h20.map((_, i) => (i ? h20[i - 1] : high[0])),
    high250: rollMax(high, 250),
    low750: rollMax(low, 750, -1),
    high750: rollMax(high, 750),
    avgTurn20: avgTurn.map((_, i) => (i ? avgTurn[i - 1] : turn[0])),
  });
}

// ---------- 季報、配息
const { byCode: finBy } = loadFinQuarters(join(dir, 'fin'));
const divYears = new Map<number, Set<string>>();
let divFrom = Infinity;
for (const f of existsSync(join(dir, 'div')) ? readdirSync(join(dir, 'div')).filter((f) => /^\d{4}\.json$/.test(f)) : [])
  divYears.set(Number(f.slice(0, 4)), new Set(read<string[]>(join(dir, 'div', f), []))), (divFrom = Math.min(divFrom, Number(f.slice(0, 4))));

/** 已公布的季報（公布日在 d 以前）。 */
function seenQuarters(code: string, d: string): Quarter[] {
  return (finBy.get(code) ?? []).filter((q) => q[1] < d);
}
const sum4 = (qs: Quarter[], k: number) => (qs.length >= 4 && qs.slice(-4).every((q) => q[k] != null) ? qs.slice(-4).reduce((a, q) => a + (q[k] as number), 0) : null);

// ---------- 依日期往前走
const calendar = series.get('2330')?.dates ?? [...new Set([...series.values()].flatMap((s) => s.dates))].sort();
const ratioDays = new Set(listDates('ratios'));
const instDays = new Set(listDates('inst'));
const eventDays = listDates('events');
const tdccDays = listDates('tdcc');

const streak = new Map<string, number>();
const peHist = new Map<string, number[]>();
/** 由每日本益比反推的近四季 EPS：[日期, EPS]（季報不夠 8 季時，用一年前的值算年增）。 */
const eps4Hist = new Map<string, Array<[string, number]>>();
/** 每檔「一年前」在 eps4Hist 裡的位置（日期往前走，指標只會往後移）。 */
const eps4Ago = new Map<string, number>();
const recentEvents: Array<{ d: string; code: string; e: StockEvent }> = [];
let evI = 0;
const out = new Map<string, Record<string, Record<string, Array<[string, string[]]>>>>();
let tdccCur: Record<string, number> | null = null;
let tdccOld: Record<string, number> | null = null;

const shiftDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

for (const d of calendar) {
  if (d < '2020-04-01') continue;
  // 法人連買天數（到今天收盤）
  if (instDays.has(d)) {
    const day = read<Record<string, number>>(join(dir, 'inst', `${d}.json`), {});
    for (const code of series.keys()) {
      const v = day[code] ?? 0;
      const s0 = streak.get(code) ?? 0;
      streak.set(code, v > 0 ? (s0 > 0 ? s0 + 1 : 1) : v < 0 ? (s0 < 0 ? s0 - 1 : -1) : 0);
    }
  }
  // 重大訊息（近 45 天）
  while (evI < eventDays.length && eventDays[evI] <= d) {
    for (const [code, , subject] of read<Array<[string, string, string]>>(join(dir, 'events', `${eventDays[evI]}.json`), [])) {
      const e = classifyEvent(subject) as StockEvent | null;
      if (e) recentEvents.push({ d: eventDays[evI], code, e });
    }
    evI++;
  }
  const from = shiftDays(d, -45);
  while (recentEvents.length && recentEvents[0].d < from) recentEvents.shift();
  const events = new Map<string, Set<StockEvent>>();
  for (const r of recentEvents) (events.get(r.code) ?? events.set(r.code, new Set()).get(r.code)!).add(r.e);
  // 千張大戶：最新一週與 4 週前
  const weeks = tdccDays.filter((w) => w <= d);
  if (weeks.length >= 2) {
    const cur = weeks[weeks.length - 1];
    const old = weeks.filter((w) => w <= shiftDays(cur, -28)).at(-1) ?? weeks[0];
    tdccCur = read(join(dir, 'tdcc', `${cur}.json`), null);
    tdccOld = old === cur ? null : read(join(dir, 'tdcc', `${old}.json`), null);
  } else tdccCur = tdccOld = null;

  if (!ratioDays.has(d)) continue;
  const ratios = read<Record<string, [number, number, number]>>(join(dir, 'ratios', `${d}.json`), {});
  // 全市場成交額（今天、近 20 日平均），算成交佔比與常態佔比
  let total = 0;
  let baseTotal = 0;
  for (const s of series.values()) {
    const i = s.idx.get(d);
    if (i == null) continue;
    total += s.turn[i];
    baseTotal += s.avgTurn20[i];
  }
  const y = Number(d.slice(0, 4));
  const result: Record<string, Array<{ code: string; rank: number; cols: string[] }>> = {};
  for (const st of STRATEGIES) result[st.id] = [];

  for (const [code, s] of series) {
    const i = s.idx.get(d);
    if (i == null || i < 60) continue;
    const price = s.close[i];
    const r = ratios[code];
    const pe = r && r[0] > 0 ? r[0] : -1;
    const yieldPct = r ? r[1] : 0;
    if (pe > 0) {
      const eh = eps4Hist.get(code) ?? [];
      eh.push([d, price / pe]);
      eps4Hist.set(code, eh);
      const h = peHist.get(code) ?? [];
      h.push(pe);
      if (h.length > 1250) h.shift();
      peHist.set(code, h);
    }
    const qs = seenQuarters(code, d);
    const eps4 = sum4(qs, 6);
    let epsPrev4 = qs.length >= 8 ? sum4(qs.slice(0, -4), 6) : null;
    let epsNow4 = eps4;
    if (epsPrev4 == null && pe > 0) {
      // 季報還不到 8 季：改用本益比反推的近四季 EPS，跟一年前比
      const eh = eps4Hist.get(code) ?? [];
      const yearAgo = shiftDays(d, -365);
      let k = eps4Ago.get(code) ?? 0;
      while (k < eh.length && eh[k][0] < yearAgo) k++;
      eps4Ago.set(code, k);
      const ago = eh[k];
      if (ago && ago[0] <= shiftDays(d, -330)) {
        epsPrev4 = ago[1];
        epsNow4 = price / pe;
      }
    }
    const last = qs[qs.length - 1];
    const lastYear = last ? qs.find((q) => q[0] === `${Number(last[0].slice(0, 4)) - 1}${last[0].slice(4)}`) : undefined;
    const margin = (q: Quarter | undefined, k: number) => (q && q[2] && q[k] != null ? ((q[k] as number) / q[2]) * 100 : null);
    const gmNow = margin(last, 3);
    const gmOld = margin(lastYear, 3);
    const omNow = margin(last, 4);
    const omOld = margin(lastYear, 4);
    const ocf4 = sum4(qs, 7);
    let divRun = 0;
    for (let yy = y - 1; divYears.get(yy)?.has(code); yy--) divRun++;
    const dividend = (price * yieldPct) / 100;
    const eps4q = pe > 0 ? price / pe : eps4 ?? 0;
    const lo = s.low750[i];
    const hi = s.high750[i];
    const big = tdccCur && tdccOld && tdccCur[code] != null && tdccOld[code] != null ? tdccCur[code] - tdccOld[code] : null;
    const f = {
      eps4q,
      epsYoY: epsNow4 != null && epsPrev4 != null && epsPrev4 > 0 ? ((epsNow4 - epsPrev4) / epsPrev4) * 100 : epsNow4 != null && epsPrev4 != null && epsNow4 > 0 && epsPrev4 <= 0 ? 100 : 0,
      dividend,
      payoutRatio: eps4q > 0 ? Math.min(120, (dividend / eps4q) * 100) : 0,
      dividendYears: divRun,
      fcfPositive: ocf4 != null && ocf4 > 0,
      grossMarginChg: gmNow != null && gmOld != null ? gmNow - gmOld : 0,
      opMarginChg: omNow != null && omOld != null ? omNow - omOld : 0,
      low3y: lo,
      high3y: hi,
      high52w: s.high250[i],
      high20: s.high20[i],
      ma5: s.ma5[i],
      ma20: s.ma20[i],
      ma60: s.ma60[i],
      instBuyDays: streak.get(code) ?? 0,
      bigHolderChg: big ?? 0,
      events: [...(events.get(code) ?? [])],
    } as unknown as Fundamentals;
    const share = total > 0 ? s.turn[i] / total : 0;
    const baseShare = baseTotal > 0 ? s.avgTurn20[i] / baseTotal : 0;
    const pos3y = hi > lo ? (price - lo) / (hi - lo) : 0.5;
    // 本益比分位只有在 3 年低檔時才需要（低基期策略的第一個條件），省時間
    let pePct: number | null = null;
    const hist = peHist.get(code);
    if (pos3y <= 0.3 && pe > 0 && hist && hist.length >= 250) pePct = hist.filter((v) => v < pe).length / hist.length;
    const view: StockView = {
      stock: { code, price, share, baseShare } as unknown as StockMetrics,
      f,
      pe,
      yieldPct,
      pos3y,
      toHigh52w: s.high250[i] > 0 ? price / s.high250[i] : 0,
      pePct,
      industryPe: null,
    };
    for (const st of STRATEGIES) {
      const checks = st.criteria.map((c) => c.test(view));
      // 千張大戶沒有資料的日子：這個條件略過，不算沒通過
      // 配息資料從 divFrom 年才有：資料起點以來每年都配息（至少 5 年）就算「連續 10 年以上」
      if (st.id === 'income' && !checks[2].pass && divRun >= 5 && divRun >= y - divFrom) checks[2] = { pass: true, value: checks[2].value };
      const usable = checks.filter((_, k) => !(st.id === 'technical' && k === 1 && big == null));
      const pass = st.match === 'all' ? usable.every((c) => c.pass) : usable.some((c) => c.pass);
      if (pass) result[st.id].push({ code, rank: st.rank(view), cols: st.columns.map((c) => c.value(view)) });
    }
  }
  const month = d.slice(0, 7);
  let m = out.get(month);
  if (!m) out.set(month, (m = {}));
  m[d] = Object.fromEntries(Object.entries(result).map(([id, list]) => [id, list.sort((a, b) => b.rank - a.rank).slice(0, 20).map((x) => [x.code, x.cols])]));
}

const outDir = join(dir, 'simscreen');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let bytes = 0;
for (const [month, days] of out) {
  const text = JSON.stringify({ days });
  writeFileSync(join(outDir, `${month}.json`), text);
  bytes += text.length;
}
console.log(`simscreen：${out.size} 個月、${[...out.values()].reduce((a, m) => a + Object.keys(m).length, 0)} 天，共 ${(bytes / 1e6).toFixed(1)} MB`);
