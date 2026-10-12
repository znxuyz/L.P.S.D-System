/**
 * 模擬盤用的「每天全市場行情」：由 candles/<代號>.json 重新整理成每月一個檔案，
 * 讓網頁一次拿到某一天所有股票的開高低收（排行榜、偽即時行情用）。
 *
 *   node scripts/sim-daily.ts <資料資料夾>
 *
 * 輸出 simday/<YYYY-MM>.json：
 *   { codes: [代號…], days: { "2025-07-25": [[開, 高, 低, 收, 張, 昨收] 或 0（當天沒成交）, …] } }
 * 不連網，幾秒鐘就跑完。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSplits } from '../web/src/domain/splits.ts';

type Row = [string, number, number, number, number, number];

const dir = process.argv[2] ?? 'data';
const files = readdirSync(join(dir, 'candles')).filter((f) => f.endsWith('.json')).sort();
const codes = files.map((f) => f.slice(0, -5));
/** 月份 → 日期 → 每檔一列 */
const months = new Map<string, Map<string, Array<number[] | 0>>>();

// 除權息的日子（分割判斷要排除）
const exDays = new Map<string, Set<string>>();
const exDir = join(dir, 'exrights');
if (existsSync(exDir))
  for (const f of readdirSync(exDir).filter((f) => /^\d{4}\.json$/.test(f)))
    for (const r of JSON.parse(readFileSync(join(exDir, f), 'utf8')) as Array<[string, string]>) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);

codes.forEach((code, ci) => {
  const rows = JSON.parse(readFileSync(join(dir, 'candles', `${code}.json`), 'utf8')) as Row[];
  // 股票分割、減資那天的「昨收」換算成新的基準，排行榜的漲跌幅才不會顯示 -75%
  const splitOn = new Map(detectSplits(rows.map(([date, o, , , c]) => ({ date, open: o, close: c })), exDays.get(code)));
  let prev = 0;
  for (const [date, o, h, l, c, v] of rows) {
    const k = splitOn.get(date);
    if (k && prev) prev = Math.round((prev / k) * 100) / 100;
    const m = date.slice(0, 7);
    let days = months.get(m);
    if (!days) months.set(m, (days = new Map()));
    let day = days.get(date);
    if (!day) days.set(date, (day = new Array(codes.length).fill(0)));
    day[ci] = [o, h, l, c, v, prev || o];
    prev = c;
  }
});

const out = join(dir, 'simday');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let bytes = 0;
for (const [m, days] of [...months].sort()) {
  const sorted = Object.fromEntries([...days].sort(([a], [b]) => (a < b ? -1 : 1)));
  const text = JSON.stringify({ codes, days: sorted });
  bytes += text.length;
  writeFileSync(join(out, `${m}.json`), text);
}
console.log(`完成：${codes.length} 檔、${months.size} 個月，共 ${(bytes / 1e6).toFixed(1)} MB`);
