import type { IndexPoint } from './types';

/**
 * 台指期（臺股期貨，代號 TXF）。
 *
 * 近月合約在每月第三個星期三結算，結算後近月換成下個月。
 * 富果的期貨代號格式：TXF + 月份字母（A=1 月 … L=12 月）+ 年份個位數，例如 2026 年 10 月是 TXFJ6。
 */

export interface FuturesQuote {
  symbol: string;
  name: string;
  price: number;
  /** 前一日結算價。 */
  prevClose: number;
  high: number;
  low: number;
  /** 今日累計成交量（口）。 */
  volume: number;
  series: IndexPoint[];
}

/** 某年某月的第三個星期三（日）。 */
export function thirdWednesday(year: number, month: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstWed = 1 + ((3 - first + 7) % 7);
  return firstWed + 14;
}

/** 依台北日期（YYYY-MM-DD）算出近月合約代號與月份。 */
export function nearMonthContract(date: string): { symbol: string; year: number; month: number } {
  let [y, m, d] = date.split('-').map(Number);
  // 結算日當天 13:30 後近月就換約，這裡以「結算日之後」換月，結算日當天仍顯示當月
  if (d > thirdWednesday(y, m)) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const code = 'ABCDEFGHIJKL'[m - 1];
  return { symbol: `TXF${code}${y % 10}`, year: y, month: m };
}
