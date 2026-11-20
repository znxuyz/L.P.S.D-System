/**
 * 每月營收「公布時間」記錄（從現在開始累積，過去沒有這份資料）：
 *
 *   node scripts/revenue-dates.ts <資料資料夾>
 *
 * 為什麼：很多公司 1～10 日就公布上個月營收，股價當天就反應；選股目前等到 12 日之後才換股，可能錯過最大的一段。
 * 要驗證「一公布就買」有沒有多賺，需要知道每家公司是哪一天、幾點公布的，開放資料沒有這個欄位，只能自己每次抓、記下「第一次看到」的時間。
 * - 證交所、櫃買開放資料「每月營業收入彙總表」，每次執行（每天好幾次）抓一次。
 * - 存 revdates/<YYYY-MM>.json：{ 代號: [第一次看到的台北時間 "YYYY-MM-DD HH:mm", 出表日期, 當月營收, 去年當月營收] }，已經有的不覆蓋。
 * - 第一次上線時看到的 2026-10 營收早就公布了，時間不準；從 2026-11 營收（12 月初公布）開始才算數。
 * - 累積 3～6 個月後，用這份時間做「公布後隔天開盤買」的回測，跟現在的 12 日後換股比。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const out = join(dir, 'revdates');
mkdirSync(out, { recursive: true });
const SOURCES = [
  ['上市', 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L'],
  ['上櫃', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'],
] as const;
const roc = (s: string) => (/^\d{7}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}` : '');
const rocYm = (s: string) => (/^\d{5}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}-${s.slice(3, 5)}` : '');
const num = (v: unknown) => Number(String(v ?? '').replace(/,/g, '')) || 0;
const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);

type Entry = [string, string, number, number];
const files = new Map<string, Record<string, Entry>>();
const load = (ym: string) => {
  let m = files.get(ym);
  if (!m) {
    const f = join(out, `${ym}.json`);
    try {
      m = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, Entry>) : {};
    } catch {
      m = {};
    }
    files.set(ym, m);
  }
  return m;
};
let added = 0;
for (const [name, url] of SOURCES) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const rows = (await res.json()) as Array<Record<string, string>>;
    let n = 0;
    let fresh = 0;
    for (const r of rows) {
      const ym = rocYm(String(r['資料年月'] ?? '').trim());
      const code = String(r['公司代號'] ?? '').trim();
      if (!ym || !/^\d{4}$/.test(code)) continue;
      n++;
      const m = load(ym);
      if (m[code]) continue;
      m[code] = [now, roc(String(r['出表日期'] ?? '').trim()), num(r['營業收入-當月營收']), num(r['營業收入-去年當月營收'])];
      fresh++;
    }
    added += fresh;
    console.log(`營收公布時間：${name} ${n} 家，新看到 ${fresh} 家`);
  } catch (e) {
    console.log(`營收公布時間：${name} ✗ ${e}`);
  }
}
for (const [ym, m] of files) {
  writeFileSync(join(out, `${ym}.json`), JSON.stringify(m));
  console.log(`  ${ym}：共 ${Object.keys(m).length} 家`);
}
console.log(`營收公布時間：這次新增 ${added} 家（${now}）`);
