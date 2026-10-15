/** 首頁的自選股（只存在這台裝置的瀏覽器；模擬盤的自選股另外存在模擬帳戶裡）。 */
const KEY = 'lplc.fav';

export function loadFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
  } catch {
    return [];
  }
}

/** 加入或移除；回傳新的清單。 */
export function toggleFav(list: string[], code: string): string[] {
  const next = list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不了就只在這次有效 */
  }
  return next;
}
