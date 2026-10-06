/**
 * 全市場股票目錄（GitHub Actions 每天執行）。
 *
 *   node scripts/stock-list.ts <資料資料夾>
 *
 * 從證交所、櫃買中心的開放資料整理出所有上市、上櫃股票與 ETF 的
 * 名稱、產業、最近收盤、成交量值，以及本益比、殖利率、股價淨值比，
 * 寫成 stocks.json 給網頁的個股分析頁查詢。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';

/** 證交所與櫃買共用的產業別代碼。 */
const INDUSTRY: Record<string, string> = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '14': '建材營造',
  '15': '航運業', '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '19': '綜合', '20': '其他',
  '21': '化學工業', '22': '生技醫療業', '23': '油電燃氣業', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業',
  '27': '通信網路業', '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業',
  '33': '農業科技業', '34': '電子商務', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活',
};

interface Entry {
  code: string;
  name: string;
  market: 'tse' | 'otc';
  industry?: string;
  close?: number;
  change?: number;
  volume?: number;
  turnover?: number;
  pe?: number;
  yieldPct?: number;
  pb?: number;
}

async function getJson(url: string): Promise<any[]> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error(`${url} → 不是陣列`);
  return j;
}

const num = (v: unknown): number | undefined => {
  const n = Number(String(v ?? '').replace(/[,+\s]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : undefined;
};
const pos = (v: unknown) => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};
/** 民國日期 1151005 → 2026-10-05 */
const rocDate = (s: string) => (/^\d{7}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}-${s.slice(3, 5)}-${s.slice(5)}` : '');
/** 股票（4 碼）與 ETF（00 開頭）；排除權證、債券等。 */
const wanted = (code: string) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'data';
  const [twDay, twInfo, twPe, otDay, otInfo, otPe] = await Promise.all([
    getJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    getJson('https://openapi.twse.com.tw/v1/opendata/t187ap03_L').catch(() => []),
    getJson('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL').catch(() => []),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'),
    getJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O').catch(() => []),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis').catch(() => []),
  ]);

  const industry = new Map<string, string>();
  for (const r of twInfo) industry.set(String(r['公司代號']).trim(), INDUSTRY[String(r['產業別']).trim()] ?? '');
  for (const r of otInfo) industry.set(String(r.SecuritiesCompanyCode).trim(), INDUSTRY[String(r.SecuritiesIndustryCode).trim()] ?? '');

  const ratios = new Map<string, { pe?: number; yieldPct?: number; pb?: number }>();
  for (const r of twPe) ratios.set(String(r.Code).trim(), { pe: pos(r.PEratio), yieldPct: num(r.DividendYield), pb: pos(r.PBratio) });
  for (const r of otPe) ratios.set(String(r.SecuritiesCompanyCode).trim(), { pe: pos(r.PriceEarningRatio), yieldPct: num(r.YieldRatio), pb: pos(r.PriceBookRatio) });

  const stocks: Entry[] = [];
  let asOf = '';
  const add = (e: Entry) => {
    const ind = industry.get(e.code);
    stocks.push({ ...e, ...(ind ? { industry: ind } : {}), ...(ratios.get(e.code) ?? {}) });
  };
  for (const r of twDay) {
    const code = String(r.Code).trim();
    if (!wanted(code)) continue;
    asOf ||= rocDate(String(r.Date));
    add({
      code,
      name: String(r.Name).trim(),
      market: 'tse',
      close: pos(r.ClosingPrice),
      change: num(r.Change),
      volume: Math.round((num(r.TradeVolume) ?? 0) / 1000),
      turnover: Math.round(((num(r.TradeValue) ?? 0) / 1e8) * 100) / 100,
    });
  }
  for (const r of otDay) {
    const code = String(r.SecuritiesCompanyCode).trim();
    if (!wanted(code)) continue;
    asOf ||= rocDate(String(r.Date));
    add({
      code,
      name: String(r.CompanyName).trim(),
      market: 'otc',
      close: pos(r.Close),
      change: num(r.Change),
      volume: Math.round((num(r.TradingShares) ?? 0) / 1000),
      turnover: Math.round(((num(r.TransactionAmount) ?? 0) / 1e8) * 100) / 100,
    });
  }
  // 拿掉 undefined 欄位，檔案小一點
  const clean = stocks.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '')));
  if (clean.length < 1000) throw new Error(`股票數量太少（${clean.length}），不覆蓋舊資料`);
  writeFileSync(join(dir, 'stocks.json'), JSON.stringify({ asOf, stocks: clean }));
  console.log(`完成：${asOf} 上市 ${stocks.filter((s) => s.market === 'tse').length} 檔、上櫃 ${stocks.filter((s) => s.market === 'otc').length} 檔`);
}

await main();
