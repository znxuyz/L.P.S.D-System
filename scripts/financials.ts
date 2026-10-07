/**
 * 財報、股利與重大訊息（GitHub Actions 執行），補上五大選股的第二批真實資料：
 *
 *   node scripts/financials.ts <資料資料夾>
 *
 * - EPS 年增、毛利率與營益率變化、現金流：公開資訊觀測站（海外版 mopsov）的彙總報表，
 *   最新一季與去年同季的「累計」數字相比。每季只抓一次，最新一季三天內重抓（有公司晚申報）。
 * - 連續配息年數：證交所除權息計算結果（TWT49U）、櫃買除權息結果，每年一份，過去的年份只抓一次。
 * - 特殊事件：證交所、櫃買每日重大訊息，依主旨關鍵字分類，保留 45 天。
 * - 輸出 fundamentals.json 給網頁讀。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent, parseMopsTables, type Table } from '../web/src/data/mopsParse.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const MOPS = 'https://mopsov.twse.com.tw/mops/web';
const DIV_YEARS = 11;
const EVENT_DAYS = 45;

type Market = 'sii' | 'otc';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  const n = Number(s);
  return s === '' || s === '--' || !Number.isFinite(n) ? NaN : n;
};
const wanted = (code: string) => /^\d{4}$/.test(code);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function request(url: string, init: RequestInit = {}, timeout = 150_000, tries = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.includes('FOR SECURITY REASONS') || text.includes('查詢過於頻繁')) throw new Error('被擋下（安全性或頻率限制）');
      return text;
    } catch (e) {
      last = e;
      await sleep(8000 * (i + 1));
    }
  }
  throw new Error(`${url} → ${last}`);
}

/** 公開資訊觀測站彙總報表：sb04 綜合損益、sb06 營益分析、sb20 現金流量。year 為民國年。 */
async function mopsReport(kind: 'sb04' | 'sb06' | 'sb20', market: Market, year: number, season: number): Promise<Table> {
  const body = new URLSearchParams({ encodeURIComponent: '1', step: '1', firstin: '1', off: '1', isQuery: 'Y', TYPEK: market, year: String(year), season: String(season).padStart(2, '0') });
  const html = await request(`${MOPS}/ajax_t163${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const t = parseMopsTables(html);
  if (Object.keys(t).length < 50) throw new Error(`${kind} ${market} ${year}Q${season} 只有 ${Object.keys(t).length} 檔`);
  return t;
}

/** 由證交所 OpenAPI 的營益分析判斷最新一季（民國年、季）。 */
async function latestQuarter(): Promise<[number, number]> {
  const rows = JSON.parse(await request('https://openapi.twse.com.tw/v1/opendata/t187ap17_L', {}, 60_000)) as Array<Record<string, string>>;
  const count = new Map<string, number>();
  for (const r of rows) count.set(`${r['年度']}-${r['季別']}`, (count.get(`${r['年度']}-${r['季別']}`) ?? 0) + 1);
  const [key] = [...count].sort((a, b) => b[1] - a[1])[0];
  const [y, q] = key.split('-').map(Number);
  return [y, q];
}

/** 快取：過去的季度永久保留；maxAgeDays 內不重抓。 */
async function cached(path: string, maxAgeDays: number, load: () => Promise<unknown>): Promise<any> {
  if (existsSync(path) && (maxAgeDays === Infinity || Date.now() - statSync(path).mtimeMs < maxAgeDays * 86400_000)) return readJson(path, null);
  try {
    const data = await load();
    writeFileSync(path, JSON.stringify(data));
    await sleep(5000);
    return data;
  } catch (e) {
    console.log(`  ✗ ${path}：${e}`);
    return readJson(path, null);
  }
}

const pick = (row: Record<string, string> | undefined, name: string) => {
  if (!row) return NaN;
  const key = Object.keys(row).find((k) => k.startsWith(name));
  return key ? num(row[key]) : NaN;
};

interface FinRow {
  epsYoY?: number;
  eps?: number;
  grossMargin?: number;
  grossMarginChg?: number;
  opMarginChg?: number;
  fcfPositive?: boolean;
  dividendYears?: number;
  events?: string[];
}

async function financials(dir: string, out: Record<string, FinRow>): Promise<string> {
  const finDir = join(dir, 'fin');
  mkdirSync(finDir, { recursive: true });
  const [y, q] = await latestQuarter();
  console.log(`財報：最新 ${y} 年第 ${q} 季`);
  for (const market of ['sii', 'otc'] as const) {
    const get = (kind: 'sb04' | 'sb06' | 'sb20', yy: number) =>
      cached(join(finDir, `${yy}Q${q}-${market}-${kind}.json`), yy === y ? 3 : Infinity, () => mopsReport(kind, market, yy, q));
    const [inc, incPrev, mar, marPrev, cf] = [await get('sb04', y), await get('sb04', y - 1), await get('sb06', y), await get('sb06', y - 1), await get('sb20', y)];
    let n = 0;
    for (const code of new Set([...Object.keys(inc ?? {}), ...Object.keys(mar ?? {}), ...Object.keys(cf ?? {})])) {
      const r: FinRow = (out[code] ??= {});
      const eps = pick(inc?.[code], '基本每股盈餘');
      const epsPrev = pick(incPrev?.[code], '基本每股盈餘');
      if (Number.isFinite(eps)) r.eps = eps;
      // 去年同期虧損或接近 0 時年增率沒有意義，改用差額判斷方向
      if (Number.isFinite(eps) && Number.isFinite(epsPrev)) r.epsYoY = epsPrev > 0.05 ? Math.round(((eps - epsPrev) / epsPrev) * 1000) / 10 : eps > epsPrev ? 100 : -100;
      const gm = pick(mar?.[code], '毛利率');
      const om = pick(mar?.[code], '營業利益率');
      if (Number.isFinite(gm)) r.grossMargin = gm;
      if (Number.isFinite(gm) && Number.isFinite(pick(marPrev?.[code], '毛利率'))) r.grossMarginChg = Math.round((gm - pick(marPrev?.[code], '毛利率')) * 100) / 100;
      if (Number.isFinite(om) && Number.isFinite(pick(marPrev?.[code], '營業利益率'))) r.opMarginChg = Math.round((om - pick(marPrev?.[code], '營業利益率')) * 100) / 100;
      // 自由現金流（近似）= 營業活動現金流 + 投資活動現金流
      const ocf = pick(cf?.[code], '營業活動之淨現金流入');
      const icf = pick(cf?.[code], '投資活動之淨現金流入');
      // 金融業（28 開頭）的現金流以存放款為主，這個近似沒有意義，視為不適用（通過）
      if (code.startsWith('28')) r.fcfPositive = true;
      else if (Number.isFinite(ocf) && Number.isFinite(icf)) r.fcfPositive = ocf + icf > 0;
      n++;
    }
    console.log(`  ${market}：${n} 家`);
  }
  return `${y + 1911}Q${q}`;
}

/** 某一年有配現金股利的股票。 */
async function dividendYear(year: number): Promise<string[]> {
  const set = new Set<string>();
  const tw = JSON.parse(await request(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${year}0101&endDate=${year}1231&response=json`, {}, 60_000));
  if (tw?.stat !== 'OK') throw new Error(`TWT49U ${year}：${tw?.stat}`);
  const fi = (name: string) => tw.fields.findIndex((f: string) => f.startsWith(name));
  for (const r of tw.data) if (String(r[fi('權/息')]).includes('息')) set.add(String(r[fi('股票代號')]).trim());
  await sleep(3000);
  const tp = JSON.parse(await request(`https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${year}%2F01%2F01&endDate=${year}%2F12%2F31&response=json`, {}, 60_000));
  const table = (tp?.tables ?? []).find((t: any) => Array.isArray(t.fields) && t.fields.includes('代號'));
  if (!table) throw new Error(`櫃買除權息 ${year}：沒有表格`);
  const code = table.fields.indexOf('代號');
  const cash = table.fields.indexOf('息值');
  for (const r of table.data) if (num(r[cash]) > 0) set.add(String(r[code]).trim());
  return [...set].filter(wanted);
}

async function dividends(dir: string, out: Record<string, FinRow>): Promise<void> {
  const divDir = join(dir, 'div');
  mkdirSync(divDir, { recursive: true });
  const thisYear = new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  const years: Array<Set<string> | null> = [];
  for (let yr = thisYear; yr > thisYear - DIV_YEARS; yr--) {
    const list = await cached(join(divDir, `${yr}.json`), yr === thisYear ? 1 : Infinity, () => dividendYear(yr));
    years.push(Array.isArray(list) ? new Set(list) : null);
  }
  const all = new Set(years.flatMap((s) => [...(s ?? [])]));
  for (const code of all) {
    // 今年還沒除息（多半在下半年）不算中斷，從去年開始數
    let i = years[0]?.has(code) ? 0 : 1;
    let n = 0;
    for (; i < years.length && years[i]?.has(code); i++) n++;
    (out[code] ??= {}).dividendYears = n;
  }
  console.log(`股利：${years.filter(Boolean).length} 年資料、${all.size} 檔`);
}

async function events(dir: string, out: Record<string, FinRow>): Promise<void> {
  const evDir = join(dir, 'events');
  mkdirSync(evDir, { recursive: true });
  const sources = ['https://openapi.twse.com.tw/v1/opendata/t187ap04_L', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O'];
  for (const url of sources) {
    try {
      const rows = JSON.parse(await request(url, {}, 60_000)) as Array<Record<string, string>>;
      const byDate = new Map<string, Array<[string, string, string]>>();
      for (const r of rows) {
        const key = (name: string) => Object.keys(r).find((k) => k.trim().startsWith(name)) ?? name;
        const code = String(r[key('公司代號')] ?? '').trim();
        const subject = String(r[key('主旨')] ?? '').replace(/\s+/g, ' ').trim();
        const roc = String(r[key('發言日期')] ?? '').trim();
        const type = classifyEvent(subject);
        if (!wanted(code) || !type || roc.length < 7) continue;
        const date = `${Number(roc.slice(0, -4)) + 1911}-${roc.slice(-4, -2)}-${roc.slice(-2)}`;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push([code, type, subject.slice(0, 80)]);
      }
      for (const [date, list] of byDate) {
        const path = join(evDir, `${date}.json`);
        const prev = readJson<Array<[string, string, string]>>(path, []);
        const seen = new Set(prev.map((e) => e.join('|')));
        writeFileSync(path, JSON.stringify([...prev, ...list.filter((e) => !seen.has(e.join('|')))]));
      }
      console.log(`重大訊息：${url.includes('twse') ? '上市' : '上櫃'} ${rows.length} 則`);
    } catch (e) {
      console.log(`重大訊息 ✗ ${e}`);
    }
  }
  const cutoff = new Date(Date.now() - EVENT_DAYS * 86400_000).toISOString().slice(0, 10);
  let n = 0;
  for (const f of readdirSync(evDir).sort()) {
    if (f.slice(0, 10) < cutoff) {
      rmSync(join(evDir, f));
      continue;
    }
    for (const [code, , subject] of readJson<Array<[string, string, string]>>(join(evDir, f), [])) {
      // 讀取時用最新的規則重新分類，規則修正後舊紀錄也會跟著更正
      const type = classifyEvent(subject);
      if (!type) continue;
      const r = (out[code] ??= {});
      r.events = [...new Set([...(r.events ?? []), type])];
      n++;
    }
  }
  console.log(`特殊事件：近 ${EVENT_DAYS} 天 ${n} 則`);
}

const dir = process.argv[2] ?? 'data';
mkdirSync(dir, { recursive: true });
const out: Record<string, FinRow> = {};
const result: Record<string, unknown> = { generatedAt: new Date().toISOString() };
try {
  result.quarter = await financials(dir, out);
} catch (e) {
  console.log(`財報 ✗ ${e}`);
}
try {
  await dividends(dir, out);
  result.dividends = true;
} catch (e) {
  console.log(`股利 ✗ ${e}`);
}
await events(dir, out);
result.events = EVENT_DAYS;
result.stocks = out;
writeFileSync(join(dir, 'fundamentals.json'), JSON.stringify(result));
console.log(`完成：${Object.keys(out).length} 檔`);
