/**
 * 股票名稱對照表（含已下市、已下櫃的股票與舊 ETF），模擬盤顯示名稱用。
 *
 *   node scripts/names.ts <資料資料夾>
 *
 * - 從證交所 MI_INDEX、櫃買上櫃行情抓「證券代號＋名稱」，START 以後每季抽第一個交易日，只抓一次（names-meta.json 記錄）。
 * - 再用最新的 stocks.json 覆蓋（改名的以現在的名稱為準）。
 * - 輸出 names.json：{ 代號: 名稱 }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const START = process.env.ARCHIVE_START ?? '2020-01-01';
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wanted = (code: string) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(40_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function twseNames(date: string): Promise<Record<string, string>> {
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replace(/-/g, '')}&type=ALLBUT0999&response=json`);
  const table = (j?.tables ?? []).find((t: any) => String(t.title ?? '').includes('每日收盤行情'));
  if (!table) return {};
  const ci = table.fields.findIndex((f: string) => f.includes('證券代號'));
  const ni = table.fields.findIndex((f: string) => f.includes('證券名稱'));
  const out: Record<string, string> = {};
  for (const r of table.data ?? []) {
    const code = String(r[ci]).trim();
    if (wanted(code)) out[code] = String(r[ni]).trim();
  }
  return out;
}

async function tpexNames(date: string): Promise<Record<string, string>> {
  const j = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(date.replace(/-/g, '/'))}&type=EW&response=json`);
  const table = (j?.tables ?? []).find((t: any) => Array.isArray(t.fields) && t.fields.includes('代號') && t.data?.length);
  if (!table) return {};
  const ci = table.fields.indexOf('代號');
  const ni = table.fields.indexOf('名稱');
  const out: Record<string, string> = {};
  for (const r of table.data ?? []) {
    const code = String(r[ci]).trim();
    if (wanted(code)) out[code] = String(r[ni]).trim();
  }
  return out;
}

const dir = process.argv[2] ?? 'data';
const namesPath = join(dir, 'names.json');
const metaPath = join(dir, 'names-meta.json');
const names = readJson<Record<string, string>>(namesPath, {});
const meta = readJson<{ done: string[] }>(metaPath, { done: [] });
const done = new Set(meta.done);

// 每季第一個交易日（用日 K 的交易日曆找）
const cal = readJson<{ twse?: string[] }>(join(dir, 'candles-meta.json'), {}).twse ?? [];
const quarters = new Map<string, string>();
for (const d of cal) {
  if (d < START) continue;
  const q = `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  if (!quarters.has(q)) quarters.set(q, d);
}
let fetched = 0;
for (const date of quarters.values()) {
  if (done.has(date) || Date.now() > DEADLINE) continue;
  try {
    const [a, b] = await Promise.all([twseNames(date), tpexNames(date)]);
    // 舊的名稱不覆蓋已知的（之後再用最新目錄更正）
    for (const [c, n] of Object.entries({ ...a, ...b })) names[c] ??= n;
    if (Object.keys(a).length && Object.keys(b).length) done.add(date);
    fetched++;
    console.log(`${date}：上市 ${Object.keys(a).length}、上櫃 ${Object.keys(b).length}`);
  } catch (e) {
    console.log(`${date} ✗ ${e}`);
  }
  await sleep(2500);
}
// 現在的名稱優先
for (const s of readJson<{ stocks?: Array<{ code: string; name: string }> }>(join(dir, 'stocks.json'), {}).stocks ?? []) names[s.code] = s.name;
writeFileSync(namesPath, JSON.stringify(names));
writeFileSync(metaPath, JSON.stringify({ done: [...done].sort() }));
console.log(`完成：這次抓 ${fetched} 天，共 ${Object.keys(names).length} 個名稱`);
