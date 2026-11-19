/**
 * 臺股期貨（TX）近月的一般時段與夜盤日 K（GitHub Actions 執行，期交所組）：
 *
 *   node scripts/taifex-daily.ts <資料資料夾>
 *
 * 期交所「期貨每日交易行情」下載（每月一次請求），存在 txdaily/<YYYY-MM>.json：{ 日期: { d: 一般時段, n: 夜盤 } }。
 * 夜盤在美股交易時段開著，結束（台北 05:00）時已經反映前一晚美股，是開盤前最直接的資訊。
 * 這個月與上個月每次重抓；更早的抓過就不再抓；抓不到（太久以前沒開放）的月份記在 txdaily-empty.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTxDaily } from './lib/taifexDaily.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const START = (process.env.ARCHIVE_START ?? '2020-01-01').slice(0, 7);
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const dir = process.argv[2] ?? 'data';
const out = join(dir, 'txdaily');
mkdirSync(out, { recursive: true });
const emptyPath = join(dir, 'txdaily-empty.json');
let empty: string[] = [];
try {
  empty = JSON.parse(readFileSync(emptyPath, 'utf8')) as string[];
} catch {
  /* 第一次 */
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const tw = new Date(Date.now() + 8 * 3600_000);
const today = tw.toISOString().slice(0, 10);
const months: string[] = [];
for (let m = today.slice(0, 7); m >= START; m = shiftMonth(m, -1)) months.push(m);
const todo = months.filter((m, i) => i < 2 || (!existsSync(join(out, `${m}.json`)) && !empty.includes(m)));
console.log(`臺指期日 K：${months.length} 個月，這次抓 ${todo.length} 個月`);
for (const m of todo) {
  if (Date.now() > DEADLINE) break;
  const [y, mo] = m.split('-').map(Number);
  const monthEnd = `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
  const end = monthEnd > today ? today : monthEnd;
  const body = new URLSearchParams({ down_type: '1', commodity_id: 'TX', commodity_id2: '', queryStartDate: `${m.replace('-', '/')}/01`, queryEndDate: end.replace(/-/g, '/') });
  try {
    const res = await fetch('https://www.taifex.com.tw/cht/3/futDataDown', {
      method: 'POST',
      body,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = new TextDecoder('big5').decode(await res.arrayBuffer());
    let days: ReturnType<typeof parseTxDaily> = {};
    try {
      days = parseTxDaily(csv);
    } catch (e) {
      console.log(`  ${m}：${e}｜${csv.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    const n = Object.keys(days).length;
    if (n) {
      writeFileSync(join(out, `${m}.json`), JSON.stringify(days));
      const last = Object.keys(days).sort().at(-1)!;
      console.log(`  ${m}：${n} 天（${last}：一般 ${days[last].d?.[3] ?? '—'}、夜盤 ${days[last].n?.[3] ?? '—'}）`);
    } else {
      if (months.indexOf(m) >= 2) empty.push(m);
      console.log(`  ${m}：沒有資料 ${csv.slice(0, 100).replace(/\s+/g, ' ')}`);
    }
  } catch (e) {
    console.log(`  ${m} ✗ ${e}`);
  }
  await sleep(3000);
}
writeFileSync(emptyPath, JSON.stringify([...new Set(empty)].sort()));
