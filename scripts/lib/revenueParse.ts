/**
 * 公開資訊觀測站「每月營業收入彙總表」（t21sc03）的解析（純計算，單元測試也會用到）。
 * 一列：公司代號、公司名稱、當月營收、上月營收、去年當月營收、上月比較增減(%)、去年同月增減(%)、當月累計、去年累計、前期比較增減(%)、備註。
 * 回傳 { 代號: [當月營收, 去年當月營收] }（千元）。
 */
export type RevenueMonth = Record<string, [number, number | null]>;

const num = (s: string): number | null => {
  const t = s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/,/g, '').trim();
  if (!t || t === '-' || t === '--') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

export function parseRevenueHtml(html: string): RevenueMonth {
  const out: RevenueMonth = {};
  for (const row of html.split(/<tr/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 10) continue;
    const code = cells[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    const cur = num(cells[2]);
    if (cur == null) continue;
    out[code] = [cur, num(cells[4])];
  }
  return out;
}

/** 用 meta 或 HTTP 標頭的 charset 解碼（觀測站舊檔多半是 Big5）。 */
export function decodeHtml(buf: ArrayBuffer, contentType = ''): string {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const cs = (contentType.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs === 'ms950' || cs === 'cp950' ? 'big5' : cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** 月營收最晚在次月 10 日前公告：保守起見，M 月的營收從次月 11 日起才算「知道」。 */
export function revenueKnownFrom(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-11`;
}
