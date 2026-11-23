/**
 * CBOE 選擇權 Put/Call 比例（每日）：全市場（Total）、個股（Equity）、指數（Index）。
 *
 *   node scripts/cboe-pc.ts <資料資料夾>
 *
 * 來源：CBOE 每日市場統計（cdn.cboe.com 的 daily_options，免金鑰、一天一個檔）。
 * 存 us/PCR.json：{ "YYYY-MM-DD": [total, equity, index] }（美國當地日期；抓不到的欄位是 null）。
 * - 每次先補最近的日子，再往回補到 2020 年；每次最多 PCR_MAX 次請求（預設 250，間隔 0.4 秒）。
 * - 非交易日（週末、美國假日）回傳 404 或沒有比例：記成 null，之後不再重抓。
 * - 連續 15 次都抓不到任何比例（網址或格式變了）就停，並把回應的開頭印出來方便修。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const file = join(dir, 'us', 'PCR.json');
mkdirSync(join(dir, 'us'), { recursive: true });
const MAX = Number(process.env.PCR_MAX ?? 250);
const START = process.env.PCR_START ?? '2020-01-02';
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Rec = [number | null, number | null, number | null] | null;
let have: Record<string, Rec> = {};
try {
  have = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Rec>;
} catch {
  have = {};
}

/** 從 CBOE 的 JSON（或 HTML）裡找出 Put/Call 比例，不依賴固定欄位位置。 */
export function parsePcr(text: string): [number | null, number | null, number | null] | null {
  const pick = (re: RegExp) => {
    const m = text.match(re);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 && v < 10 ? v : null;
  };
  const t = pick(/TOTAL\s+PUT\s*\/\s*CALL\s+RATIO[^\d]{0,80}?(\d+\.\d+)/i);
  const e = pick(/EQUITY\s+PUT\s*\/\s*CALL\s+RATIO[^\d]{0,80}?(\d+\.\d+)/i);
  const i = pick(/INDEX\s+PUT\s*\/\s*CALL\s+RATIO[^\d]{0,80}?(\d+\.\d+)/i);
  return t == null && e == null && i == null ? null : [t, e, i];
}

// 要抓的日子：平日、還沒抓過的；最近的先
const today = new Date(Date.now() - 5 * 3600_000); // 美東時間大約
const days: string[] = [];
for (let d = new Date(today.toISOString().slice(0, 10) + 'T00:00:00Z'); d.toISOString().slice(0, 10) >= START; d.setUTCDate(d.getUTCDate() - 1)) {
  const w = d.getUTCDay();
  const s = d.toISOString().slice(0, 10);
  if (w === 0 || w === 6 || s in have) continue;
  days.push(s);
}
// 今天（美東）還沒收盤：最新一天先不記 null（可能只是還沒公布）
let used = 0;
let got = 0;
let miss = 0;
let streak = 0;
for (const d of days) {
  if (used >= MAX || Date.now() > DEADLINE) break;
  used++;
  await sleep(400);
  let status = 0;
  let body = '';
  try {
    const res = await fetch(`https://cdn.cboe.com/data/us/options/market_statistics/daily/${d}_daily_options`, { headers: { 'User-Agent': UA, Accept: 'application/json,text/html' }, signal: AbortSignal.timeout(30_000) });
    status = res.status;
    body = await res.text();
  } catch (e) {
    body = String(e);
  }
  const r = status === 200 ? parsePcr(body) : null;
  if (r) {
    have[d] = r;
    got++;
    streak = 0;
  } else {
    streak++;
    // 404／沒有比例：非交易日；最近 3 天可能只是還沒公布，不記
    const recent = Date.parse(d) > Date.now() - 3 * 86400_000;
    if (!recent && (status === 404 || status === 403 || status === 200)) (have[d] = null), miss++;
    if (streak >= 15) {
      console.log(`CBOE Put/Call：連續 ${streak} 次抓不到（最後 ${d} HTTP ${status}）：${body.slice(0, 300).replace(/\s+/g, ' ')}`);
      break;
    }
  }
}
writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(have).sort(([a], [b]) => a.localeCompare(b)))));
const ok = Object.values(have).filter((v) => v).length;
const dates = Object.keys(have).filter((k) => have[k]).sort();
console.log(`CBOE Put/Call：這次請求 ${used} 次，新增 ${got} 天、非交易日 ${miss} 天；共 ${ok} 天（${dates[0] ?? '—'}～${dates.at(-1) ?? '—'}）`);
