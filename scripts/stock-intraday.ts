/**
 * 個股 1 分 K（富果行情 API，GitHub Actions 執行；金鑰放在 GitHub Secret FUGLE_API_KEY，不進程式碼、不進資料）：
 *
 *   FUGLE_API_KEY=… STOCK1M_OUT=<私人儲存庫資料夾> node scripts/stock-intraday.ts <資料資料夾>
 *
 * 富果的資料不能公開轉載：只存進「私人儲存庫」（STOCK1M_OUT），絕不存進公開的 data 分支；沒有設 STOCK1M_OUT 就不收。
 * - 對象：00631L、0050、近 20 日成交額最大的 STOCK1M_TOP 檔、營收選股目前的名單（約 70 檔）。
 * - 過去的日子：先試富果「歷史 K 線」的 1 分 K（timeframe=1）往回補；富果不給的話就只收當天。
 * - 當天：收盤後（台北 13:35 以後）用「盤中 K 線」收當天的 1 分 K。
 * - 存 stock1m/<日期>.json：{ 代號: [基準價, 開[], 高[], 低[], 收[], 量[]] }，價格存成相對基準價的萬分之幾（整數），
 *   一天約 70 檔 × 5KB；3 分、5 分 K 由 1 分 K 合成。
 * - 富果免費方案每分鐘約 60 次請求：每次請求間隔 STOCK1M_GAP_MS（約 55 次／分），每輪最多 STOCK1M_MAX 次（約 36 分鐘，受 DEADLINE 限制）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const KEY = process.env.FUGLE_API_KEY ?? '';
const TOP = Number(process.env.STOCK1M_TOP ?? 50);
const MAX = Number(process.env.STOCK1M_MAX ?? 2000);
const GAP = Number(process.env.STOCK1M_GAP_MS ?? 1100);
const START = process.env.STOCK1M_START ?? '2024-01-01';
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const BASE = 'https://api.fugle.tw/marketdata/v1.0/stock';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};

const OUT = process.env.STOCK1M_OUT ?? '';
if (!OUT) {
  console.log('個股 1 分 K：沒有私人儲存庫（STOCK1M_OUT），富果資料不能存在公開的 data 分支，略過');
  process.exit(0);
}
if (!KEY) {
  console.log('個股 1 分 K：沒有 FUGLE_API_KEY（請在 GitHub 儲存庫 Settings → Secrets → Actions 新增），略過');
  process.exit(0);
}

// ---------------------------------------------------------------- 對象
const cal = read<Array<[string]>>(join(dir, 'index', 'TAIEX.json'), []).map((r) => r[0]);
const turn: Array<[string, number]> = [];
for (const f of readdirSync(join(dir, 'candles')).filter((f) => /^[1-9]\d{3}\.json$/.test(f))) {
  const rows = read<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', f), []).slice(-20);
  if (rows.length < 20) continue;
  turn.push([f.slice(0, 4), rows.reduce((s, r) => s + r[5] * r[4], 0) / 20]);
}
const rev = read<{ revStocks?: { top?: Array<{ code: string }> } }>(join(dir, 'predict.json'), {}).revStocks?.top?.map((x) => x.code) ?? [];
const codes = [...new Set(['00631L', '0050', ...turn.sort((a, b) => b[1] - a[1]).slice(0, TOP).map((x) => x[0]), ...rev])];

// ---------------------------------------------------------------- 存檔格式
type Day = Record<string, [number, number[], number[], number[], number[], number[]]>;
const out = join(OUT, 'stock1m');
mkdirSync(out, { recursive: true });
const fileOf = (d: string) => join(out, `${d}.json`);
const loadDay = (d: string): Day => read<Day>(fileOf(d), {});
/** 富果 K 線（時間、開高低收量）→ 270 根 1 分 K（09:01～13:30，缺的用前一根補），存成相對基準價的萬分之幾。 */
function encode(rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>): Day[string] | null {
  const bars: Array<[number, number, number, number, number] | null> = new Array(270).fill(null);
  for (const r of rows) {
    const m = r.date.match(/T(\d{2}):(\d{2})/);
    if (!m) continue;
    // 富果的 1 分 K 時間是那一分鐘的開始（09:00 那根涵蓋 09:00～09:01）
    const b = (Number(m[1]) - 9) * 60 + Number(m[2]);
    if (b < 0 || b >= 270) continue;
    bars[b] = [r.open, r.high, r.low, r.close, r.volume ?? 0];
  }
  const first = bars.find((x) => x);
  if (!first) return null;
  let last = first[0];
  const base = first[0];
  const enc = (p: number) => Math.round((p / base - 1) * 1e4);
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  for (const x of bars) {
    const [a, hi, lo, cl, vol] = x ?? [last, last, last, last, 0];
    o.push(enc(a));
    h.push(enc(hi));
    l.push(enc(lo));
    c.push(enc(cl));
    v.push(Math.round(vol));
    last = cl;
  }
  return [base, o, h, l, c, v];
}

// ---------------------------------------------------------------- 請求
let used = 0;
async function get(path: string): Promise<{ status: number; body: any }> {
  used++;
  await sleep(GAP);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-KEY': KEY }, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => null);
    if (res.status === 429) await sleep(60_000);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}
const canGo = () => used < MAX && Date.now() < DEADLINE;

// ---------------------------------------------------------------- 當天（收盤後）
const now = new Date(Date.now() + 8 * 3600_000);
const today = now.toISOString().slice(0, 10);
const afterClose = now.getUTCHours() * 60 + now.getUTCMinutes() >= 13 * 60 + 35;
const isTradingToday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
let savedToday = 0;
if (afterClose && isTradingToday) {
  const day = loadDay(today);
  for (const code of codes) {
    if (day[code] || !canGo()) continue;
    const r = await get(`/intraday/candles/${code}?timeframe=1`);
    const rows = r.body?.data;
    if (r.status === 200 && Array.isArray(rows) && rows.length) {
      const e = encode(rows);
      if (e) (day[code] = e), savedToday++;
    } else if (r.status !== 200) console.log(`  當天 ${code} ✗ ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  if (savedToday) writeFileSync(fileOf(today), JSON.stringify(day));
}

// ---------------------------------------------------------------- 過去：試歷史 1 分 K
let histOk: boolean | null = null;
let savedPast = 0;
const past = cal.filter((d) => d >= START && d < today).reverse();
for (const d of past) {
  if (!canGo() || histOk === false) break;
  const day = loadDay(d);
  const todo = codes.filter((c) => !day[c]);
  if (!todo.length) continue;
  let changed = false;
  for (const code of todo) {
    if (!canGo()) break;
    const r = await get(`/historical/candles/${code}?from=${d}&to=${d}&timeframe=1&fields=open,high,low,close,volume`);
    const rows = r.body?.data;
    if (r.status === 200 && Array.isArray(rows) && rows.length && /T\d{2}:\d{2}/.test(rows[0].date ?? '')) {
      const e = encode(rows);
      if (e) (day[code] = e), (changed = true), savedPast++;
      histOk = true;
    } else if (histOk === null) {
      // 第一次就不行：富果不提供（或這個方案不提供）歷史盤中 K 線
      histOk = false;
      console.log(`  歷史 1 分 K 不可用（${r.status}）：${JSON.stringify(r.body).slice(0, 200)}；之後只收當天`);
      break;
    }
  }
  if (changed) writeFileSync(fileOf(d), JSON.stringify(day));
}
const files = readdirSync(out).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
console.log(`個股 1 分 K：${codes.length} 檔；當天存 ${savedToday} 檔、過去補 ${savedPast} 檔日；請求 ${used} 次；歷史 1 分 K ${histOk == null ? '沒試' : histOk ? '可用' : '不可用'}；共 ${files.length} 天`);
if (existsSync(fileOf(today))) console.log(`  今天 ${Object.keys(loadDay(today)).length} 檔`);
