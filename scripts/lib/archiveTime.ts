/** 事前存檔的時間規則（純計算，網頁的單元測試也會用到）。 */

/** 台北時間 [日期, 分鐘數（0～1439）, 星期（0＝日）]。 */
function taipeiNow(ms: number): [string, number, number] {
  const t = new Date(ms + 8 * 3600_000);
  return [t.toISOString().slice(0, 10), t.getUTCHours() * 60 + t.getUTCMinutes(), t.getUTCDay()];
}

/**
 * asOf（最後一個有收盤資料的交易日）收盤後、下一個平日 08:45 前，才可以存這一天的「下一個交易日」預測。
 * morning：開盤前那份（加了前一晚美股、夜盤）只能在下一個交易日的 05:00～08:45 存，避免傍晚提早存了一份沒有美股的、又佔掉名額。
 */
export function canArchive(asOf: string, ms = Date.now(), morning = false): boolean {
  const [date, min] = taipeiNow(ms);
  if (date < asOf) return false;
  if (date === asOf) return !morning && min >= 14 * 60 + 30;
  // 下一個平日（假日更晚，只會更保守）
  const d = new Date(`${asOf}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  const next = d.toISOString().slice(0, 10);
  if (morning) return date === next && min >= 5 * 60 && min < 8 * 60 + 45;
  return date < next || (date === next && min < 8 * 60 + 45);
}

/** 開盤前（早上）那份存檔的種類後綴：舊的 -am 曾在傍晚被提早存過，從 2026-11-20 起改用 -pre。 */
export const MORNING_SUFFIX = '-pre';
