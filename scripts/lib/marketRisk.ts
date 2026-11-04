/** 大盤風險指標的資料解析（scripts/market-risk.ts 用；拆出來方便測試）。 */
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** 存檔格式版本：舊版沒有 ETF 的融資，算不出維持率，要重抓。 */
export const MARGIN_VERSION = 2;

export interface MarginDay {
  v?: number;
  /** 融資餘額金額（仟元）。 */
  finAmt: number;
  /** 融資、融券今日餘額（張）。 */
  finLots: number;
  shortLots: number;
  /** 每檔融資今日餘額（張）。 */
  perStock: Record<string, number>;
}

/**
 * 解析 MI_MARGN（selectType=ALL）。新版是 { tables: [{ title, fields, data }] }，舊版是 creditFields/creditList＋fields/data。
 * 個股表的欄位名稱會重複（融資、融券各一組「今日餘額」），第一個「今日餘額」是融資、第二個是融券。
 */
export function parseMargin(j: any): MarginDay | null {
  if (!j || (j.stat && j.stat !== 'OK')) return null;
  const tables: Array<{ fields: string[]; data: unknown[][] }> = Array.isArray(j.tables)
    ? j.tables.filter((t: any) => Array.isArray(t?.fields) && Array.isArray(t?.data))
    : [
        ...(Array.isArray(j.creditFields) ? [{ fields: j.creditFields, data: j.creditList ?? [] }] : []),
        ...(Array.isArray(j.fields) ? [{ fields: j.fields, data: j.data ?? [] }] : []),
      ];
  const summary = tables.find((t) => t.data.some((r) => String(r[0]).includes('融資金額')));
  const stocks = tables.find((t) => String(t.fields[0]).includes('代號') && t.data.length > 100);
  if (!summary || !stocks) return null;
  const todayCol = summary.fields.findIndex((f) => String(f).includes('今日餘額'));
  const row = (key: string) => summary.data.find((r) => String(r[0]).includes(key));
  const finAmt = num(row('融資金額')?.[todayCol]);
  const finLots = num(row('融資(交易單位)')?.[todayCol] ?? row('融資')?.[todayCol]);
  const shortLots = num(row('融券(交易單位)')?.[todayCol] ?? row('融券')?.[todayCol]);
  const bal = stocks.fields.map((f, i) => (String(f).includes('今日餘額') ? i : -1)).filter((i) => i >= 0);
  if (!(finAmt > 0) || bal.length < 1) throw new Error(`MI_MARGN 欄位不符：${summary.fields.join(',')} ｜ ${stocks.fields.join(',')}`);
  const perStock: Record<string, number> = {};
  for (const r of stocks.data) {
    const code = String(r[0]).trim();
    const v = num(r[bal[0]]);
    // 個股與 ETF 都算（ETF 的融資也不少，少了它維持率會算不出來）
    if (/^\d{4,6}[A-Z]?$/.test(code) && v > 0) perStock[code] = v;
  }
  return { v: MARGIN_VERSION, finAmt, finLots, shortLots, perStock };
}

/** 解析期交所「三大法人－期貨契約」CSV：外資的「多空未平倉口數淨額」，大台＋小台÷4。日期 → 口數。 */
export function parseFutures(csv: string): Record<string, number> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return {};
  const head = lines[0].split(',').map((s) => s.trim());
  const iDate = head.indexOf('日期');
  const iName = head.indexOf('商品名稱');
  const iWho = head.indexOf('身份別');
  const iNet = head.findIndex((h) => h.startsWith('多空未平倉口數淨額'));
  if (iDate < 0 || iName < 0 || iWho < 0 || iNet < 0) throw new Error(`期交所欄位不符：${head.join(',')}`);
  const out: Record<string, number> = {};
  for (const l of lines.slice(1)) {
    const c = l.split(',').map((s) => s.trim());
    if (!c[iWho]?.includes('外資')) continue;
    const name = c[iName] ?? '';
    const k = name === '臺股期貨' ? 1 : name === '小型臺指期貨' ? 0.25 : 0;
    if (!k) continue;
    const d = c[iDate].replace(/\//g, '-');
    out[d] = Math.round(((out[d] ?? 0) + num(c[iNet]) * k) * 10) / 10;
  }
  return out;
}

