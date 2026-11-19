/**
 * 美股每日收盤（GitHub Actions 執行）：
 *
 *   node scripts/us-market.ts <資料資料夾>
 *
 * 費城半導體（SOX）、那斯達克（IXIC）、S&P 500（GSPC）、台積電 ADR（TSM）、VIX，2020 年起的日 K。
 * 台股開盤（台北 09:00）前美股已經收盤（台北約 04:00～05:00），所以「前一個美股交易日」的漲跌是開盤前就知道的資訊。
 * 來源：Yahoo Finance chart API，失敗時改用 Stooq CSV；兩個都免費、不需要金鑰。每次重抓全部（資料量小）。
 * 輸出 us/<代號>.json：[[日期, 開, 高, 低, 收], …]（美國當地日期）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const dir = process.argv[2] ?? 'data';
const out = join(dir, 'us');
mkdirSync(out, { recursive: true });
const START = Date.parse('2019-12-01T00:00:00Z') / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 我們的代號 → [Yahoo 代號, Stooq 代號] */
const SYMBOLS: Record<string, [string, string]> = {
  SOX: ['^SOX', '^sox'],
  IXIC: ['^IXIC', '^ndq'],
  GSPC: ['^GSPC', '^spx'],
  TSM: ['TSM', 'tsm.us'],
  VIX: ['^VIX', '^vix'],
};
type Row = [string, number, number, number, number];
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

async function yahoo(sym: string): Promise<Row[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${START}&period2=${Math.floor(Date.now() / 1000)}&interval=1d&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = (await res.json()) as { chart?: { result?: Array<{ meta: { gmtoffset: number }; timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[] }> } }> } };
  const r = j.chart?.result?.[0];
  if (!r?.timestamp?.length) throw new Error('Yahoo 沒有資料');
  const q = r.indicators.quote[0];
  const rows: Row[] = [];
  r.timestamp.forEach((t, i) => {
    const c = q.close[i];
    if (!(c > 0)) return;
    const date = new Date((t + r.meta.gmtoffset) * 1000).toISOString().slice(0, 10);
    rows.push([date, r4(q.open[i] || c), r4(q.high[i] || c), r4(q.low[i] || c), r4(c)]);
  });
  return rows;
}

async function stooq(sym: string): Promise<Row[]> {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=20191201&i=d`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const text = await res.text();
  const rows: Row[] = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, o, h, l, c] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(Number(c) > 0)) continue;
    rows.push([d, r4(Number(o)), r4(Number(h)), r4(Number(l)), r4(Number(c))]);
  }
  if (!rows.length) throw new Error(`Stooq 沒有資料：${text.slice(0, 80)}`);
  return rows;
}

for (const [name, [ySym, sSym]] of Object.entries(SYMBOLS)) {
  let rows: Row[] = [];
  let src = '';
  for (const [label, fn] of [
    ['Yahoo', () => yahoo(ySym)],
    ['Stooq', () => stooq(sSym)],
  ] as const) {
    try {
      rows = await fn();
      src = label;
      break;
    } catch (e) {
      console.log(`  ${name} ${label} ✗ ${e}`);
    }
    await sleep(1500);
  }
  if (!rows.length) {
    console.log(`${name}：兩個來源都失敗，保留舊資料`);
    continue;
  }
  // 跟舊資料合併（來源偶爾少幾天）
  let old: Row[] = [];
  try {
    old = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8')) as Row[];
  } catch {
    /* 第一次 */
  }
  const byDate = new Map(old.map((r) => [r[0], r]));
  for (const r of rows) byDate.set(r[0], r);
  const merged = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  writeFileSync(join(out, `${name}.json`), JSON.stringify(merged));
  console.log(`${name}：${src} ${rows.length} 天（${merged[0][0]} ～ ${merged.at(-1)![0]}，收 ${merged.at(-1)![4]}）`);
  await sleep(1500);
}
