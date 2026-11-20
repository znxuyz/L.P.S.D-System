/**
 * 第一手資料的選股訊號（研究 factor-lab.ts、正式預測 predict.ts 共用，保證算法一模一樣）。
 *
 * 股價長期由「公司能賺多少」決定；每月營收是台股最早公布的獲利資料（次月 10 日前），季報毛利率是產品漲價、缺貨的證據，
 * 法人買賣是拿到研究資料的人的動作。訊號一律用「交易日 date 開盤前已經公布」的資料：
 * - 月營收：M 月的營收從次月 11 日起才算知道（見 revenueKnownFrom）
 * - 季報：法定申報期限之後才算知道（loadFinQuarters 的 availDate）
 * - 法人、股價：交易日前一天收盤為止
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFinQuarters } from './finQuarters.ts';
import { addMonths, latestKnownMonth } from './revDates.ts';
export { addMonths, isRebalanceDate, latestKnownMonth, rebalanceDays } from './revDates.ts';

export interface SigStock {
  code: string;
  close: ArrayLike<number>; // 往前補值
  vol: ArrayLike<number>; // 張
  turn: ArrayLike<number>; // 億元
  first: number;
}
export type SignalId = 'revYoy1' | 'revYoy3' | 'revAccel' | 'revHigh' | 'gmChg' | 'inst20' | 'trust20' | 'foreign20' | 'mom';
export const SIGNAL_NAMES: Record<SignalId, string> = {
  revYoy1: '最新月營收年增率',
  revYoy3: '近 3 個月營收年增率',
  revAccel: '營收成長加速（近 3 月年增 − 近 12 月年增）',
  revHigh: '營收創新高程度（近 3 月 ÷ 過去 3 年最高的 3 個月）',
  gmChg: '毛利率改善（最新一季 − 去年同季）',
  inst20: '法人近 20 日買超 ÷ 成交量',
  trust20: '投信近 20 日買超 ÷ 成交量',
  foreign20: '外資近 20 日買超 ÷ 成交量',
  mom: '（對照）近 6 個月股價動能（不含最近 1 個月）',
};
/** 綜合分數：這幾個訊號在當期全部股票裡的排名平均（至少要有 3 個）。成分是看結果之前就定好的。 */
export const COMBO: SignalId[] = ['revAccel', 'revHigh', 'gmChg', 'inst20'];
/** 流動性門檻：近 20 日平均成交額（億）。 */
export const MIN_TURN = 0.5;

const growth = (a: number, b: number) => (b > 0 && Number.isFinite(a) ? Math.max(-1, Math.min(5, a / b - 1)) : NaN);

export function makeSignals(dir: string, cal: string[]) {
  const T = cal.length;
  const calIdx = new Map(cal.map((d, i) => [d, i]));
  const read = <T>(p: string, fb: T): T => {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fb;
    }
  };
  // 月營收
  const rev = new Map<string, Map<string, number>>();
  const months = existsSync(join(dir, 'revenue')) ? readdirSync(join(dir, 'revenue')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)).sort() : [];
  for (const ym of months)
    for (const [code, [v]] of Object.entries(read<Record<string, [number, number | null]>>(join(dir, 'revenue', `${ym}.json`), {}))) (rev.get(code) ?? rev.set(code, new Map()).get(code)!).set(ym, v);
  const sumRev = (m: Map<string, number>, end: string, n: number) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      const v = m.get(addMonths(end, -k));
      if (v == null) return NaN;
      s += v;
    }
    return s;
  };
  // 季報、法人
  const { byCode: finBy } = loadFinQuarters(join(dir, 'fin'));
  const inst = new Map<string, Float64Array>();
  for (const f of existsSync(join(dir, 'inst')) ? readdirSync(join(dir, 'inst')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []) {
    const i = calIdx.get(f.slice(0, 10));
    if (i == null) continue;
    for (const [code, v] of Object.entries(read<Record<string, number>>(join(dir, 'inst', f), {}))) (inst.get(code) ?? inst.set(code, new Float64Array(T)).get(code)!)[i] = v / 1000;
  }

  // 法人分開（inst2/：[外資, 投信] 股數；2026-11 起往回補，沒有的日子是 NaN）
  const split = new Map<string, [Float64Array, Float64Array]>();
  const splitHas = new Uint8Array(T);
  for (const f of existsSync(join(dir, 'inst2')) ? readdirSync(join(dir, 'inst2')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []) {
    const i = calIdx.get(f.slice(0, 10));
    if (i == null) continue;
    splitHas[i] = 1;
    for (const [code, [fo, tr]] of Object.entries(read<Record<string, [number, number]>>(join(dir, 'inst2', f), {}))) {
      let a = split.get(code);
      if (!a) split.set(code, (a = [new Float64Array(T), new Float64Array(T)]));
      a[0][i] = fo / 1000;
      a[1][i] = tr / 1000;
    }
  }
  const splitFlow = (s: SigStock, i: number, which: 0 | 1) => {
    for (let j = i - 20; j < i; j++) if (!splitHas[j]) return NaN; // 20 天都要有資料
    const a = split.get(s.code);
    if (!a) return 0;
    let b = 0;
    let v = 0;
    for (let j = i - 20; j < i; j++) (b += a[which][j]), (v += s.vol[j] ?? 0);
    return v > 0 ? b / v : NaN;
  };

  /** i：交易日的位置（可以等於 cal.length＝下一個交易日）；date：交易日日期。只用 i 之前的價量。 */
  const f: Record<SignalId, (s: SigStock, i: number, date: string) => number> = {
    revYoy1: (s, _i, date) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(date);
      return m && ym ? growth(m.get(ym) ?? NaN, m.get(addMonths(ym, -12)) ?? NaN) : NaN;
    },
    revYoy3: (s, _i, date) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(date);
      return m && ym ? growth(sumRev(m, ym, 3), sumRev(m, addMonths(ym, -12), 3)) : NaN;
    },
    revAccel: (s, _i, date) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(date);
      if (!m || !ym) return NaN;
      return growth(sumRev(m, ym, 3), sumRev(m, addMonths(ym, -12), 3)) - growth(sumRev(m, ym, 12), sumRev(m, addMonths(ym, -12), 12));
    },
    revHigh: (s, _i, date) => {
      const m = rev.get(s.code);
      const ym = latestKnownMonth(date);
      if (!m || !ym) return NaN;
      const now = sumRev(m, ym, 3);
      let mx = 0;
      for (let k = 3; k <= 36; k++) {
        const v = sumRev(m, addMonths(ym, -k), 3);
        if (Number.isFinite(v)) mx = Math.max(mx, v);
      }
      return mx > 0 ? now / mx : NaN;
    },
    gmChg: (s, _i, date) => {
      const qs = finBy.get(s.code);
      if (!qs) return NaN;
      let q: (typeof qs)[number] | undefined;
      for (const x of qs) if (x[1] < date && (!q || x[1] >= q[1])) q = x;
      if (!q || !(q[2]! > 0) || q[3] == null) return NaN;
      const ly = qs.find((x) => x[0] === `${Number(q![0].slice(0, 4)) - 1}${q![0].slice(4)}`);
      if (!ly || !(ly[2]! > 0) || ly[3] == null) return NaN;
      return q[3]! / q[2]! - ly[3]! / ly[2]!;
    },
    inst20: (s, i) => {
      const a = inst.get(s.code);
      if (!a) return NaN;
      let b = 0;
      let v = 0;
      for (let j = i - 20; j < i; j++) (b += a[j] ?? 0), (v += s.vol[j] ?? 0);
      return v > 0 ? b / v : NaN;
    },
    trust20: (s, i) => splitFlow(s, i, 1),
    foreign20: (s, i) => splitFlow(s, i, 0),
    mom: (s, i) => (s.close[i - 21] > 0 && s.close[i - 126] > 0 ? s.close[i - 21] / s.close[i - 126] - 1 : NaN),
  };

  /**
   * 「營收大增」的根本原因檢查（看結果前定好的三個條件）：
   * - oneOff：近 3 個月裡單一個月就佔 60% 以上（一次性出貨、認列）
   * - lowBase：近 3 個月營收沒有超過「兩年前」同期（只是從低基期回來）
   * - loss：最新一季本業虧損（營業利益 ≤ 0）
   */
  const flags = (s: SigStock, date: string): { oneOff: boolean; lowBase: boolean; loss: boolean } => {
    const m = rev.get(s.code);
    const ym = latestKnownMonth(date);
    let oneOff = false;
    let lowBase = false;
    if (m && ym) {
      const xs = [0, 1, 2].map((k) => m.get(addMonths(ym, -k)) ?? NaN);
      const sum = xs.reduce((a, b) => a + b, 0);
      if (sum > 0) oneOff = Math.max(...xs) / sum > 0.6;
      const two = sumRev(m, addMonths(ym, -24), 3);
      lowBase = Number.isFinite(two) && two > 0 && sum <= two;
    }
    let loss = false;
    const qs = finBy.get(s.code);
    if (qs) {
      let q: (typeof qs)[number] | undefined;
      for (const x of qs) if (x[1] < date && (!q || x[1] >= q[1])) q = x;
      loss = q?.[4] != null && q[4] <= 0;
    }
    return { oneOff, lowBase, loss };
  };

  /** 可以選的股票：上市櫃滿一年、前一天有收盤價、近 20 日平均成交額 ≥ MIN_TURN 億。 */
  const eligible = (s: SigStock, i: number) => {
    if (i - s.first < 250 || !(s.close[i - 1] > 0)) return false;
    let t = 0;
    for (let j = i - 20; j < i; j++) t += s.turn[j] ?? 0;
    return t / 20 >= MIN_TURN;
  };

  /** 一個交易日的全部訊號與綜合分數（排名平均，0～1）。 */
  function scoreAll(stocks: SigStock[], i: number, date: string) {
    const uni = stocks.filter((s) => eligible(s, i));
    const vals = Object.fromEntries((Object.keys(f) as SignalId[]).map((id) => [id, uni.map((s) => f[id](s, i, date))])) as Record<SignalId, number[]>;
    const rank = (xs: number[]) => {
      const idx = xs.map((v, k) => [v, k] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
      const out = new Array<number>(xs.length).fill(NaN);
      idx.forEach(([, k], r) => (out[k] = idx.length > 1 ? r / (idx.length - 1) : 0.5));
      return out;
    };
    const ranks = Object.fromEntries(COMBO.map((id) => [id, rank(vals[id])])) as Record<SignalId, number[]>;
    const combo = uni.map((_, k) => {
      const r = COMBO.map((id) => ranks[id][k]).filter(Number.isFinite);
      return r.length >= 3 ? r.reduce((a, b) => a + b, 0) / r.length : NaN;
    });
    return { uni, vals, ranks, combo };
  }
  return { f, flags, eligible, scoreAll, revMonths: months, rev };
}
