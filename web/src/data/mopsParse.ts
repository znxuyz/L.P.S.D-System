/**
 * 公開資訊觀測站資料的解析（GitHub Actions 的 scripts/financials.ts 使用，放在這裡方便測試）。
 */

export type Table = Record<string, Record<string, string>>;

const clean = (s: string) => s.replace(/\s+/g, '');

/** 把公開資訊觀測站的 HTML 表格轉成 { 公司代號: { 欄位: 值 } }（同一頁可能有好幾個產業別的表格）。 */
export function parseMopsTables(html: string): Table {
  const out: Table = {};
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  for (const table of html.split(/<table/i).slice(1)) {
    let header: string[] | null = null;
    for (const row of table.split(/<tr/i).slice(1)) {
      const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => strip(m[1]));
      if (!cells.length) continue;
      if (cells.some((c) => clean(c) === '公司代號')) {
        header = cells.map(clean);
        continue;
      }
      if (!header || cells.length !== header.length) continue;
      const code = cells[header.indexOf('公司代號')].trim();
      if (!/^\d{4}$/.test(code)) continue;
      out[code] = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    }
  }
  return out;
}

/** 依主旨關鍵字分類重大訊息（對應網頁的三種特殊事件）。 */
export function classifyEvent(subject: string): string | null {
  const s = clean(subject);
  // 「合併財務報告」「合併營收」之類是例行公告，不是併購
  const routine = /財務報告|財報|報表|營收|營業收入|自結|損益|股東會|法說會簡報|更正|背書保證|資金貸與/.test(s);
  if (/(上修|調升|調高).*(財測|財務預測|展望|營運目標)|(財測|財務預測|展望).*(上修|調升|調高)/.test(s)) return 'guidance-up';
  if (!routine && /合併|併購|收購|公開收購|股份轉換|分割|取得.*(股權|股份)|處分.*(土地|廠房|不動產|使用權資產)|資產活化|都更|都市更新/.test(s)) return 'merger';
  if (/補助|補貼|獎勵|政府.*計畫|科專/.test(s)) return 'subsidy';
  return null;
}


/** 把公開資訊觀測站的 HTML 表格逐列轉成物件（同一家公司可能有好幾列，例如重大訊息）。 */
export function parseMopsRows(html: string, key = '公司代號'): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  for (const table of html.split(/<table/i).slice(1)) {
    let header: string[] | null = null;
    for (const row of table.split(/<tr/i).slice(1)) {
      const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => strip(m[1]));
      if (!cells.length) continue;
      if (cells.some((c) => clean(c) === key)) {
        header = cells.map(clean);
        continue;
      }
      if (header && cells.length === header.length) out.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
    }
  }
  return out;
}

/** 民國日期（115/09/14 或 1150914）轉成 2026-09-14。 */
export function rocToIso(roc: string): string | null {
  const m = roc.trim().match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}
