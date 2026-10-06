/**
 * 每天累積證交所、櫃買中心的「全市場每日收盤行情」，做成個股分析用的日 K（GitHub Actions 執行）。
 *
 *   node scripts/candles.ts <資料資料夾>
 *
 * - 每個交易日只要兩次請求（上市一次、上櫃一次）就拿到全部股票的開高低收量。
 * - 第一次執行時會回補近一年；每次最多補 MAX_DATES 天（從最近的日期往回），幾次部署後就補齊。
 * - 輸出 candles/<代號>.json：[[日期, 開, 高, 低, 收, 張], …]（一檔一個檔案，網頁只下載正在看的那檔）
 * - candles-meta.json 記錄已抓過的日期與休市日，避免重抓。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const MAX_DATES = Number(process.env.CANDLE_MAX_DATES ?? 40);
const KEEP_DAYS = 380;
const GAP_MS = 2500;

type Row = [string, number, number, number, number, number];
interface Meta {
  twse: string[];
  tpex: string[];
  /** 兩個市場都沒有資料的日期（休市）。 */
  holidays: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};
/** 一般股票（4 碼）與 ETF（00 開頭，可帶英文字母）。 */
const wanted = (code: string) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 台北時間的日期 YYYY-MM-DD。 */
function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getJson(url: string): Promise<any> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(40_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(4000 * (i + 1));
    }
  }
  throw new Error(`${url} → ${last}`);
}

/** 由表格欄位名稱找出各欄位置，轉成日 K 列。 */
function parseTable(fields: string[], data: unknown[][], date: string, names: { code: string; open: string; high: string; low: string; close: string; shares: string }): Map<string, Row> {
  const at = (name: string) => fields.findIndex((f) => f.replace(/\s/g, '').startsWith(name));
  const idx = { code: at(names.code), open: at(names.open), high: at(names.high), low: at(names.low), close: at(names.close), shares: at(names.shares) };
  if (Object.values(idx).some((i) => i < 0)) throw new Error(`欄位不符：${fields.join(',')}`);
  const out = new Map<string, Row>();
  for (const r of data) {
    const code = String(r[idx.code] ?? '').trim();
    if (!wanted(code)) continue;
    const o = num(r[idx.open]);
    const h = num(r[idx.high]);
    const l = num(r[idx.low]);
    const c = num(r[idx.close]);
    // 沒有成交時價格是 "--" 或 "---"
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.set(code, [date, o, h, l, c, Math.round((num(r[idx.shares]) || 0) / 1000)]);
  }
  return out;
}

/** 上市：每日收盤行情（不含權證）。null = 這天沒有資料（休市）。 */
async function twse(date: string): Promise<Map<string, Row> | null> {
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replace(/-/g, '')}&type=ALLBUT0999&response=json`);
  if (j?.stat !== 'OK') return null;
  if (j.date && j.date !== date.replace(/-/g, '')) return null;
  const table = (j.tables ?? []).find((t: any) => String(t.title ?? '').includes('每日收盤行情'));
  if (!table?.data?.length) return null;
  return parseTable(table.fields, table.data, date, { code: '證券代號', open: '開盤價', high: '最高價', low: '最低價', close: '收盤價', shares: '成交股數' });
}

/** 上櫃：上櫃股票行情。 */
async function tpex(date: string): Promise<Map<string, Row> | null> {
  const j = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(date.replace(/-/g, '/'))}&type=EW&response=json`);
  if (j?.date && String(j.date).replace(/\D/g, '') !== date.replace(/-/g, '')) return null;
  const table = (j?.tables ?? []).find((t: any) => Array.isArray(t.fields) && t.fields.includes('代號') && t.data?.length);
  if (!table) return null;
  return parseTable(table.fields, table.data, date, { code: '代號', open: '開盤', high: '最高', low: '最低', close: '收盤', shares: '成交股數' });
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'data';
  const shardDir = join(dir, 'candles');
  mkdirSync(shardDir, { recursive: true });
  const metaPath = join(dir, 'candles-meta.json');
  const meta = readJson<Meta>(metaPath, { twse: [], tpex: [], holidays: [] });
  const done = { twse: new Set(meta.twse), tpex: new Set(meta.tpex) };
  const holidays = new Set(meta.holidays);

  // 讀進現有的日 K
  const stocks = new Map<string, Map<string, Row>>();
  for (const f of readdirSync(shardDir).filter((f) => f.endsWith('.json'))) {
    const rows = readJson<Row[]>(join(shardDir, f), []);
    if (Array.isArray(rows)) stocks.set(f.slice(0, -5), new Map(rows.map((r) => [r[0], r])));
  }

  // 收盤資料大約 14:30 後才公布；更早執行時不抓今天
  const now = new Date(Date.now() + 8 * 3600_000);
  const today = taipeiToday();
  const last = now.getUTCHours() * 60 + now.getUTCMinutes() >= 14 * 60 + 40 ? today : shift(today, -1);
  const oldest = shift(today, -365);
  const todo: string[] = [];
  for (let d = last; d >= oldest; d = shift(d, -1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || holidays.has(d)) continue;
    if (done.twse.has(d) && done.tpex.has(d)) continue;
    todo.push(d);
  }
  console.log(`待抓 ${todo.length} 天，這次最多 ${MAX_DATES} 天`);

  let fetched = 0;
  for (const date of todo.slice(0, MAX_DATES)) {
    const [a, b] = await Promise.allSettled([done.twse.has(date) ? Promise.resolve(undefined) : twse(date), done.tpex.has(date) ? Promise.resolve(undefined) : tpex(date)]);
    const parts: string[] = [];
    let empty = 0;
    for (const [market, r] of [['twse', a], ['tpex', b]] as const) {
      if (r.status === 'rejected') {
        parts.push(`${market} ✗ ${r.reason}`);
        continue;
      }
      if (r.value === undefined) continue;
      if (r.value === null) {
        empty++;
        parts.push(`${market} 無資料`);
        continue;
      }
      for (const [code, row] of r.value) {
        if (!stocks.has(code)) stocks.set(code, new Map());
        stocks.get(code)!.set(date, row);
      }
      done[market].add(date);
      parts.push(`${market} ${r.value.size} 檔`);
    }
    // 兩邊都沒有資料、而且不是今天（今天可能只是還沒公布）才當作休市
    if (empty === 2 && date < today) holidays.add(date);
    fetched++;
    console.log(`${date}：${parts.join('、')}`);
    await sleep(GAP_MS);
  }

  // 一檔一個檔案，只留近一年多
  const cutoff = shift(today, -KEEP_DAYS);
  for (const [code, rows] of stocks) {
    const list = [...rows.values()].filter((r) => r[0] >= cutoff).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const path = join(shardDir, `${code}.json`);
    if (list.length) writeFileSync(path, JSON.stringify(list));
    else rmSync(path, { force: true });
  }
  const keep = (set: Set<string>) => [...set].filter((d) => d >= cutoff).sort();
  writeFileSync(metaPath, JSON.stringify({ twse: keep(done.twse), tpex: keep(done.tpex), holidays: keep(holidays) } satisfies Meta));
  console.log(`完成：這次抓 ${fetched} 天，共 ${stocks.size} 檔、${done.twse.size} 個上市交易日、${done.tpex.size} 個上櫃交易日；剩 ${Math.max(0, todo.length - fetched)} 天待回補`);
}

await main();
