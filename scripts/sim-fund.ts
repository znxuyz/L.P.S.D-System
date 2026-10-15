/**
 * 模擬盤用的「當時看得到的」基本面：每檔一個檔案，網頁看哪一檔才載入。
 *
 *   node scripts/sim-fund.ts <資料資料夾>
 *
 * 輸出 simfund/<代號>.json：
 *   q: [[季別 "2024Q3", 公布日, 營收, 毛利, 營業利益, 稅後淨利(母公司), EPS, 營業現金流], …]  單季（累計數字相減）
 *      金額單位千元；沒有的欄位是 null（金融股沒有營收、毛利）。
 *      公布日用法定申報期限往後抓（Q1 5/31、Q2 8/31、Q3 11/30、Q4 隔年 3/31），模擬時一定還沒公布的不會被看到。
 *   r: [[日期, 近四季 EPS, 現金股利, 每股淨值], …]  由每日本益比、殖利率、淨值比和收盤價反推，只存有變化的日子。
 *      網頁用「前一天收盤價」重新算本益比、殖利率、淨值比。
 * 不連網；只做 4 碼股票（ETF 沒有財報）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFinQuarters } from './lib/finQuarters.ts';

type Row = [string, number, number, number, number, number];

const dir = process.argv[2] ?? 'data';
const finDir = join(dir, 'fin');
const ratioDir = join(dir, 'ratios');
const out = join(dir, 'simfund');

const r2 = (v: number) => Math.round(v * 100) / 100;

const { byCode: finBy, files: finFiles } = loadFinQuarters(finDir);

// ---------- 每日本益比、殖利率、淨值比 → 反推近四季 EPS、股利、每股淨值
const closes = new Map<string, Map<string, number>>();
for (const f of readdirSync(join(dir, 'candles')).filter((f) => /^\d{4}\.json$/.test(f))) {
  const rows = JSON.parse(readFileSync(join(dir, 'candles', f), 'utf8')) as Row[];
  closes.set(f.slice(0, 4), new Map(rows.map((r) => [r[0], r[4]])));
}
const ratios = new Map<string, Array<[string, number | null, number | null, number | null]>>();
const ratioFiles = existsSync(ratioDir) ? readdirSync(ratioDir).filter((f) => f.endsWith('.json')).sort() : [];
for (const f of ratioFiles) {
  const date = f.slice(0, 10);
  const day = JSON.parse(readFileSync(join(ratioDir, f), 'utf8')) as Record<string, [number, number, number]>;
  for (const [code, [pe, yld, pb]] of Object.entries(day)) {
    const close = closes.get(code)?.get(date);
    if (!close) continue;
    const eps4 = pe > 0 ? r2(close / pe) : null;
    const div = yld > 0 ? r2((close * yld) / 100) : 0;
    const bvps = pb > 0 ? r2(close / pb) : null;
    let list = ratios.get(code);
    if (!list) ratios.set(code, (list = []));
    const prev = list[list.length - 1];
    // 只存有變化的日子（收盤價四捨五入造成的小差異不算）
    const moved = (a: number | null, b: number | null) => (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > Math.max(0.02, Math.abs(b) * 0.01));
    if (!prev || moved(eps4, prev[1]) || moved(div, prev[2]) || moved(bvps, prev[3])) list.push([date, eps4, div, bvps]);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
let bytes = 0;
for (const code of new Set([...finBy.keys(), ...ratios.keys()])) {
  const q = finBy.get(code) ?? [];
  const r = ratios.get(code) ?? [];
  if (!q.length && !r.length) continue;
  const text = JSON.stringify({ q, r });
  writeFileSync(join(out, `${code}.json`), text);
  n++;
  bytes += text.length;
}
console.log(`simfund：${n} 檔，共 ${(bytes / 1e6).toFixed(1)} MB（財報 ${finFiles} 份、本益比 ${ratioFiles.length} 天）`);
