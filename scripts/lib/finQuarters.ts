/**
 * 公開資訊觀測站彙總報表（fin/<民國年>Q<季>-<sii|otc>-sb04|sb20.json）→ 每檔的單季財報。
 * 累計數字相減成單季；公布日用法定申報期限再往後一點（Q1 5/31、Q2 8/31、Q3 11/30、Q4 隔年 3/31），
 * 模擬時一定還沒公布的不會被看到。sim-fund.ts（模擬盤基本面）與 sim-screen.ts（模擬盤選股）共用。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** [季別 "2024Q3", 公布日, 營收, 毛利, 營業利益, 稅後淨利(母公司), EPS, 營業現金流]（千元；沒有的是 null） */
export type Quarter = [string, string, number | null, number | null, number | null, number | null, number | null, number | null];

interface Cum {
  rev: number | null;
  gp: number | null;
  op: number | null;
  ni: number | null;
  eps: number | null;
  ocf: number | null;
}

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

function availDate(y: number, q: number): string {
  return q === 1 ? `${y}-05-31` : q === 2 ? `${y}-08-31` : q === 3 ? `${y}-11-30` : `${y + 1}-03-31`;
}

/** 讀財報資料夾，回傳 代號 → 單季財報（由舊到新）與讀了幾份報表。 */
export function loadFinQuarters(finDir: string): { byCode: Map<string, Quarter[]>; files: number } {
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
  const byCode = new Map<string, Quarter[]>();
  for (const [code, m] of cum) {
    const out: Quarter[] = [];
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
      out.push([`${y}Q${q}`, availDate(y, q), single('rev'), single('gp'), single('op'), single('ni'), eps == null ? null : r2(eps), single('ocf')]);
    }
    byCode.set(code, out);
  }
  return { byCode, files: files.length };
}
