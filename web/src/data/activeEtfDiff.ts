/**
 * 主動式 ETF 每日持股的比對（網頁與每日抓取腳本共用）。
 *
 * 只用可被 Node 直接執行的 TypeScript 語法（不用 enum、參數屬性），
 * 讓 scripts/active-etf.ts 能用 `node` 直接匯入。
 */

export interface HoldingRow {
  code: string;
  name: string;
  /** 權重（%）。 */
  weight: number;
  /** 持有股數。 */
  shares: number;
}

export interface Snapshot {
  /** 資料日期（YYYY-MM-DD）。 */
  date: string;
  /** 基金流通在外單位數；用來排除申購買回造成的股數變化。 */
  units?: number;
  holdings: HoldingRow[];
}

export type ChangeKind = 'add' | 'remove' | 'increase' | 'decrease';

export interface ChangeRow {
  date: string;
  code: string;
  name: string;
  kind: ChangeKind;
  /** 權重（%）。 */
  before: number;
  after: number;
}

/** 每單位持股變化小於這個比例視為沒有調整（避免四捨五入與零股誤判）。 */
export const MIN_CHANGE = 0.02;

/**
 * 比對前後兩天的持股。
 *
 * ETF 有人申購或買回時，所有持股的股數會等比例增減，那不是經理人的決定。
 * 所以有單位數時，改看「每單位持有幾股」的變化；沒有單位數時才直接比股數。
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): ChangeRow[] {
  const per = (s: Snapshot, h: HoldingRow) => (s.units && s.units > 0 ? h.shares / s.units : h.shares);
  const before = new Map(prev.holdings.map((h) => [h.code, h]));
  const after = new Map(next.holdings.map((h) => [h.code, h]));
  const out: ChangeRow[] = [];
  for (const [code, a] of after) {
    const b = before.get(code);
    if (!b) {
      out.push({ date: next.date, code, name: a.name, kind: 'add', before: 0, after: a.weight });
      continue;
    }
    const pb = per(prev, b);
    const pa = per(next, a);
    if (pb <= 0) continue;
    const r = pa / pb - 1;
    if (Math.abs(r) >= MIN_CHANGE) out.push({ date: next.date, code, name: a.name, kind: r > 0 ? 'increase' : 'decrease', before: b.weight, after: a.weight });
  }
  for (const [code, b] of before) {
    if (!after.has(code)) out.push({ date: next.date, code, name: b.name, kind: 'remove', before: b.weight, after: 0 });
  }
  const order: Record<ChangeKind, number> = { add: 0, increase: 1, decrease: 2, remove: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
}

/** 把新快照放進歷史（同一天就取代），只保留最近 n 筆，由舊到新。 */
export function pushSnapshot(history: Snapshot[], snap: Snapshot, keep = 10): Snapshot[] {
  const rest = history.filter((h) => h.date !== snap.date);
  return [...rest, snap].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-keep);
}

/** 由歷史算出最近幾個交易日的異動（新到舊）。 */
export function recentChanges(history: Snapshot[], days = 5): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (let i = history.length - 1; i > 0 && history.length - i <= days; i--) out.push(...diffSnapshots(history[i - 1], history[i]));
  return out;
}

/** 基本檢查：持股太少或權重總和不合理時，視為抓取失敗，不覆蓋舊資料。 */
export function looksValid(s: Snapshot): boolean {
  const total = s.holdings.reduce((t, h) => t + h.weight, 0);
  return /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.holdings.length >= 5 && total > 40 && total < 115 && s.holdings.every((h) => /^\w{4,6}$/.test(h.code));
}
