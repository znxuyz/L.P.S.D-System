import type { IndexPoint, IndustryId, MarketSnapshot, SessionState, Universe } from '../data/types';

/**
 * 資金流定義（方案 A：成交額佔比的變化）
 *
 *   今日佔比   = 今日成交額 ÷ 今日總成交額
 *   基準佔比   = 20 日平均成交額 ÷ 20 日平均總成交額
 *   資金流(億) = (今日佔比 − 基準佔比) × 今日總成交額
 *
 * 所有產業的資金流加總為 0：一個產業多吸引的成交額，就是其他產業少掉的部分。
 * 這衡量的是「資金在產業之間的轉移」，而不是買賣雙方的淨流入。
 */

export interface StockMetrics {
  code: string;
  name: string;
  industryId: IndustryId;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
  /** 以即時股價計算的市值（億元）。 */
  marketCap: number;
  share: number;
  baseShare: number;
  flow: number;
}

export interface IndustryMetrics {
  id: IndustryId;
  name: string;
  short: string;
  marketCap: number;
  /** 市值權重（0–1）。 */
  weight: number;
  /** 市值加權漲跌幅（%）。 */
  changePct: number;
  turnover: number;
  share: number;
  baseShare: number;
  flow: number;
  advancers: number;
  decliners: number;
  /** 依市值由大到小排序。 */
  stocks: StockMetrics[];
}

export interface MarketMetrics {
  time: number;
  session: SessionState;
  index: {
    name: string;
    value: number;
    prevClose: number;
    change: number;
    changePct: number;
    turnover: number;
    series: IndexPoint[];
  };
  totalTurnover: number;
  advancers: number;
  decliners: number;
  unchanged: number;
  industries: IndustryMetrics[];
  industryById: Map<IndustryId, IndustryMetrics>;
  stockByCode: Map<string, StockMetrics>;
  /** 所有產業資金流絕對值的最大者，給視覺強度正規化用。 */
  maxAbsFlow: number;
}

export function computeMetrics(universe: Universe, snapshot: MarketSnapshot): MarketMetrics {
  let total = 0;
  let baseTotal = 0;
  for (const s of universe.stocks) {
    total += snapshot.quotes[s.code]?.turnover ?? 0;
    baseTotal += s.avgTurnover20;
  }
  const safeTotal = total > 0 ? total : 1;

  const stockByCode = new Map<string, StockMetrics>();
  for (const s of universe.stocks) {
    const q = snapshot.quotes[s.code];
    const price = q?.price ?? s.prevClose;
    const turnover = q?.turnover ?? 0;
    const share = total > 0 ? turnover / safeTotal : 0;
    const baseShare = s.avgTurnover20 / baseTotal;
    stockByCode.set(s.code, {
      code: s.code,
      name: s.name,
      industryId: s.industryId,
      price,
      prevClose: s.prevClose,
      change: price - s.prevClose,
      changePct: ((price - s.prevClose) / s.prevClose) * 100,
      high: q?.high ?? price,
      low: q?.low ?? price,
      volume: q?.volume ?? 0,
      turnover,
      marketCap: s.marketCap * (price / s.prevClose),
      share,
      baseShare,
      flow: total > 0 ? (share - baseShare) * total : 0,
    });
  }

  const allCap = [...stockByCode.values()].reduce((sum, s) => sum + s.marketCap, 0);
  const industries: IndustryMetrics[] = universe.industries.map((ind) => {
    const stocks = [...stockByCode.values()]
      .filter((s) => s.industryId === ind.id)
      .sort((a, b) => b.marketCap - a.marketCap);
    const marketCap = stocks.reduce((sum, s) => sum + s.marketCap, 0);
    const prevCap = stocks.reduce((sum, s) => sum + s.marketCap / (1 + s.changePct / 100), 0);
    const turnover = stocks.reduce((sum, s) => sum + s.turnover, 0);
    const share = stocks.reduce((sum, s) => sum + s.share, 0);
    const baseShare = stocks.reduce((sum, s) => sum + s.baseShare, 0);
    return {
      id: ind.id,
      name: ind.name,
      short: ind.short,
      marketCap,
      weight: marketCap / allCap,
      changePct: prevCap > 0 ? (marketCap / prevCap - 1) * 100 : 0,
      turnover,
      share,
      baseShare,
      flow: total > 0 ? (share - baseShare) * total : 0,
      advancers: stocks.filter((s) => s.change > 0).length,
      decliners: stocks.filter((s) => s.change < 0).length,
      stocks,
    };
  });

  const stocks = [...stockByCode.values()];
  const idx = snapshot.index;
  return {
    time: snapshot.time,
    session: snapshot.session,
    index: {
      name: universe.index.name,
      value: idx.value,
      prevClose: universe.index.prevClose,
      change: idx.value - universe.index.prevClose,
      changePct: (idx.value / universe.index.prevClose - 1) * 100,
      turnover: idx.turnover,
      series: idx.series,
    },
    totalTurnover: total,
    advancers: stocks.filter((s) => s.change > 0).length,
    decliners: stocks.filter((s) => s.change < 0).length,
    unchanged: stocks.filter((s) => s.change === 0).length,
    industries,
    industryById: new Map(industries.map((i) => [i.id, i])),
    stockByCode,
    maxAbsFlow: Math.max(1e-9, ...industries.map((i) => Math.abs(i.flow))),
  };
}
