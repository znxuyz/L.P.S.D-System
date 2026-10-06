/**
 * 全市場股票目錄（上市＋上櫃），由 GitHub Actions 每天從證交所、櫃買中心開放資料產生（data/stocks.json）。
 *
 * 個股分析頁用它來查詢熱力圖股票池以外的股票：名稱、市場別、產業、最近收盤，
 * 以及證交所 / 櫃買公布的本益比、殖利率、股價淨值比。
 */

export interface DirEntry {
  code: string;
  name: string;
  market: 'tse' | 'otc';
  /** 產業名稱（例如「半導體業」）。 */
  industry?: string;
  close?: number;
  change?: number;
  /** 成交量（張）。 */
  volume?: number;
  /** 成交金額（億元）。 */
  turnover?: number;
  pe?: number;
  yieldPct?: number;
  pb?: number;
}

export interface StockDirectory {
  /** 資料日期（YYYY-MM-DD）。 */
  asOf: string;
  stocks: DirEntry[];
}

let pending: Promise<StockDirectory | null> | null = null;

/** 只下載一次；讀不到時回傳 null（例如本機開發還沒有資料）。 */
export function loadStockDirectory(url = 'data/stocks.json'): Promise<StockDirectory | null> {
  pending ??= fetch(url, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<StockDirectory>) : null))
    .then((j) => (j && Array.isArray(j.stocks) ? j : null))
    .catch(() => null);
  return pending;
}

/** 證交所 / 櫃買的產業名稱對應到熱力圖的產業分組（對不上就回傳 undefined）。 */
const INDUSTRY_MAP: Array<[RegExp, string]> = [
  [/半導體/, 'semi'],
  [/電子零組件/, 'comp'],
  [/電腦及週邊|電腦週邊/, 'pc'],
  [/通信網路/, 'net'],
  [/光電/, 'opto'],
  [/其他電子|電子通路|資訊服務/, 'oe'],
  [/金融|保險|證券/, 'fin'],
  [/航運/, 'ship'],
  [/塑膠|化學|油電燃氣/, 'plastic'],
  [/鋼鐵/, 'steel'],
  [/生技|醫療/, 'bio'],
  [/電機|電器電纜|綠能|數位雲端|運動休閒/, 'mech'],
];

export function industryIdOf(industry: string | undefined): string | undefined {
  if (!industry) return undefined;
  return INDUSTRY_MAP.find(([re]) => re.test(industry))?.[1] ?? 'trad';
}

/** 搜尋：代號完全相同優先，其次名稱相同、名稱包含。 */
export function searchDirectory(dir: DirEntry[], q: string): DirEntry | undefined {
  const s = q.trim();
  const token = s.split(/\s+/)[0];
  return (
    dir.find((d) => d.code === token) ??
    dir.find((d) => d.name === s || d.name === token) ??
    dir.find((d) => d.name.includes(s) || s.includes(d.name))
  );
}
