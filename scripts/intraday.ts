/**
 * 加權指數 5 分 K（GitHub Actions 執行，證交所組）：
 *
 *   node scripts/intraday.ts <資料資料夾>
 *
 * 證交所「每 5 秒指數統計」（MI_5MINS_INDEX），每個交易日一次請求，存在 intraday/<日期>.json（格式見 lib/intraday.ts）。
 * 從最新往回補到 2020 年；每次最多 INTRADAY_MAX 天，沒有資料的日子記在 intraday-empty.json。
 * 給「預測」頁的 00631L 5 分 K 走勢預測用。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTRADAY_VERSION, parseMi5Index } from './lib/intraday.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const START = process.env.ARCHIVE_START ?? '2020-01-01';
const MAX = Number(process.env.INTRADAY_MAX ?? 300);
const GAP_MS = 3000;
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};

const dir = process.argv[2] ?? 'data';
const out = join(dir, 'intraday');
mkdirSync(out, { recursive: true });
const emptyPath = join(dir, 'intraday-empty.json');
const empty = new Set(readJson<string[]>(emptyPath, []));
const have = new Set(readdirSync(out).filter((f) => readJson<{ v?: number }>(join(out, f), {}).v === INTRADAY_VERSION).map((f) => f.slice(0, 10)));
// 交易日：用加權指數日 K 的日期（假日不會出現）；今天收盤後（台北 14:30 以後）才抓今天
const ix = readJson<Array<[string]>>(join(dir, 'index', 'TAIEX.json'), []).map((r) => r[0]);
const now = new Date(Date.now() + 8 * 3600_000);
const today = now.toISOString().slice(0, 10);
const days = ix.filter((d) => d >= START && (d < today || now.getUTCHours() * 60 + now.getUTCMinutes() >= 14 * 60 + 30));
const todo = days.filter((d) => !have.has(d) && !empty.has(d)).reverse();
console.log(`5 分 K：${days.length} 個交易日，缺 ${todo.length} 天，這次最多 ${MAX} 天`);

let ok = 0;
for (const d of todo.slice(0, MAX)) {
  if (Date.now() > DEADLINE) break;
  let j: unknown = null;
  for (let i = 0; i < 3 && j == null; i++) {
    try {
      const res = await fetch(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX?date=${d.replace(/-/g, '')}&response=json`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      j = await res.json();
    } catch (e) {
      console.log(`  ${d} 第 ${i + 1} 次 ✗ ${e}`);
      await sleep(4000 * (i + 1));
    }
  }
  if (j != null) {
    const day = parseMi5Index(j);
    if (day) {
      writeFileSync(join(out, `${d}.json`), JSON.stringify(day));
      ok++;
      if (ok <= 3 || ok % 50 === 0) console.log(`  ${d}：開 ${day.ix[0][0]}、收 ${day.ix[53][3]}`);
    } else {
      empty.add(d);
      console.log(`  ${d}：沒有資料 ${JSON.stringify(j).slice(0, 120)}`);
    }
  }
  await sleep(GAP_MS);
}
writeFileSync(emptyPath, JSON.stringify([...empty].sort()));
console.log(`5 分 K：這次存了 ${ok} 天`);
