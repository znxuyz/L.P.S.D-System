/**
 * 大盤風險指標（GitHub Actions 執行）：
 *
 *   PART=margin  node scripts/market-risk.ts <資料資料夾>   證交所（跟其他證交所程式同一組）
 *   PART=futures node scripts/market-risk.ts <資料資料夾>   期交所（自己一組）
 *   PART=build   node scripts/market-risk.ts <資料資料夾>   不連網，只整理輸出
 *
 * - 上市融資維持率：證交所「融資融券餘額」（MI_MARGN），每個交易日一次請求，存在 margin/<日期>.json。
 *   維持率 ≈ Σ（每檔融資餘額張數 × 1000 × 收盤價）÷ 融資餘額金額。大盤低於約 140% 常出現斷頭賣壓（個股 130% 追繳）。
 *   也存融資、融券餘額（張），算券資比。
 * - 外資台指期淨未平倉：期交所「三大法人－期貨契約」CSV（Big5），每月一次請求，存在 futures/<YYYY-MM>.json。
 *   臺股期貨（大台）＋小型臺指（小台 ÷ 4）折合大台口數；負數是淨空單。
 * - 輸出 market-risk.json：{ asOf, rows: [[日期, 維持率, 融資餘額(億), 融資張數, 融券張數, 外資淨未平倉(口)]] }。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFutures, parseMargin, type MarginDay } from './lib/marketRisk.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const START = process.env.ARCHIVE_START ?? '2020-01-01';
const MARGIN_MAX = Number(process.env.MARGIN_MAX ?? 60);
const GAP_MS = 3000;
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);
const timeUp = () => Date.now() > DEADLINE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json, text/csv, */*', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      await sleep(4000 * (i + 1));
    }
  }
  throw new Error(`${url} → ${last}`);
}

// ---------------------------------------------------------------- 融資融券

async function updateMargin(dir: string): Promise<void> {
  const out = join(dir, 'margin');
  mkdirSync(out, { recursive: true });
  const emptyPath = join(dir, 'margin-empty.json');
  const empty = new Set(readJson<string[]>(emptyPath, []));
  const holidays = new Set(readJson<{ holidays?: string[] }>(join(dir, 'candles-meta.json'), {}).holidays ?? []);
  const now = new Date(Date.now() + 8 * 3600_000);
  const have = new Set(readdirSync(out).map((f) => f.slice(0, 10)));
  const todo: string[] = [];
  for (let d = now.getUTCHours() >= 21 ? now.toISOString().slice(0, 10) : shift(now.toISOString().slice(0, 10), -1); d >= START; d = shift(d, -1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd && wd !== 6 && !holidays.has(d) && !have.has(d) && !empty.has(d)) todo.push(d);
  }
  console.log(`融資融券：缺 ${todo.length} 天，這次最多 ${MARGIN_MAX} 天`);
  for (const d of todo.slice(0, MARGIN_MAX)) {
    if (timeUp()) break;
    try {
      const j = await (await get(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d.replace(/-/g, '')}&selectType=ALL&response=json`)).json();
      const m = parseMargin(j);
      if (m) {
        writeFileSync(join(out, `${d}.json`), JSON.stringify(m));
        console.log(`  ${d}：融資 ${Math.round(m.finAmt / 1e5).toLocaleString()} 億、${Object.keys(m.perStock).length} 檔`);
      } else {
        empty.add(d);
        console.log(`  ${d}：沒有資料`);
      }
    } catch (e) {
      console.log(`  ${d} ✗ ${e}`);
    }
    await sleep(GAP_MS);
  }
  writeFileSync(emptyPath, JSON.stringify([...empty].sort()));
}

// ---------------------------------------------------------------- 期貨

async function updateFutures(dir: string): Promise<void> {
  const out = join(dir, 'futures');
  mkdirSync(out, { recursive: true });
  const months: string[] = [];
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  for (let m = now; m >= START.slice(0, 7); m = shift(`${m}-01`, -1).slice(0, 7)) months.push(m);
  // 這個月與上個月每次重抓；更早的抓過就不再抓
  const todo = months.filter((m, i) => i < 2 || !existsSync(join(out, `${m}.json`)));
  console.log(`期貨：${months.length} 個月，這次抓 ${todo.length} 個月`);
  for (const m of todo) {
    if (timeUp()) break;
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const body = new URLSearchParams({ queryStartDate: `${y}/${String(mo).padStart(2, '0')}/01`, queryEndDate: `${y}/${String(mo).padStart(2, '0')}/${last}` });
    try {
      const res = await get('https://www.taifex.com.tw/cht/3/futContractsDateDown', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const csv = new TextDecoder('big5').decode(await res.arrayBuffer());
      const days = parseFutures(csv);
      if (Object.keys(days).length) {
        writeFileSync(join(out, `${m}.json`), JSON.stringify(days));
        console.log(`  ${m}：${Object.keys(days).length} 天`);
      } else console.log(`  ${m}：沒有資料 ${csv.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (e) {
      console.log(`  ${m} ✗ ${e}`);
    }
    await sleep(GAP_MS);
  }
}

// ---------------------------------------------------------------- 輸出

function build(dir: string): void {
  const marginDir = join(dir, 'margin');
  const days = existsSync(marginDir) ? readdirSync(marginDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  const fut: Record<string, number> = {};
  const futDir = join(dir, 'futures');
  if (existsSync(futDir)) for (const f of readdirSync(futDir)) Object.assign(fut, readJson<Record<string, number>>(join(futDir, f), {}));
  // 收盤價：只讀有融資的股票的日 K
  const closeOf = new Map<string, Map<string, number>>();
  const close = (code: string, d: string) => {
    let m = closeOf.get(code);
    if (!m) {
      const rows = readJson<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', `${code}.json`), []);
      closeOf.set(code, (m = new Map(rows.map((r) => [r[0], r[4]]))));
    }
    return m.get(d);
  };
  const rows: Array<[string, number | null, number, number, number, number | null]> = [];
  const dates = [...new Set([...days, ...Object.keys(fut)])].sort();
  const marginSet = new Set(days);
  for (const d of dates) {
    let ratio: number | null = null;
    let finAmt = 0;
    let finLots = 0;
    let shortLots = 0;
    if (marginSet.has(d)) {
      const m = readJson<MarginDay | null>(join(marginDir, `${d}.json`), null);
      if (m) {
        let value = 0;
        let covered = 0;
        for (const [code, lots] of Object.entries(m.perStock)) {
          const c = close(code, d);
          if (c) {
            value += lots * 1000 * c;
            covered += lots;
          }
        }
        // 有收盤價的融資張數要夠多才算（避免日 K 還沒更新時算出偏低的數字）
        if (m.finAmt > 0 && covered >= m.finLots * 0.9) ratio = Math.round((value / (m.finAmt * 1000)) * 1000) / 10;
        finAmt = Math.round(m.finAmt / 1e3) / 100;
        finLots = m.finLots;
        shortLots = m.shortLots;
      }
    }
    rows.push([d, ratio, finAmt, finLots, shortLots, fut[d] ?? null]);
  }
  writeFileSync(join(dir, 'market-risk.json'), JSON.stringify({ asOf: dates.at(-1) ?? null, rows }));
  const last = rows.at(-1);
  console.log(`market-risk：${rows.length} 天，最新 ${last?.[0]} 維持率 ${last?.[1]}%、外資淨未平倉 ${last?.[5]} 口`);
}

const dir = process.argv[2] ?? 'data';
const part = process.env.PART ?? 'build';
// 抓資料的兩組同時跑（證交所、期交所），最後再由 PART=build 整理一次輸出
if (part === 'margin') await updateMargin(dir);
else if (part === 'futures') await updateFutures(dir);
else build(dir);
