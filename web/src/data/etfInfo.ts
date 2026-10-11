import type { EtfMeta } from './types';

/**
 * 每天收盤後抓的 ETF 真實資料（scripts/etf-info.ts 產生的 data/etf-info.json）：
 * 淨值、規模、受益人數、配息、填息、追蹤指數。內扣費用率沒有公開資料，仍是模擬值。
 * 讀不到時（本機開發、還沒跑過排程）就沿用模擬資料。
 */
export interface EtfInfoFile {
  asOf: string;
  etfs: Record<
    string,
    {
      name?: string;
      nav?: number;
      navDate?: string;
      navPrev?: number;
      aum?: number;
      holders?: number;
      issuer?: string;
      underlying?: string;
      dividendPerYear?: number;
      frequency?: EtfMeta['frequency'];
      dividendYears?: number;
      dividendYearsAtLeast?: boolean;
      fillRate?: number;
      divs?: Array<[string, number]>;
    }
  >;
}

export async function loadEtfInfo(url = 'data/etf-info.json'): Promise<EtfInfoFile | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = (await res.json()) as EtfInfoFile;
    return json && typeof json.etfs === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** 把抓得到的欄位換成真實資料，並記下哪些是真的。 */
export function applyEtfInfo(etfs: EtfMeta[], file: EtfInfoFile): number {
  let n = 0;
  for (const meta of etfs) {
    const d = file.etfs[meta.code];
    if (!d) continue;
    const real: NonNullable<EtfMeta['info']>['real'] = [];
    if (d.nav && d.nav > 0) real.push('nav');
    if (d.aum && d.aum > 0) {
      meta.aum = d.aum;
      real.push('aum');
    }
    if (d.holders && d.holders > 0) {
      meta.holders = d.holders;
      real.push('holders');
    }
    if (d.dividendPerYear != null) {
      meta.dividendPerYear = d.dividendPerYear;
      if (d.frequency) meta.frequency = d.frequency;
      if (d.dividendYears != null) meta.dividendYears = d.dividendYears;
      real.push('dividend');
    }
    if (d.fillRate != null) {
      meta.fillRate = d.fillRate;
      real.push('fill');
    }
    // 主動式 ETF 的「投資範圍」用內建的說明，指數型才換成官方的追蹤指數名稱
    if (d.underlying && meta.category !== 'active') {
      meta.underlying = d.underlying;
      real.push('underlying');
    }
    meta.info = {
      asOf: d.navDate ?? file.asOf,
      real,
      nav: d.nav,
      navDate: d.navDate,
      issuer: d.issuer,
      dividendYearsAtLeast: d.dividendYearsAtLeast,
      divs: d.divs,
    };
    n++;
  }
  return n;
}
