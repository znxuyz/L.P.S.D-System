import type { EtfCategory, EtfMeta, HoldingChange, MarketSnapshot, Universe } from '../data/types';
import type { MarketMetrics, StockMetrics } from './metrics';

/**
 * ETF 指標
 *
 * ETF 的成交額不計入產業資金流的總額：ETF 的錢最後會流進成分股，
 * 同時算進去會重複計算。這裡改看「成分股今天的資金流」來判斷 ETF 背後的資金方向。
 *
 *   殖利率     = 近一年配息 ÷ 現價
 *   折溢價     = 現價 ÷ 預估淨值 − 1
 *   成分股漲跌 = 成分股漲跌幅依權重加權
 *   成分股資金流 = 列出的成分股今日資金流加總（億元）
 */

export interface HoldingView {
  code: string;
  name: string;
  weight: number;
  /** 在股票池裡才有即時行情。 */
  stock?: StockMetrics;
}

export interface ChangeView extends HoldingChange {
  name: string;
  stock?: StockMetrics;
}

export interface EtfView {
  meta: EtfMeta;
  price: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
  nav: number;
  premiumPct: number;
  yieldPct: number;
  holdings: HoldingView[];
  /** 列出的成分股佔 ETF 的總權重（%）。 */
  coveredWeight: number;
  /** 其中有即時行情（在股票池裡）的權重（%）。 */
  trackedWeight: number;
  holdingsChangePct: number;
  holdingsFlow: number;
  changes: ChangeView[];
}

/** 主動式 ETF 共識：同一檔股票被幾檔主動式 ETF 加碼（含新進）或減碼（含出清）。 */
export interface ConsensusRow {
  code: string;
  name: string;
  stock?: StockMetrics;
  buyers: string[];
  sellers: string[];
}

export interface EtfCategorySummary {
  category: EtfCategory;
  count: number;
  avgChangePct: number;
  turnover: number;
}

export function computeEtfs(universe: Universe, snapshot: MarketSnapshot, metrics: MarketMetrics): EtfView[] {
  return (universe.etfs ?? []).map((meta) => {
    const q = snapshot.quotes[meta.code];
    const price = q?.price ?? meta.prevClose;
    const nav = q?.nav ?? price;
    const holdings: HoldingView[] = meta.holdings
      .map((h) => {
        const stock = metrics.stockByCode.get(h.code);
        return { code: h.code, name: stock?.name ?? h.name ?? h.code, weight: h.weight, stock };
      })
      .sort((a, b) => b.weight - a.weight);
    const coveredWeight = holdings.reduce((s, h) => s + h.weight, 0);
    const tracked = holdings.filter((h): h is HoldingView & { stock: StockMetrics } => !!h.stock);
    const trackedWeight = tracked.reduce((s, h) => s + h.weight, 0);
    return {
      meta,
      price,
      change: price - meta.prevClose,
      changePct: (price / meta.prevClose - 1) * 100,
      high: q?.high ?? price,
      low: q?.low ?? price,
      volume: q?.volume ?? 0,
      turnover: q?.turnover ?? 0,
      nav,
      premiumPct: (price / nav - 1) * 100,
      yieldPct: (meta.dividendPerYear / price) * 100,
      holdings,
      coveredWeight,
      trackedWeight,
      holdingsChangePct: trackedWeight > 0 ? tracked.reduce((s, h) => s + h.weight * h.stock.changePct, 0) / trackedWeight : 0,
      holdingsFlow: tracked.reduce((s, h) => s + h.stock.flow, 0),
      changes: meta.changes.map((c) => {
        const stock = metrics.stockByCode.get(c.code);
        return { ...c, name: stock?.name ?? c.name ?? c.code, stock };
      }),
    };
  });
}

export function summarizeEtfs(etfs: EtfView[]): EtfCategorySummary[] {
  const order: EtfCategory[] = ['market', 'dividend', 'theme', 'active', 'bond'];
  return order.map((category) => {
    const list = etfs.filter((e) => e.meta.category === category);
    return {
      category,
      count: list.length,
      avgChangePct: list.length ? list.reduce((s, e) => s + e.changePct, 0) / list.length : 0,
      turnover: list.reduce((s, e) => s + e.turnover, 0),
    };
  });
}

export function activeConsensus(etfs: EtfView[]): ConsensusRow[] {
  const rows = new Map<string, ConsensusRow>();
  for (const e of etfs.filter((x) => x.meta.category === 'active')) {
    const buy = new Set<string>();
    const sell = new Set<string>();
    for (const c of e.changes) (c.kind === 'add' || c.kind === 'increase' ? buy : sell).add(c.code);
    for (const c of e.changes) {
      if (!rows.has(c.code)) rows.set(c.code, { code: c.code, name: c.name, stock: c.stock, buyers: [], sellers: [] });
    }
    for (const code of buy) rows.get(code)!.buyers.push(e.meta.code);
    for (const code of sell) rows.get(code)!.sellers.push(e.meta.code);
  }
  return [...rows.values()].sort(
    (a, b) => b.buyers.length - b.sellers.length - (a.buyers.length - a.sellers.length) || b.buyers.length - a.buyers.length,
  );
}
