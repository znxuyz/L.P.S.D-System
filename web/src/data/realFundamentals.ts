import type { Fundamentals, StockEvent } from './types';
import { peBand } from './mockUniverse';
import type { StockDirectory } from './stockDirectory';

/**
 * 真實行情模式下，把股票池的示意基本面換成官方資料（GitHub Actions 每天產生）：
 * - 本益比、殖利率：證交所 / 櫃買每日公布（data/stocks.json），換算成近四季 EPS 與股利。
 * - 法人連買 / 連賣天數：證交所、櫃買三大法人買賣超（外資＋投信）。
 * - 千張大戶持股變化：集保股權分散表（每週）。
 * - EPS 年增、毛利率／營益率變化、現金流：公開資訊觀測站彙總報表（每季）。
 * - 連續配息年數：證交所、櫃買除權息資料；特殊事件：每日重大訊息依主旨分類（近 45 天）。
 * 讀不到的欄位維持示意值。
 */

export interface Chips {
  generatedAt: string;
  inst?: {
    /** 最新一個交易日。 */
    asOf: string;
    /** 用了幾個交易日的資料（連買天數最多算到這裡）。 */
    days: number;
    /** 外資＋投信連續買超天數；負數為連續賣超。 */
    streak: Record<string, number>;
  };
  big?: {
    asOf: string;
    /** 比較的起始週。 */
    from: string;
    /** 千張大戶持股比率的變化（百分點）。 */
    chg: Record<string, number>;
  };
}

/** data/fundamentals.json（scripts/financials.ts 產生）。 */
export interface FinData {
  generatedAt: string;
  /** 財報所屬季度，例如 2026Q2；沒抓到財報時沒有。 */
  quarter?: string;
  dividends?: boolean;
  /** 特殊事件涵蓋的天數；沒抓到時沒有。 */
  events?: number;
  stocks: Record<
    string,
    { epsYoY?: number; grossMarginChg?: number; opMarginChg?: number; fcfPositive?: boolean; dividendYears?: number; events?: string[] }
  >;
}

let finPending: Promise<FinData | null> | null = null;

export function loadFinancials(url = 'data/fundamentals.json'): Promise<FinData | null> {
  finPending ??= fetch(url, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<FinData>) : null))
    .then((j) => (j && typeof j.stocks === 'object' ? j : null))
    .catch(() => null);
  return finPending;
}

let pending: Promise<Chips | null> | null = null;

export function loadChips(url = 'data/chips.json'): Promise<Chips | null> {
  pending ??= fetch(url, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<Chips>) : null))
    .catch(() => null);
  return pending;
}

export interface RealData {
  directory: StockDirectory | null;
  chips: Chips | null;
  fin?: FinData | null;
}

/** 哪些欄位換成了真實資料（給頁面上的資料來源說明用）。 */
export interface RealCoverage {
  ratios: boolean;
  inst: boolean;
  big: boolean;
  /** 財報（EPS 年增、毛利率、現金流）。 */
  quarter: boolean;
  dividends: boolean;
  events: boolean;
}

export function coverageOf(real: RealData): RealCoverage {
  return {
    ratios: !!real.directory?.stocks.some((s) => s.pe !== undefined || s.yieldPct !== undefined),
    inst: !!real.chips?.inst && Object.keys(real.chips.inst.streak).length > 0,
    big: !!real.chips?.big && Object.keys(real.chips.big.chg).length > 0,
    quarter: !!real.fin?.quarter,
    dividends: !!real.fin?.dividends,
    events: !!real.fin?.events,
  };
}

/** 依目錄建立代號索引（目錄有兩千多檔，避免每次 find）。 */
export function indexDirectory(dir: StockDirectory | null): Map<string, StockDirectory['stocks'][number]> {
  return new Map((dir?.stocks ?? []).map((s) => [s.code, s]));
}

/**
 * 把真實資料寫進一檔股票的基本面（直接修改 f）。
 * 本益比、殖利率是以目錄的收盤價計算的，所以 EPS = 收盤 ÷ 本益比、股利 = 收盤 × 殖利率。
 */
export function overlayReal(
  code: string,
  f: Fundamentals,
  index: ReturnType<typeof indexDirectory>,
  chips: Chips | null,
  fin: FinData | null = null,
): void {
  const d = index.get(code);
  if (d?.close) {
    if (d.pe && d.pe > 0) {
      f.eps4q = d.close / d.pe;
      // 5 年本益比區間還是示意值，但要以真實本益比為中心，否則分位會失真
      f.pe5y = peBand(code, d.pe);
    }
    // 證交所對虧損的公司不公布本益比（但有殖利率等其他欄位）
    else if (d.yieldPct !== undefined || d.pb !== undefined) f.eps4q = -Math.abs(f.eps4q || 1);
    if (d.yieldPct !== undefined && d.yieldPct >= 0) f.dividend = (d.close * d.yieldPct) / 100;
    f.payoutRatio = f.eps4q > 0 ? Math.min(120, (f.dividend / f.eps4q) * 100) : 0;
  }
  const streak = chips?.inst?.streak[code];
  if (streak !== undefined) f.instBuyDays = streak;
  const chg = chips?.big?.chg[code];
  if (chg !== undefined) f.bigHolderChg = chg;

  if (!fin) return;
  const r = fin.stocks[code];
  if (fin.quarter && r) {
    if (r.epsYoY !== undefined) f.epsYoY = r.epsYoY;
    if (r.grossMarginChg !== undefined) f.grossMarginChg = r.grossMarginChg;
    if (r.opMarginChg !== undefined) f.opMarginChg = r.opMarginChg;
    if (r.fcfPositive !== undefined) f.fcfPositive = r.fcfPositive;
  }
  // 有股利、事件資料時，沒出現在清單上就代表沒有（只限目錄裡的上市櫃股票）
  const listed = index.has(code) || !!r;
  if (fin.dividends && listed) f.dividendYears = r?.dividendYears ?? 0;
  if (fin.events && listed) f.events = (r?.events ?? []).filter((e): e is StockEvent => e === 'guidance-up' || e === 'merger' || e === 'subsidy');
}

/** 頁面上的資料來源說明。 */
export function realNote(cov: RealCoverage, chips: Chips | null, fin: FinData | null = null): string {
  const real = ['股價'];
  if (cov.ratios) real.push('本益比', '殖利率');
  if (cov.inst) real.push(`法人連買賣（${chips!.inst!.asOf}）`);
  if (cov.big) real.push(`千張大戶（${chips!.big!.from} → ${chips!.big!.asOf}）`);
  if (cov.quarter) real.push(`EPS 年增、毛利率、現金流（${fin!.quarter} 財報）`);
  if (cov.dividends) real.push('連續配息年數');
  if (cov.events) real.push(`特殊事件（近 ${fin!.events} 天重大訊息）`);
  const mock = ['5 年本益比區間'];
  if (!cov.quarter) mock.push('EPS 年增', '毛利率', '現金流');
  if (!cov.dividends) mock.push('配息年數');
  if (!cov.events) mock.push('特殊事件');
  if (!cov.inst) mock.push('法人籌碼');
  if (!cov.big) mock.push('千張大戶');
  return `真實資料：${real.join('、')}；仍為模擬資料：${mock.join('、')}，相關條件僅供參考。`;
}
