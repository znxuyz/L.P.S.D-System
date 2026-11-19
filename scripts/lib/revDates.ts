/** 月營收、換股日的日期規則（純計算，網頁的單元測試也會用到；不能 import node 模組）。 */

/** 月營收最晚在次月 10 日前公告：保守起見，M 月的營收從次月 11 日起才算「知道」。 */
export function revenueKnownFrom(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-11`;
}
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
/** 交易日 date 開盤前已經公布的最新營收月份。 */
export function latestKnownMonth(date: string): string | null {
  let ym = date.slice(0, 7);
  for (let k = 0; k < 3; k++) {
    ym = addMonths(ym, -1);
    if (revenueKnownFrom(ym) <= date) return ym;
  }
  return null;
}
/** 換股日：每個月 12 日（含）以後第一個交易日（前一個月的營收 10 日前公告完）。 */
export function rebalanceDays(cal: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < cal.length; i++) if (cal[i].slice(8) >= '12' && (out.length === 0 || cal[out.at(-1)!].slice(0, 7) !== cal[i].slice(0, 7))) out.push(i);
  return out;
}
/** date（交易日）是不是換股日：12 日以後，而且前一個交易日 prevDate 是上個月或這個月 12 日以前。 */
export function isRebalanceDate(date: string, prevDate: string): boolean {
  return date.slice(8) >= '12' && (prevDate.slice(0, 7) !== date.slice(0, 7) || prevDate.slice(8) < '12');
}
