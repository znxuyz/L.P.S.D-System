/** 價格與市值：現價、總資產、負債、累計投入、未實現損益、維持率、委託保留的現金。 */
import { SESSION_MINUTES } from '../intraday';
import { MARGIN_LOAN, feeOf, taxOf } from './config';
import { cashNeed } from './orders';
import { type Kind, type Market, type Position, type Side, type SimState } from './types';

/** 現在的價格：今天有成交用盤中路徑，否則用最近收盤。 */
export function priceNow(s: SimState, m: Market, code: string): number | undefined {
  // 盤前還不知道今天的價格
  if (s.pre) return m.prevClose(code, s.date);
  const p = m.path(code, s.date);
  if (p) return p.price[Math.min(SESSION_MINUTES, Math.max(0, Math.floor(s.minute)))];
  return m.prevClose(code, s.date);
}

function posValue(p: Position, price: number): number {
  const mv = p.shares * price;
  switch (p.kind) {
    case 'margin':
      return mv - (p.loan ?? 0) - (p.interest ?? 0);
    case 'short':
      return (p.deposit ?? 0) + p.cost - mv;
    default:
      // 現股、當沖多方算市值；當沖空方的賣出價款已經在現金裡，這裡扣掉要買回的錢
      return p.dir === 'long' ? mv : -mv;
  }
}

/** 總資產＝現金＋部位價值－貸款與質押借款（含未繳利息）。 */
export function equityOf(s: SimState, m: Market): number {
  let v = s.cash;
  for (const p of s.pos) v += posValue(p, priceNow(s, m, p.code) ?? p.cost / Math.max(1, p.shares));
  return v - debtOf(s);
}

/** 信貸餘額＋質押借款與未繳利息。 */
export function debtOf(s: SimState): number {
  let d = 0;
  for (const l of s.loans) d += l.balance;
  for (const p of s.pledges) d += p.loan + p.interest;
  return d;
}

/** 累計投入＝本金＋薪資等投入。 */
export function investedOf(s: SimState): number {
  return s.settings.capital + s.flows.reduce((a, [, v]) => a + v, 0);
}

/** 一個部位現在了結的話，扣掉費用、稅、利息後的損益（未實現損益）；base 是投入的本錢。 */
export function unrealizedOf(p: Position, s: SimState, m: Market): { now: number | undefined; pnl: number; base: number } {
  const now = priceNow(s, m, p.code);
  if (now == null) return { now, pnl: 0, base: p.cost };
  const mv = now * p.shares;
  const fee = feeOf(mv, s.settings.discount, p.shares);
  if (p.dir === 'long') {
    const tax = taxOf(mv, p.code, p.kind === 'day');
    return { now, pnl: mv - fee - tax - p.cost - (p.interest ?? 0), base: p.kind === 'margin' ? p.cost * (1 - MARGIN_LOAN) : p.cost };
  }
  return { now, pnl: p.cost - mv - fee, base: p.kind === 'short' ? p.deposit ?? p.cost : p.cost };
}

/** 整戶擔保維持率（只算融資、融券），沒有信用部位時 null。 */
export function maintenance(s: SimState, m: Market): number | null {
  let assets = 0;
  let debts = 0;
  for (const p of s.pos) {
    const price = priceNow(s, m, p.code) ?? 0;
    if (p.kind === 'margin') {
      assets += p.shares * price;
      debts += p.loan ?? 0;
    } else if (p.kind === 'short') {
      assets += (p.deposit ?? 0) + p.cost;
      debts += p.shares * price;
    }
  }
  return debts > 0 ? assets / debts : null;
}

/** 委託中的買單要先保留的現金。 */
export function reservedCash(s: SimState, m: Market): number {
  let r = 0;
  for (const o of s.orders) r += cashNeed(s, m, o, o.limit ?? priceNow(s, m, o.code) ?? 0);
  return r;
}

/** 已委託、還沒成交的同方向股數（避免重複賣出同一批股票）。 */
export function pendingShares(s: SimState, code: string, kind: Kind, side: Side): number {
  return s.orders.filter((o) => o.code === code && o.kind === kind && o.side === side).reduce((a, o) => a + o.shares, 0);
}

export function pledgedShares(s: SimState, code: string): number {
  return s.pledges.find((p) => p.code === code)?.shares ?? 0;
}

/** 質押維持率＝質押股票市值 ÷（借款＋未繳利息）；沒有質押借款時 null。 */
export function pledgeRatio(s: SimState, m: Market): number | null {
  let value = 0;
  let debt = 0;
  for (const p of s.pledges) {
    value += p.shares * (priceNow(s, m, p.code) ?? 0);
    debt += p.loan + p.interest;
  }
  return debt > 0 ? value / debt : null;
}
