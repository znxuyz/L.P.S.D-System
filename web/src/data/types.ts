/**
 * 資料層的標準格式。
 *
 * UI 與領域邏輯只認得這些型別；任何資料來源（mock、富果、證交所公開資料）
 * 都要先轉成這個格式，再交給上層使用。
 * 金額單位一律是「億元」，成交量單位是「張」。
 */

export type IndustryId = string;

export interface IndustryMeta {
  id: IndustryId;
  name: string;
  /** 兩個字的簡稱，給城池旗幟與窄欄位使用。 */
  short: string;
}

export interface StockMeta {
  code: string;
  name: string;
  industryId: IndustryId;
  /** 以昨收計算的市值（億元）。版面依此配置面積。 */
  marketCap: number;
  /** 近 20 日平均每日成交額（億元），資金流的基準線。 */
  avgTurnover20: number;
  prevClose: number;
}

export interface Universe {
  industries: IndustryMeta[];
  stocks: StockMeta[];
  index: { name: string; prevClose: number };
}

export interface Quote {
  code: string;
  price: number;
  high: number;
  low: number;
  /** 今日累計成交量（張）。 */
  volume: number;
  /** 今日累計成交額（億元）。 */
  turnover: number;
}

export interface IndexPoint {
  /** epoch ms */
  t: number;
  v: number;
}

export type SessionState = 'pre' | 'open' | 'closed';

export interface MarketSnapshot {
  /** epoch ms */
  time: number;
  session: SessionState;
  index: {
    value: number;
    /** 大盤今日累計成交額（億元）。 */
    turnover: number;
    series: IndexPoint[];
  };
  quotes: Record<string, Quote>;
}
