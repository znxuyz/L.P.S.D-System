/**
 * 回補歷史資料（GitHub Actions 執行），讓網站一開始就不用等資料慢慢累積：
 *
 *   node scripts/history.ts <資料資料夾>
 *
 * - 5 年本益比區間：證交所 BWIBBU_d、櫃買本益比查詢（某一天全市場），每月取月底一天，共 60 個月。
 *   存在 pe/<年-月>.json，過去的月份只抓一次；輸出 pe5y.json：{ 代號: [最低, 25%, 中位數, 75%, 最高] }。
 * - 每日本益比、殖利率、淨值比：同上的來源，START（預設 2025-01-01）以後每天一份，存在 ratios/<日期>.json。
 * - 重大訊息：公開資訊觀測站「歷史重大訊息」（某一天全市場），START 以後全部回補，主旨全文存在 events/<日期>.json。
 * - 千張大戶 4 週前的持股比率：集保「股權分散表查詢」（可查過去一年，但一次一檔）。
 *   先補「最新一週往前 4 週」那一週（chips.ts 算 4 週變化用），再由新到舊補其他週，存進 tdcc/<日期>.json。
 *   集保只保留一年，所以最早只能補到一年前；每次最多查 TDCC_MAX 筆，每秒一次。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent, parseMopsRows, rocToIso } from '../web/src/data/mopsParse.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const PE_MONTHS = Number(process.env.PE_MONTHS ?? 60);
const PE_MIN_SAMPLES = 24;
const TDCC_MAX = Number(process.env.TDCC_MAX ?? 500);
/** 每日資料從這一天開始全部回補保留。 */
const START = process.env.ARCHIVE_START ?? '2025-01-01';
const EVENT_MAX = Number(process.env.EVENT_MAX ?? 25);
const RATIO_MAX = Number(process.env.RATIO_MAX ?? 60);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  const n = Number(s);
  return s === '' || !Number.isFinite(n) ? NaN : n;
};
const wanted = (code: string) => /^\d{4}$/.test(code);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function getJson(url: string): Promise<any> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(4000 * (i + 1));
    }
  }
  throw new Error(`${url} → ${last}`);
}

// ------------------------------------------------------------ 5 年本益比

type Ratio = [number | null, number | null, number | null];

/** 某一天全市場的 [本益比, 殖利率, 股價淨值比]；null = 那天沒開盤。 */
async function ratiosOn(date: string): Promise<Record<string, Ratio> | null> {
  const out: Record<string, Ratio> = {};
  const v = (x: unknown) => (num(x) > 0 ? num(x) : null);
  const tw = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${date.replace(/-/g, '')}&selectType=ALL&response=json`);
  if (tw?.stat !== 'OK' || !Array.isArray(tw.data) || !tw.data.length) return null;
  const f = (name: string) => tw.fields.indexOf(name);
  for (const r of tw.data) {
    const code = String(r[f('證券代號')]).trim();
    if (wanted(code)) out[code] = [v(r[f('本益比')]), num(r[f('殖利率(%)')]) >= 0 ? num(r[f('殖利率(%)')]) : null, v(r[f('股價淨值比')])];
  }
  await sleep(2500);
  const tp = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${encodeURIComponent(date.replace(/-/g, '/'))}&response=json`);
  const table = (tp?.tables ?? []).find((t: any) => Array.isArray(t.fields) && t.fields.includes('股票代號'));
  if (table) {
    const g = (name: string) => table.fields.indexOf(name);
    for (const r of table.data) {
      const code = String(r[g('股票代號')]).trim();
      if (wanted(code)) out[code] = [v(r[g('本益比')]), num(r[g('殖利率(%)')]) >= 0 ? num(r[g('殖利率(%)')]) : null, v(r[g('股價淨值比')])];
    }
  }
  return out;
}

/** 某一天全市場本益比（只取有獲利的）。 */
async function peOn(date: string): Promise<Record<string, number> | null> {
  const r = await ratiosOn(date);
  if (!r) return null;
  return Object.fromEntries(Object.entries(r).flatMap(([code, [pe]]) => (pe ? [[code, pe]] : [])));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** 每個月最後一個有開盤的日子（往前找最多 12 天，避開農曆年長假）。 */
async function monthEnd(year: number, month: number): Promise<Record<string, number> | null> {
  const d = new Date(Date.UTC(year, month, 0));
  for (let i = 0; i < 12; i++, d.setUTCDate(d.getUTCDate() - 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const r = await peOn(iso(d));
    await sleep(2500);
    if (r && Object.keys(r).length > 500) return r;
  }
  return null;
}

export function quantiles(values: number[]): [number, number, number, number, number] {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  const r = (v: number) => Math.round(v * 100) / 100;
  return [r(s[0]), r(q(0.25)), r(q(0.5)), r(q(0.75)), r(s[s.length - 1])];
}

async function peHistory(dir: string): Promise<void> {
  const peDir = join(dir, 'pe');
  mkdirSync(peDir, { recursive: true });
  const now = new Date(Date.now() + 8 * 3600_000);
  let fetched = 0;
  // 由近到遠：從上個月開始（這個月還沒結束）
  for (let k = 1; k <= PE_MONTHS; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const path = join(peDir, `${key}.json`);
    if (existsSync(path)) continue;
    try {
      const r = await monthEnd(d.getUTCFullYear(), d.getUTCMonth() + 1);
      if (r) {
        writeFileSync(path, JSON.stringify(r));
        fetched++;
        console.log(`本益比 ${key}：${Object.keys(r).length} 檔`);
      } else console.log(`本益比 ${key}：沒有資料`);
    } catch (e) {
      console.log(`本益比 ${key} ✗ ${e}`);
    }
  }
  const months = readdirSync(peDir).filter((f) => f.endsWith('.json')).sort().slice(-PE_MONTHS);
  const byCode = new Map<string, number[]>();
  for (const f of months) for (const [code, pe] of Object.entries(readJson<Record<string, number>>(join(peDir, f), {}))) byCode.set(code, [...(byCode.get(code) ?? []), pe]);
  const out: Record<string, [number, number, number, number, number]> = {};
  for (const [code, list] of byCode) if (list.length >= PE_MIN_SAMPLES) out[code] = quantiles(list);
  writeFileSync(
    join(dir, 'pe5y.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), from: months[0]?.slice(0, 7), to: months.at(-1)?.slice(0, 7), months: months.length, stocks: out }),
  );
  console.log(`本益比區間：這次抓 ${fetched} 個月，共 ${months.length} 個月、${Object.keys(out).length} 檔`);
}

// ------------------------------------------------------------ 集保 4 週前

interface TdccSession {
  token: string;
  cookie: string;
  dates: string[];
}

async function tdccSession(): Promise<TdccSession> {
  const res = await fetch('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
  const html = await res.text();
  const token = html.match(/name="SYNCHRONIZER_TOKEN"[^>]*value="([^"]+)"/)?.[1];
  if (!token) throw new Error('集保：拿不到查詢表單');
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const dates = [...html.matchAll(/<option value="(\d{8})"/g)].map((m) => m[1]);
  return { token, cookie, dates };
}

/** 查一檔股票某一週「1,000,001 股以上」的持股比率。 */
async function tdccBig(s: TdccSession, code: string, date: string): Promise<number | null> {
  const body = new URLSearchParams({ SYNCHRONIZER_TOKEN: s.token, SYNCHRONIZER_URI: '/portal/zh/smWeb/qryStock', method: 'submit', firDate: s.dates[0], scaDate: date, sqlMethod: 'StockNo', stockNo: code, stockName: '' });
  const res = await fetch('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: s.cookie },
    body: body.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  const html = await res.text();
  // 表單 token 會換新的，下一次查詢要用新的
  s.token = html.match(/name="SYNCHRONIZER_TOKEN"[^>]*value="([^"]+)"/)?.[1] ?? s.token;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/15 1,000,001以上 [\d,]+ [\d,]+ ([\d.]+)/);
  return m ? Number(m[1]) : null;
}

async function tdccHistory(dir: string): Promise<void> {
  const tdccDir = join(dir, 'tdcc');
  mkdirSync(tdccDir, { recursive: true });
  const weeks = readdirSync(tdccDir).filter((f) => f.endsWith('.json')).sort();
  if (!weeks.length) return console.log('集保：還沒有最新一週的資料，先跳過');
  const latest = weeks.at(-1)!.slice(0, 10);
  const codes = Object.keys(readJson<Record<string, number>>(join(tdccDir, weeks.at(-1)!), {})).filter(wanted);
  let s: TdccSession;
  try {
    s = await tdccSession();
  } catch (e) {
    return console.log(`集保 ✗ ${e}`);
  }
  // 先補 4 週前（算 4 週變化要用），再由新到舊補其他週；集保只提供近一年
  const all = s.dates.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`).filter((d) => d < latest && d >= START);
  if (!all.length) return console.log('集保：查詢日期不足');
  const targets = [all[3], ...all.filter((_, i) => i !== 3)].filter(Boolean);
  let budget = TDCC_MAX;
  let ok = 0;
  let fail = 0;
  for (const target of targets) {
    if (budget <= 0 || fail > 30) break;
    const path = join(tdccDir, `${target}.json`);
    const have = readJson<Record<string, number>>(path, {});
    const todo = codes.filter((c) => have[c] === undefined);
    if (!todo.length) continue;
    console.log(`集保 ${target}：已有 ${Object.keys(have).length} 檔，還缺 ${todo.length} 檔`);
    for (const code of todo.slice(0, budget)) {
      budget--;
      try {
        const v = await tdccBig(s, code, target.replace(/-/g, ''));
        if (v !== null) {
          have[code] = v;
          ok++;
        } else if (++fail > 30 && ok === 0) throw new Error('連續查不到資料，停止');
      } catch (e) {
        console.log(`集保 ${code} ✗ ${e}`);
        if (++fail > 30) break;
        s = await tdccSession().catch(() => s);
      }
      if ((ok + fail) % 100 === 0) writeFileSync(path, JSON.stringify(have));
      await sleep(1000);
    }
    writeFileSync(path, JSON.stringify(have));
  }
  console.log(`集保：這次補 ${ok} 筆，失敗 ${fail} 筆`);
}

// ------------------------------------------------------------ 歷史重大訊息

/** 某一天全市場的重大訊息（含前一日 17:30 以後）。 */
async function eventsOn(date: string): Promise<Array<Record<string, string>>> {
  const [y, m, d] = date.split('-');
  const body = new URLSearchParams({ encodeURIComponent: '1', step: '0', firstin: 'true', off: '1', TYPEK: 'all', year: String(Number(y) - 1911), month: m, day: d, queryName: 'co_id', inpuType: 'co_id' });
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t05st02', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(120_000),
      });
      const html = await res.text();
      if (html.includes('查無需求資料')) return [];
      if (html.includes('FOR SECURITY REASONS') || html.includes('查詢過於頻繁')) throw new Error('被擋下');
      return parseMopsRows(html);
    } catch (e) {
      last = e;
      await sleep(8000 * (i + 1));
    }
  }
  throw new Error(`重大訊息 ${date} → ${last}`);
}

async function eventHistory(dir: string): Promise<void> {
  const evDir = join(dir, 'events');
  mkdirSync(evDir, { recursive: true });
  const donePath = join(dir, 'events-backfill.json');
  const done = new Set(readJson<string[]>(donePath, []));
  const todo = weekdaysSince(START).filter((d) => !done.has(d));
  console.log(`重大訊息：還缺 ${todo.length} 天，這次最多 ${EVENT_MAX} 天`);
  for (const date of todo.slice(0, EVENT_MAX)) {
    try {
      const rows = await eventsOn(date);
      let n = 0;
      const byDate = new Map<string, Array<[string, string, string]>>();
      for (const r of rows) {
        const code = String(r['公司代號'] ?? '').trim();
        const subject = String(r['主旨'] ?? '').replace(/\s+/g, ' ').trim();
        const day = rocToIso(String(r['發言日期'] ?? ''));
        if (!wanted(code) || !day || !subject) continue;
        // 所有重大訊息都存（主旨全文），分類規則之後改了也能重新判斷
        const type = classifyEvent(subject) ?? '';
        if (!byDate.has(day)) byDate.set(day, []);
        byDate.get(day)!.push([code, type, subject]);
        if (type) n++;
      }
      for (const [day, list] of byDate) {
        const path = join(evDir, `${day}.json`);
        const prev = readJson<Array<[string, string, string]>>(path, []);
        const seen = new Set(prev.map((e) => e.join('|')));
        writeFileSync(path, JSON.stringify([...prev, ...list.filter((e) => !seen.has(e.join('|')))]));
      }
      done.add(date);
      console.log(`重大訊息 ${date}：${rows.length} 則，特殊事件 ${n} 則`);
    } catch (e) {
      console.log(`${e}`);
    }
    await sleep(5000);
  }
  writeFileSync(donePath, JSON.stringify([...done].sort()));
}

/** START 以後到昨天的平日，由新到舊。 */
function weekdaysSince(start: string): string[] {
  const out: string[] = [];
  const now = new Date(Date.now() + 8 * 3600_000);
  for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)); iso(d) >= start; d.setUTCDate(d.getUTCDate() - 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(iso(d));
  }
  return out;
}

// ------------------------------------------------------------ 每日本益比、殖利率、淨值比

async function ratioHistory(dir: string): Promise<void> {
  const rDir = join(dir, 'ratios');
  mkdirSync(rDir, { recursive: true });
  const holidays = new Set(readJson<{ holidays?: string[] }>(join(dir, 'candles-meta.json'), {}).holidays ?? []);
  const emptyPath = join(dir, 'ratios-empty.json');
  const empty = new Set(readJson<string[]>(emptyPath, []));
  const todo = weekdaysSince(START).filter((d) => !holidays.has(d) && !empty.has(d) && !existsSync(join(rDir, `${d}.json`)));
  console.log(`每日本益比：還缺 ${todo.length} 天，這次最多 ${RATIO_MAX} 天`);
  let n = 0;
  for (const date of todo.slice(0, RATIO_MAX)) {
    try {
      const r = await ratiosOn(date);
      if (r && Object.keys(r).length > 500) {
        writeFileSync(join(rDir, `${date}.json`), JSON.stringify(r));
        n++;
      } else if (!r) empty.add(date);
    } catch (e) {
      console.log(`每日本益比 ${date} ✗ ${e}`);
    }
    await sleep(2500);
  }
  writeFileSync(emptyPath, JSON.stringify([...empty].sort()));
  console.log(`每日本益比：這次補 ${n} 天`);
}

const dir = process.argv[2] ?? 'data';
mkdirSync(dir, { recursive: true });
await peHistory(dir);
await ratioHistory(dir);
await eventHistory(dir);
await tdccHistory(dir);
