import type { Fundamentals } from './types';
import { peBand } from './mockUniverse';
import type { StockDirectory } from './stockDirectory';

/**
 * 真實行情模式下，把股票池的示意基本面換成官方資料（GitHub Actions 每天產生）：
 * - 本益比、殖利率：證交所 / 櫃買每日公布（data/stocks.json），換算成近四季 EPS 與股利。
 * - 法人連買 / 連賣天數：證交所、櫃買三大法人買賣超（外資＋投信）。
 * - 千張大戶持股變化：集保股權分散表（每週）。
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
}

/** 哪些欄位換成了真實資料（給頁面上的資料來源說明用）。 */
export interface RealCoverage {
  ratios: boolean;
  inst: boolean;
  big: boolean;
}

export function coverageOf(real: RealData): RealCoverage {
  return {
    ratios: !!real.directory?.stocks.some((s) => s.pe !== undefined || s.yieldPct !== undefined),
    inst: !!real.chips?.inst && Object.keys(real.chips.inst.streak).length > 0,
    big: !!real.chips?.big && Object.keys(real.chips.big.chg).length > 0,
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
export function overlayReal(code: string, f: Fundamentals, index: ReturnType<typeof indexDirectory>, chips: Chips | null): void {
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
}

/** 頁面上的資料來源說明。 */
export function realNote(cov: RealCoverage, chips: Chips | null): string {
  const real = ['股價'];
  if (cov.ratios) real.push('本益比', '殖利率');
  if (cov.inst) real.push(`法人連買賣（${chips!.inst!.asOf}）`);
  if (cov.big) real.push(`千張大戶（${chips!.big!.from} → ${chips!.big!.asOf}）`);
  const mock = ['EPS 年增', '配息年數', '現金流', '毛利率', '5 年本益比區間', '特殊事件'];
  if (!cov.inst) mock.push('法人籌碼');
  if (!cov.big) mock.push('千張大戶');
  return `真實資料：${real.join('、')}；仍為模擬資料：${mock.join('、')}，相關條件僅供參考。`;
}
