/** 台股升降單位（股票）。 */
export function tickSize(price: number): number {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

export function roundToTick(price: number): number {
  const tick = tickSize(price);
  return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

/** 盤中交易時間：09:00–13:30，共 270 分鐘。 */
export const SESSION_MINUTES = 270;

/** 當天台北 09:00 的 epoch ms。 */
export function sessionOpenMs(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // 台北時間 09:00 = UTC 01:00
  return Date.UTC(get('year'), get('month') - 1, get('day'), 1, 0, 0);
}
