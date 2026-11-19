/**
 * 上市櫃公司每月營收（公開資訊觀測站 t21sc03），2019 年起，存 revenue/<YYYY-MM>.json：{ 代號: [當月營收, 去年當月營收] }（千元）。
 *
 *   node scripts/revenue.ts <資料資料夾>
 *
 * 月營收是台股最早、最直接的第一手獲利資料（每月 10 日前公告，比季報早 1～2 個月）。
 * - 上市（sii）與上櫃（otc），本國（_0）與外國企業（_1）各一份。
 * - 過去的月份抓過就不再抓；最近兩個月每次重抓（有公司晚公告、更正）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeHtml, parseRevenueHtml, type RevenueMonth } from './lib/revenueParse.ts';

const dir = process.argv[2] ?? 'data';
const out = join(dir, 'revenue');
mkdirSync(out, { recursive: true });
const START = process.env.REVENUE_START ?? '2019-01';
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = decodeHtml(await res.arrayBuffer(), res.headers.get('content-type') ?? '');
      if (html.includes('FOR SECURITY REASONS') || html.includes('查詢過於頻繁')) throw new Error('被擋下');
      return html;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(5000 * (i + 1));
    }
  }
  return null;
}

// 已經有完整資料的最後一個月：上個月（10 日以前可能還沒公告完，照樣抓，之後會重抓）
const now = new Date(Date.now() + 8 * 3600_000);
const months: string[] = [];
for (let d = new Date(`${START}-01T00:00:00Z`); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
  const ym = d.toISOString().slice(0, 7);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (ym > last) break;
  months.push(ym);
}
const recent = new Set(months.slice(-2));
let done = 0;
let fail = 0;
for (const ym of months.reverse()) {
  const file = join(out, `${ym}.json`);
  if (existsSync(file) && !recent.has(ym)) continue;
  if (Date.now() > DEADLINE) break;
  const [y, m] = ym.split('-').map(Number);
  const roc = y - 1911;
  const all: RevenueMonth = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let got = 0;
  try {
    for (const mk of ['sii', 'otc'])
      for (const kind of [0, 1]) {
        const html = await get(`https://mopsov.twse.com.tw/nas/t21/${mk}/t21sc03_${roc}_${m}_${kind}.html`);
        if (html) {
          const t = parseRevenueHtml(html);
          Object.assign(all, t);
          got += Object.keys(t).length;
        }
        await sleep(1500);
      }
  } catch (e) {
    fail++;
    console.log(`  ${ym} ✗ ${e}`);
    if (fail >= 3) break;
    continue;
  }
  if (got > 100) {
    writeFileSync(file, JSON.stringify(all));
    done++;
    console.log(`  ${ym} ✓ ${got} 家`);
  } else console.log(`  ${ym} 只有 ${got} 家，先不存`);
}
console.log(`月營收：這次更新 ${done} 個月，失敗 ${fail}`);
