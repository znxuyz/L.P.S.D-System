/**
 * ETF 的真實資料（GitHub Actions 每天收盤後執行）。
 *
 *   node scripts/etf-info.ts <資料資料夾>
 *
 * 來源：
 * - 證交所 MIS「ETF 預估淨值」all_etf.txt：全部上市櫃 ETF 的受益權單位數、預估淨值、前一日淨值、折溢價（每天）。
 * - 證交所 ETF e添富（etfInfo/<代號> 頁面）：發行公司、標的指數、資產規模、受益人次、最近幾次收益分配。
 *   只有上市 ETF 有頁面；每次最多抓 40 檔、間隔 1.5 秒，一週內輪完一次（先抓網站上有用到的 ETF）。
 * - 證交所 OpenAPI t187ap47_L 基金基本資料：標的指數、上市日期、基金類型。
 * - 資料夾裡已經有的：exrights/<年>.json（除權息，算配息、頻率、連續配息年數、填息率）、candles/<代號>.json（填息）、
 *   tdcc-etf.json（集保受益人數，scripts/chips.ts 產生）。
 *
 * 輸出 etf-info.json：{ asOf, etfs: { 代號: {...} } }。某個來源失敗時保留上次的資料。
 * 內扣費用率、被動式 ETF 的完整成分股沒有公開的整理資料，不在這裡。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
/** 網站上有用到的 ETF（web/src/data/mockEtfs.ts），e添富頁面先抓這些。 */
const PRIORITY = ['0050', '006208', '0056', '00878', '00919', '00929', '00940', '00713', '00881', '00891', '00892', '00679B', '00937B', '00687B', '00980A', '00981A', '00982A', '00984A'];
const FORTUNE_PER_RUN = 40;
const FORTUNE_MAX_AGE = 7 * 24 * 3600_000;

const dir = process.argv[2] ?? 'data';
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}
/** 民國或西元日期（1150330、20261008、2026/08/10）轉成 YYYY-MM-DD。 */
function isoOf(s: string): string | undefined {
  const t = s.trim();
  let m = t.match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  return undefined;
}

interface Fortune {
  at: number;
  issuer?: string;
  underlying?: string;
  aum?: number;
  holders?: number;
  /** 最近幾次收益分配 [發放日, 每單位金額]。 */
  divs?: Array<[string, number]>;
}

export interface EtfInfo {
  name?: string;
  /** 預估淨值與日期。 */
  nav?: number;
  navDate?: string;
  /** 前一個營業日的淨值。 */
  navPrev?: number;
  /** 受益權單位數。 */
  units?: number;
  /** 規模（億元）。 */
  aum?: number;
  /** 受益人數（萬人）。 */
  holders?: number;
  holdersDate?: string;
  issuer?: string;
  underlying?: string;
  listed?: string;
  /** 近一年配息合計（元）、次數換算的頻率、連續配息年數（資料從 2020 年起）、近一年填息率（%）。 */
  dividendPerYear?: number;
  frequency?: '月' | '季' | '半年' | '年';
  dividendYears?: number;
  /** 連續配息一路數到資料開頭（2020 年），實際可能更久。 */
  dividendYearsAtLeast?: boolean;
  fillRate?: number;
  /** 最近的配息 [除息日或發放日, 金額]（新到舊，最多 12 筆）。 */
  divs?: Array<[string, number]>;
}

const outPath = join(dir, 'etf-info.json');
const fortunePath = join(dir, 'etf-fortune.json');
const prev = readJson<{ asOf?: string; etfs: Record<string, EtfInfo> }>(outPath, { etfs: {} });
const fortune = readJson<Record<string, Fortune>>(fortunePath, {});
const etfs: Record<string, EtfInfo> = {};
for (const [code, v] of Object.entries(prev.etfs ?? {})) etfs[code] = { ...v };
const info = (code: string) => (etfs[code] ??= {});

// ------------------------------------------------------------ 每日淨值、單位數

try {
  const j = (await (await get('https://mis.twse.com.tw/stock/data/all_etf.txt')).json()) as { a1?: Array<{ msgArray?: Array<Record<string, unknown>> }> };
  let n = 0;
  for (const g of j.a1 ?? []) {
    for (const r of g.msgArray ?? []) {
      const code = String(r.a ?? '').trim();
      if (!code) continue;
      const e = info(code);
      e.name = String(r.b ?? '').replace(/[（(].*$/, '').trim() || e.name;
      const units = num(r.c);
      const nav = num(r.f);
      const navPrev = num(r.h);
      if (units > 0) e.units = units;
      if (nav > 0) e.nav = nav;
      if (navPrev > 0) e.navPrev = navPrev;
      e.navDate = isoOf(String(r.i ?? '')) ?? e.navDate;
      const base = nav > 0 ? nav : navPrev;
      if (units > 0 && base > 0) e.aum = Math.round(((units * base) / 1e8) * 100) / 100;
      n++;
    }
  }
  console.log(`ETF 淨值：${n} 檔`);
} catch (e) {
  console.log(`ETF 淨值 ✗ ${e}`);
}

// ------------------------------------------------------------ 基金基本資料

try {
  const rows = (await (await get('https://openapi.twse.com.tw/v1/opendata/t187ap47_L')).json()) as Array<Record<string, string>>;
  for (const r of rows) {
    const code = String(r['基金代號'] ?? '').trim();
    if (!code) continue;
    const e = info(code);
    const idx = String(r['標的指數/追蹤指數名稱'] ?? '').trim();
    if (idx && idx !== '不適用') e.underlying = idx;
    e.listed = isoOf(String(r['上市日期'] ?? '')) ?? e.listed;
    e.name ||= String(r['基金簡稱'] ?? '').trim();
  }
  console.log(`基金基本資料：${rows.length} 檔`);
} catch (e) {
  console.log(`基金基本資料 ✗ ${e}`);
}

// ------------------------------------------------------------ ETF e添富

function parseFortune(html: string): Omit<Fortune, 'at'> | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(&nbsp;|\s)+/g, ' ');
  if (!text.includes('證券代號')) return null;
  const pick = (re: RegExp) => text.match(re)?.[1]?.trim();
  const divPart = text.slice(text.indexOf('收益分配'), text.indexOf('歷史配息資訊') > 0 ? text.indexOf('歷史配息資訊') : undefined);
  const divs: Array<[string, number]> = [];
  for (const m of divPart.matchAll(/(\d{4}\/\d{2}\/\d{2}) ([\d.]+)/g)) {
    const d = isoOf(m[1]);
    if (d) divs.push([d, Number(m[2])]);
  }
  const aum = num(pick(/資產規模\(億元\) ([\d,.]+)/));
  const holders = num(pick(/受益人次\(萬人\) ([\d,.]+)/));
  return {
    issuer: pick(/發行公司 (\S+)/),
    underlying: pick(/標的指數 (.+?) (?:主題\/因子|投資策略|資產規模)/),
    aum: aum > 0 ? aum : undefined,
    holders: holders > 0 ? holders : undefined,
    divs,
  };
}

{
  const now = Date.now();
  const listed = Object.keys(etfs).filter((c) => !c.endsWith('B') || PRIORITY.includes(c));
  const order = [...new Set([...PRIORITY, ...listed])].filter((c) => !fortune[c] || now - fortune[c].at > FORTUNE_MAX_AGE);
  let done = 0;
  for (const code of order.slice(0, FORTUNE_PER_RUN)) {
    try {
      const html = await (await get(`https://www.twse.com.tw/zh/ETFortune/etfInfo/${encodeURIComponent(code)}`)).text();
      const f = parseFortune(html);
      // 上櫃 ETF 沒有頁面：記下時間，一週後再試
      fortune[code] = { at: now, ...(f ?? {}) };
      if (f) done++;
    } catch (e) {
      console.log(`  e添富 ${code} ✗ ${e}`);
    }
    await sleep(1500);
  }
  writeFileSync(fortunePath, JSON.stringify(fortune));
  console.log(`e添富：這次抓 ${Math.min(order.length, FORTUNE_PER_RUN)} 檔、成功 ${done} 檔，還有 ${Math.max(0, order.length - FORTUNE_PER_RUN)} 檔待抓`);
}

// ------------------------------------------------------------ 受益人數（集保）

const tdcc = readJson<{ date?: string; holders?: Record<string, number> }>(join(dir, 'tdcc-etf.json'), {});

// ------------------------------------------------------------ 配息、填息（不連網）

type ExRow = [string, string, number, number, number, string];
const exByCode = new Map<string, ExRow[]>();
const exDir = join(dir, 'exrights');
if (existsSync(exDir)) {
  for (const f of readdirSync(exDir).filter((x) => x.endsWith('.json')).sort()) {
    for (const r of readJson<ExRow[]>(join(exDir, f), [])) {
      if (!r[1]?.startsWith('00') || !(r[4] > 0) || !String(r[5]).includes('息')) continue;
      (exByCode.get(r[1]) ?? exByCode.set(r[1], []).get(r[1])!).push(r);
    }
  }
}

const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const yearAgo = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
})();
const freqOf = (n: number): EtfInfo['frequency'] => (n >= 10 ? '月' : n >= 3 ? '季' : n === 2 ? '半年' : n === 1 ? '年' : undefined);

for (const [code, e] of Object.entries(etfs)) {
  const f = fortune[code];
  if (f) {
    e.issuer = f.issuer ?? e.issuer;
    e.underlying = e.underlying ?? f.underlying;
    if (!e.aum && f.aum) e.aum = f.aum;
    if (f.holders) e.holders = f.holders;
  }
  const people = tdcc.holders?.[code];
  if (people) {
    e.holders = Math.round((people / 1e4) * 100) / 100;
    e.holdersDate = tdcc.date;
  }
  // 除權息資料（除息日）優先；還沒有時改用 e添富的最近幾次發放
  const ex = (exByCode.get(code) ?? []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const events: Array<[string, number]> = ex.length ? ex.map((r) => [r[0], r[4]]) : (f?.divs ?? []).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const recent = events.filter(([d]) => d > yearAgo && d <= today);
  if (events.length) {
    e.dividendPerYear = Math.round(recent.reduce((a, [, v]) => a + v, 0) * 1000) / 1000;
    e.frequency = freqOf(recent.length) ?? e.frequency;
    e.divs = events.slice(-12).reverse();
    // 連續配息年數：從今年（今年還沒配也不算中斷）往回數
    const years = new Set(events.map(([d]) => Number(d.slice(0, 4))));
    let y = Number(today.slice(0, 4));
    if (!years.has(y)) y -= 1;
    let streak = 0;
    while (years.has(y)) {
      streak++;
      y--;
    }
    e.dividendYears = streak;
    e.dividendYearsAtLeast = streak > 0 && ex.length > 0 && y < Number(ex[0][0].slice(0, 4)) && Number(ex[0][0].slice(0, 4)) <= 2020;
  }
  // 填息：除息後收盤價回到除息前收盤價就算填息（只看近一年、至少過了 5 天的）
  const candles = ex.length ? readJson<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', `${code}.json`), []) : [];
  if (candles.length) {
    const judged = ex.filter((r) => r[0] > yearAgo && candles.filter((c) => c[0] >= r[0]).length >= 5);
    if (judged.length) {
      const filled = judged.filter((r) => candles.some((c) => c[0] >= r[0] && c[4] >= r[2])).length;
      e.fillRate = Math.round((filled / judged.length) * 100);
    }
  }
}

writeFileSync(outPath, JSON.stringify({ asOf: today, etfs }));
console.log(`etf-info.json：${Object.keys(etfs).length} 檔`);
