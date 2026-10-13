/** 成績：本局摘要與「同額買大盤」對照組。 */
import { type Market, type SimState, type SimSummary } from './types';
import { equityOf, investedOf } from './valuation';

export function summarize(s: SimState, m: Market): SimSummary {
  const equity = equityOf(s, m);
  // 回檔用扣掉薪資投入的報酬指數算（不然每次入帳都像是漲了一段）
  const flowOn = new Map<string, number>();
  for (const [d, v] of s.flows) flowOn.set(d, (flowOn.get(d) ?? 0) + v);
  let idx = 1;
  let prev = s.settings.capital;
  let peak = 1;
  let mdd = 0;
  for (const [d, v] of s.equity) {
    const base = prev + (flowOn.get(d) ?? 0);
    if (base > 0) idx *= v / base;
    prev = v;
    peak = Math.max(peak, idx);
    mdd = Math.max(mdd, 1 - idx / peak);
  }
  const closes = s.trades.filter((t) => t.pnl != null);
  return {
    equity,
    ret: equity / investedOf(s) - 1,
    maxDrawdown: mdd,
    realized: closes.reduce((a, t) => a + (t.pnl ?? 0), 0),
    wins: closes.filter((t) => (t.pnl ?? 0) > 0).length,
    losses: closes.filter((t) => (t.pnl ?? 0) <= 0).length,
    fees: s.trades.reduce((a, t) => a + t.fee + t.tax, 0),
    days: s.equity.length,
  };
}

/**
 * 對照組：同樣的錢（本金＋每次投入）都在投入當天以前一天收盤買進加權指數，到 date 收盤值多少。
 * index(d) = 那天的加權指數收盤、prevDay(d) = 前一個交易日；資料不夠時 null。
 */
export function benchValue(
  s: SimState,
  index: (d: string) => number | undefined,
  prevDay: (d: string) => string | undefined,
  date: string,
): number | null {
  const buy = (d: string) => {
    const p = prevDay(d);
    return p ? index(p) : undefined;
  };
  const t0 = buy(s.settings.start);
  const t1 = index(date);
  if (!t0 || !t1) return null;
  let units = s.settings.capital / t0;
  for (const [d, v] of s.flows) {
    if (d > date) continue;
    const t = buy(d);
    if (!t) return null;
    units += v / t;
  }
  return units * t1;
}
