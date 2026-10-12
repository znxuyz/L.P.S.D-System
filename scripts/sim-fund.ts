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

type Row = [string, number, number, number, number, number];
type Quarter = [string, string, number | null, number | null, number | null, number | null, number | null, number | null];

const dir = process.argv[2] ?? 'data';
const finDir = join(dir, 'fin');
const ratioDir = join(dir, 'ratios');
const out = join(dir, 'simfund');

const num = (v: unknown): number | null => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (s === '' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const pick = (r: Record<string, string>, keys: string[]) => {
  for (const k of keys) {
    const v = num(r[k]);
    if (v != null) return v;
  }
  return null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 法定期限再往後一點（金融業的期限比較晚），模擬時不會提早看到。 */
function availDate(y: number, q: number): string {
  return q === 1 ? `${y}-05-31` : q === 2 ? `${y}-08-31` : q === 3 ? `${y}-11-30` : `${y + 1}-03-31`;
}

// ---------- 財報：累計 → 單季
interface Cum {
  rev: number | null;
  gp: number | null;
  op: number | null;
  ni: number | null;
  eps: number | null;
  ocf: number | null;
}
/** 代號 → 「民國年Q季」 → 累計數字 */
const cum = new Map<string, Map<string, Cum>>();
const files = existsSync(finDir) ? readdirSync(finDir).filter((f) => /^\d+Q\d-(sii|otc)-sb(04|20)\.json$/.test(f)) : [];
for (const f of files) {
  const [, yq, , kind] = f.match(/^(\d+Q\d)-(sii|otc)-sb(04|20)\.json$/)!;
  const data = JSON.parse(readFileSync(join(finDir, f), 'utf8')) as Record<string, Record<string, string>>;
  for (const [code, r] of Object.entries(data)) {
    if (!/^\d{4}$/.test(code)) continue;
    let m = cum.get(code);
    if (!m) cum.set(code, (m = new Map()));
    const c = m.get(yq) ?? { rev: null, gp: null, op: null, ni: null, eps: null, ocf: null };
    if (kind === '04') {
      c.rev = pick(r, ['營業收入', '淨收益', '收益', '收入']);
      c.gp = pick(r, ['營業毛利（毛損）淨額', '營業毛利（毛損）']);
      c.op = pick(r, ['營業利益（損失）', '繼續營業單位稅前損益', '繼續營業單位稅前淨利（淨損）']);
      c.ni = pick(r, ['淨利（淨損）歸屬於母公司業主', '本期淨利（淨損）', '本期稅後淨利（淨損）']);
      c.eps = pick(r, ['基本每股盈餘（元）']);
    } else c.ocf = pick(r, ['營業活動之淨現金流入（流出）']);
    m.set(yq, c);
  }
}

function quarters(code: string): Quarter[] {
  const m = cum.get(code);
  if (!m) return [];
  const outQ: Quarter[] = [];
  for (const yq of [...m.keys()].sort((a, b) => Number(a.replace('Q', '')) - Number(b.replace('Q', '')))) {
    const roc = Number(yq.split('Q')[0]);
    const q = Number(yq.split('Q')[1]);
    const c = m.get(yq)!;
    const p = q === 1 ? null : m.get(`${roc}Q${q - 1}`);
    if (q > 1 && !p) continue; // 少了前一季，算不出單季
    const single = (k: keyof Cum) => {
      const v = c[k];
      if (v == null) return null;
      if (q === 1) return v;
      const pv = p![k];
      return pv == null ? null : v - pv;
    };
    const y = roc + 1911;
    const eps = single('eps');
    outQ.push([`${y}Q${q}`, availDate(y, q), single('rev'), single('gp'), single('op'), single('ni'), eps == null ? null : r2(eps), single('ocf')]);
  }
  return outQ;
}

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
for (const code of new Set([...cum.keys(), ...ratios.keys()])) {
  const q = quarters(code);
  const r = ratios.get(code) ?? [];
  if (!q.length && !r.length) continue;
  const text = JSON.stringify({ q, r });
  writeFileSync(join(out, `${code}.json`), text);
  n++;
  bytes += text.length;
}
console.log(`simfund：${n} 檔，共 ${(bytes / 1e6).toFixed(1)} MB（財報 ${files.length} 份、本益比 ${ratioFiles.length} 天）`);
