/**
 * 內部人持股轉讓事前申報（董事、監察人、經理人、大股東要賣股前的申報）：
 *
 *   node scripts/insider.ts <資料資料夾>
 *
 * 證交所、櫃買的開放資料只提供「最新一天」，沒有歷史，所以每天收集、從今天開始累積，存 insider/<出表日期>.json。
 * 用途：營收選股的決策紀錄先「註記」（內部人申報要賣），累積幾個月後再驗證這個條件有沒有用，有用才當成不買的條件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const out = join(dir, 'insider');
mkdirSync(out, { recursive: true });
const SOURCES = [
  ['上市', 'https://openapi.twse.com.tw/v1/opendata/t187ap12_L'],
  ['上櫃', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_O'],
] as const;
/** 民國日期 1151119 → 2026-11-19 */
const roc = (s: string) => (/^\d{7}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}` : '');
const num = (v: unknown) => Number(String(v ?? '').replace(/,/g, '')) || 0;
type Row = { code: string; who: string; how: string; shares: number; held: number; period: string };
const byDate = new Map<string, Row[]>();
for (const [name, url] of SOURCES) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const rows = (await res.json()) as Array<Record<string, string>>;
    let n = 0;
    for (const r of rows) {
      const d = roc(r['出表日期'] ?? r['出表日期 '] ?? '');
      const code = String(r['公司代號'] ?? '').trim();
      if (!d || !code) continue;
      const row: Row = {
        code,
        who: String(r['申報人身分'] ?? '').trim(),
        how: String(r['預定轉讓方式及股數-轉讓方式'] ?? '').trim(),
        shares: num(r['預定轉讓總股數-自有持股']) + num(r['預定轉讓總股數-保留運用決定權信託股數']),
        held: num(r['目前持有股數-自有持股']) + num(r['目前持有股數-保留運用決定權信託股數']),
        period: String(r['有效轉讓期間'] ?? '').trim(),
      };
      (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(row);
      n++;
    }
    console.log(`內部人申報轉讓：${name} ${n} 筆`);
  } catch (e) {
    console.log(`內部人申報轉讓：${name} ✗ ${e}`);
  }
}
for (const [d, rows] of byDate) {
  const f = join(out, `${d}.json`);
  // 同一天可能抓好幾次（每小時更新）：上市、上櫃合併，以最新一次為準
  writeFileSync(f, JSON.stringify(rows));
  console.log(`  ${d}：${rows.length} 筆`);
}
