/**
 * 每天整理籌碼資料（GitHub Actions 執行）：
 *
 *   node scripts/chips.ts <資料資料夾>
 *
 * - 法人買賣超：證交所 T86、櫃買三大法人，每個交易日各一次請求，存在 inst/<日期>.json（外資＋投信買賣超股數）。
 *   回補最近 20 個交易日，用來算「法人連買 / 連賣幾天」。
 * - 千張大戶：集保股權分散表（每週更新，只提供最新一週），存在 tdcc/<日期>.json（持股 1,000 張以上的比率）。
 *   累積幾週後就能算 4 週變化。
 * - 輸出 chips.json 給網頁讀。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const INST_DAYS = 20;
const GAP_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const wanted = (code: string) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function get(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/csv, */*' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      await sleep(4000 * (i + 1));
    }
  }
  throw new Error(`${url} → ${last}`);
}

/** 上市：外陸資（不含外資自營商）＋投信買賣超股數。null = 沒有資料。 */
async function twseInst(date: string): Promise<Record<string, number> | null> {
  const j: any = await (await get(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replace(/-/g, '')}&selectType=ALLBUT0999&response=json`)).json();
  if (j?.stat !== 'OK' || !Array.isArray(j.data) || (j.date && j.date !== date.replace(/-/g, ''))) return null;
  const f: string[] = j.fields;
  const foreign = f.findIndex((x) => x.startsWith('外陸資買賣超股數'));
  const trust = f.findIndex((x) => x.startsWith('投信買賣超股數'));
  if (foreign < 0 || trust < 0) throw new Error(`T86 欄位不符：${f.join(',')}`);
  const out: Record<string, number> = {};
  for (const r of j.data) {
    const code = String(r[0]).trim();
    if (wanted(code)) out[code] = num(r[foreign]) + num(r[trust]);
  }
  return out;
}

/** 上櫃：欄位依序為外資（不含自營商）、外資自營商、外資合計、投信、自營商…，每組是買進、賣出、買賣超。 */
async function tpexInst(date: string): Promise<Record<string, number> | null> {
  const j: any = await (await get(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(date.replace(/-/g, '/'))}&response=json`)).json();
  if (j?.date && String(j.date) !== date.replace(/-/g, '')) return null;
  const table = (j?.tables ?? []).find((t: any) => Array.isArray(t.fields) && t.fields[0] === '代號' && t.data?.length);
  if (!table) return null;
  if (table.fields.length < 14 || table.fields[4] !== '買賣超股數' || table.fields[13] !== '買賣超股數') throw new Error(`櫃買法人欄位不符：${table.fields.join(',')}`);
  const out: Record<string, number> = {};
  for (const r of table.data) {
    const code = String(r[0]).trim();
    if (wanted(code)) out[code] = num(r[4]) + num(r[13]);
  }
  return out;
}

/** 由新到舊數連續同方向的天數；買賣超為 0 或缺資料就中斷。 */
export function streakOf(nets: number[]): number {
  if (!nets.length || !nets[0]) return 0;
  const sign = Math.sign(nets[0]);
  let n = 0;
  for (const v of nets) {
    if (Math.sign(v) !== sign) break;
    n++;
  }
  return sign * n;
}

async function updateInst(dir: string, tradingDays: string[]): Promise<void> {
  const instDir = join(dir, 'inst');
  mkdirSync(instDir, { recursive: true });
  const have = new Set(readdirSync(instDir).map((f) => f.replace(/\.json$/, '')));
  const todo = tradingDays.filter((d) => !have.has(d));
  console.log(`法人：最近 ${tradingDays.length} 個交易日，缺 ${todo.length} 天`);
  for (const date of todo) {
    const [a, b] = await Promise.allSettled([twseInst(date), tpexInst(date)]);
    if (a.status === 'fulfilled' && a.value) {
      // 檔案以日期為單位，上市、上櫃都成功才存，否則下次整天重抓
      if (b.status === 'fulfilled' && b.value) {
        writeFileSync(join(instDir, `${date}.json`), JSON.stringify({ ...a.value, ...b.value }));
        console.log(`  ${date}：上市 ${Object.keys(a.value).length} 檔、上櫃 ${Object.keys(b.value).length} 檔`);
      } else console.log(`  ${date}：上櫃 ✗ ${b.status === 'rejected' ? b.reason : '無資料'}`);
    } else console.log(`  ${date}：上市 ✗ ${a.status === 'rejected' ? a.reason : '無資料'}`);
    await sleep(GAP_MS);
  }
  // 只留最近的檔案
  for (const f of readdirSync(instDir)) if (f.replace(/\.json$/, '') < (tradingDays[tradingDays.length - 1] ?? '')) rmSync(join(instDir, f));
}

/** 集保股權分散表：持股分級 15 = 1,000,001 股以上（千張大戶）。 */
async function updateTdcc(dir: string): Promise<void> {
  const tdccDir = join(dir, 'tdcc');
  mkdirSync(tdccDir, { recursive: true });
  try {
    const text = await (await get('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5')).text();
    const pct: Record<string, number> = {};
    let date = '';
    for (const line of text.split('\n').slice(1)) {
      const [d, code, level, , , ratio] = line.split(',').map((s) => s.trim());
      if (level !== '15' || !wanted(code)) continue;
      date = d;
      pct[code] = Number(ratio);
    }
    if (!date || Object.keys(pct).length < 500) throw new Error(`資料不完整（${Object.keys(pct).length} 檔）`);
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    writeFileSync(join(tdccDir, `${iso}.json`), JSON.stringify(pct));
    console.log(`集保：${iso} ${Object.keys(pct).length} 檔`);
  } catch (e) {
    console.log(`集保 ✗ ${e}`);
  }
  // 保留約 10 週
  const files = readdirSync(tdccDir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 10))) rmSync(join(tdccDir, f));
}

function main(dir: string): void {
  const out: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const instFiles = readdirSync(join(dir, 'inst')).sort().reverse();
  if (instFiles.length) {
    const days = instFiles.map((f) => readJson<Record<string, number>>(join(dir, 'inst', f), {}));
    const codes = new Set(days.flatMap((d) => Object.keys(d)));
    const streak: Record<string, number> = {};
    for (const code of codes) streak[code] = streakOf(days.map((d) => d[code] ?? 0));
    out.inst = { asOf: instFiles[0].replace(/\.json$/, ''), days: instFiles.length, streak };
  }

  const weeks = readdirSync(join(dir, 'tdcc')).sort();
  if (weeks.length >= 2) {
    const latest = weeks[weeks.length - 1];
    const asOf = latest.replace(/\.json$/, '');
    // 和 4 週前比；還沒累積到 4 週時用最舊的一週
    const target = shift(asOf, -28);
    const from = weeks.find((w) => w.replace(/\.json$/, '') >= target) ?? weeks[0];
    const a = readJson<Record<string, number>>(join(dir, 'tdcc', from), {});
    const b = readJson<Record<string, number>>(join(dir, 'tdcc', latest), {});
    const chg: Record<string, number> = {};
    for (const [code, v] of Object.entries(b)) if (a[code] !== undefined) chg[code] = Math.round((v - a[code]) * 100) / 100;
    out.big = { asOf, from: from.replace(/\.json$/, ''), chg };
  }
  writeFileSync(join(dir, 'chips.json'), JSON.stringify(out));
  console.log(`完成：法人 ${instFiles.length} 天、集保 ${weeks.length} 週`);
}

const dir = process.argv[2] ?? 'data';
mkdirSync(dir, { recursive: true });
// 交易日：用日 K 已經確認過的上市交易日；沒有時用平日
const meta = readJson<{ twse?: string[]; holidays?: string[] }>(join(dir, 'candles-meta.json'), {});
let days = (meta.twse ?? []).slice(-INST_DAYS);
if (days.length < INST_DAYS) {
  const holidays = new Set(meta.holidays ?? []);
  const now = new Date(Date.now() + 8 * 3600_000);
  let d = now.getUTCHours() >= 16 ? now.toISOString().slice(0, 10) : shift(now.toISOString().slice(0, 10), -1);
  const list: string[] = [];
  while (list.length < INST_DAYS) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(d)) list.push(d);
    d = shift(d, -1);
  }
  days = list.reverse();
}
await updateInst(dir, days.slice().reverse());
await updateTdcc(dir);
main(dir);
