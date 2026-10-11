/**
 * 「收盤資料」模式用的最近一個交易日行情（部署網站時執行，不連網）。
 *
 *   node scripts/close-snapshot.ts <資料資料夾>
 *
 * 由 candles/<代號>.json、index/TAIEX.json、stocks.json 整理出 close.json：
 *   {
 *     date, prevDate,
 *     index: [開, 高, 低, 收, 昨收],
 *     total: 上市成交額（億元）,
 *     rows: { 代號: [開, 高, 低, 收, 張, 昨收, 成交額（億元）, 近 20 日平均成交額（億元）] }
 *   }
 * 成交額：stocks.json（證交所／櫃買公布的成交金額）有當天資料就用，沒有就用「張 × 均價」估計；
 * 20 日均額用同樣的估計方式，再依當天「公布值 ÷ 估計值」校正，兩者的口徑才一致。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = [string, number, number, number, number, number];

const dir = process.argv[2] ?? 'data';
const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
/** 估計成交額（億元）：張 × 1000 股 × 均價。 */
const estimate = (r: Row) => (r[5] * 1000 * ((r[1] + r[2] + r[3] + r[4]) / 4)) / 1e8;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const candleDir = join(dir, 'candles');
if (!existsSync(candleDir)) {
  console.log('沒有 candles，略過');
  process.exit(0);
}
const taiex = readJson<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []);
const directory = readJson<{ asOf?: string; stocks?: Array<{ code: string; market?: string; turnover?: number }> }>(join(dir, 'stocks.json'), {});
const official = new Map((directory.stocks ?? []).map((s) => [s.code, s]));

// 最近一個交易日：以 0050 與加權指數最後一天較新的為準
const cal = readJson<Row[]>(join(candleDir, '0050.json'), []);
const date = [cal.at(-1)?.[0], taiex.at(-1)?.[0]].filter(Boolean).sort().at(-1);
if (!date) {
  console.log('找不到最近交易日，略過');
  process.exit(0);
}

const rows: Record<string, number[]> = {};
let total = 0;
let prevDate = '';
for (const f of readdirSync(candleDir).filter((x) => x.endsWith('.json'))) {
  const code = f.slice(0, -5);
  const list = readJson<Row[]>(join(candleDir, f), []);
  const i = list.length - 1;
  if (i < 1 || list[i][0] !== date) continue;
  const today = list[i];
  const prev = list[i - 1];
  if (!prevDate || prev[0] > prevDate) prevDate = prev[0];
  const off = official.get(code);
  const est = estimate(today);
  const real = directory.asOf === date && off?.turnover != null ? off.turnover : undefined;
  const turnover = real ?? est;
  const past = list.slice(Math.max(0, i - 20), i);
  const avgEst = past.length ? past.reduce((a, r) => a + estimate(r), 0) / past.length : est;
  const avg20 = real != null && est > 0 ? avgEst * (real / est) : avgEst;
  rows[code] = [today[1], today[2], today[3], today[4], today[5], prev[4], round(turnover, 3), round(avg20, 3)];
  if (off?.market !== 'otc') total += turnover;
}

const t = taiex.findIndex((r) => r[0] === date);
const index = t > 0 ? [taiex[t][1], taiex[t][2], taiex[t][3], taiex[t][4], taiex[t - 1][4]] : null;
writeFileSync(join(dir, 'close.json'), JSON.stringify({ date, prevDate, index, total: round(total, 1), rows }));
console.log(`close.json：${date}，${Object.keys(rows).length} 檔，上市成交額 ${round(total, 0)} 億`);
