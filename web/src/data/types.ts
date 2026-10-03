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

/**
 * 選股用的基本面、籌碼與技術資料（低頻，盤前更新一次）。
 * 和股價有關的指標（本益比、殖利率、股價位階）由即時股價搭配這裡的數字計算。
 */
export interface Fundamentals {
  /** 近四季 EPS（元）。 */
  eps4q: number;
  /** 近四季 EPS 年增率（%）。 */
  epsYoY: number;
  /** 最近一年現金股利（元）。 */
  dividend: number;
  /** 股利發放率（%）。 */
  payoutRatio: number;
  /** 連續配息年數。 */
  dividendYears: number;
  /** 近一年自由現金流為正。 */
  fcfPositive: boolean;
  /** 毛利率年變化（百分點）。 */
  grossMarginChg: number;
  /** 營益率年變化（百分點）。 */
  opMarginChg: number;
  /** 近 3 年最低 / 最高價。 */
  low3y: number;
  high3y: number;
  /** 近一年最高價。 */
  high52w: number;
  /** 近 20 日最高價（不含今日）。 */
  high20: number;
  /** 5、20、60 日均線。 */
  ma5: number;
  ma20: number;
  ma60: number;
  /** 法人（外資＋投信）連續買超天數；負數為連續賣超。 */
  instBuyDays: number;
  /** 千張大戶持股比率近 4 週變化（百分點）。 */
  bigHolderChg: number;
  /** 特殊事件標籤。 */
  events: StockEvent[];
}

export type StockEvent = 'guidance-up' | 'merger' | 'subsidy';

export interface StockMeta {
  code: string;
  name: string;
  industryId: IndustryId;
  /** 以昨收計算的市值（億元）。版面依此配置面積。 */
  marketCap: number;
  /** 近 20 日平均每日成交額（億元），資金流的基準線。 */
  avgTurnover20: number;
  prevClose: number;
  /** 選股資料；資料來源不支援時可省略。 */
  fundamentals?: Fundamentals;
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

/** 某一分鐘結束時，各股票的累計成交額（億元）與股價。 */
export interface TurnoverBar {
  /** epoch ms */
  t: number;
  byStock: Record<string, number>;
  /** 當時的股價；資料來源不支援時可省略。 */
  prices?: Record<string, number>;
}

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
  /** 盤中每分鐘的累計成交額，用來看資金輪動；資料來源不支援時可省略。 */
  turnoverHistory?: TurnoverBar[];
}
