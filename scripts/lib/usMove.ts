/** 美股漲跌對齊台股日期（純計算，網頁的單元測試也會用到）。見 us.ts 的說明。 */
type Row = [string, number, number, number, number];

/** rows 裡日期 < date 的最後一筆位置（二分搜尋）；沒有時 -1。 */
function lastBefore(rows: Row[], date: string): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] < date) (ans = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return ans;
}

/** 台股 D 開盤前、上一個台股交易日 prev 之後的美股累計漲跌（對數）。 */
export function usMove(rows: Row[], prev: string, D: string): number {
  const a = lastBefore(rows, prev);
  const b = lastBefore(rows, D);
  if (a < 0 || b < 0 || b <= a) return NaN;
  return Math.log(rows[b][4] / rows[a][4]);
}
