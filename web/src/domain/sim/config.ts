/** 模擬盤的規則參數與費用計算（手續費、證交稅、融資融券、信貸、質押的比例與利率）。 */
import { type Candle } from '../technicals';
import { type Kind } from './types';

export const LOT = 1000;

export const FEE_RATE = 0.001425;

export const MARGIN_LOAN = 0.6;

export const MARGIN_RATE = 0.065;

export const SHORT_DEPOSIT = 0.9;

export const SHORT_FEE = 0.0008;

export const MAINT_CALL = 1.3;

export const MAINT_FORCE = 1.2;

export const SALARY = 20_000;

export const LOAN_LIMIT = 1_000_000;

export const LOAN_RATE = 0.035;

export const LOAN_TERMS = [12, 24, 36, 60, 84] as const;

export const LOAN_PENALTY = 0.01;

export const PLEDGE_LTV = 0.6;

export const PLEDGE_RATE = 0.025;

export const PLEDGE_CALL = 1.3;

export const PLEDGE_FORCE = 1.2;

export const KIND_NAME: Record<Kind, string> = { cash: '現股', day: '當沖', margin: '融資', short: '融券' };

export const isEtf = (code: string) => code.startsWith('00');

export function feeOf(amount: number, discount: number, shares: number): number {
  const min = shares % LOT === 0 ? 20 : 1;
  return Math.max(min, Math.floor(amount * FEE_RATE * discount));
}

export function taxOf(amount: number, code: string, dayTrade = false): number {
  return Math.floor(amount * (isEtf(code) ? 0.001 : dayTrade ? 0.0015 : 0.003));
}

/** 一價到底（開高低收都一樣）且漲跌超過 9%：1 = 漲停鎖死、-1 = 跌停鎖死、0 = 不是。 */
export function lockedLimit(bar: Candle, prevClose: number | undefined): -1 | 0 | 1 {
  if (!prevClose || bar.open !== bar.high || bar.high !== bar.low || bar.low !== bar.close) return 0;
  const r = bar.close / prevClose - 1;
  return r >= 0.09 ? 1 : r <= -0.09 ? -1 : 0;
}
