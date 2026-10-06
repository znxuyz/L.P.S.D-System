import type { DailySeries } from './candles';
import type { MarketSnapshot, Universe } from './types';

/**
 * 行情資料來源的共同介面。
 *
 * - loadUniverse：產業分類、股票基本資料、市值、20 日均量等低頻資料。
 * - subscribe：盤中即時快照，每次更新都推送完整的 MarketSnapshot。
 *
 * 之後接富果或證交所時，只要各自實作這個介面，UI 不需要修改。
 */
export interface MarketDataProvider {
  loadUniverse(): Promise<Universe>;
  subscribe(listener: (snapshot: MarketSnapshot) => void): () => void;
  /** 個股的日 K（個股分析頁用）；不支援時可省略。 */
  dailyCandles?(code: string, prevClose?: number): Promise<DailySeries>;
  /**
   * 股票池以外的股票（個股分析頁查全市場時）的即時報價；不支援時省略。
   * market 用來決定證交所 MIS 的查詢代號（上市 tse / 上櫃 otc）。
   */
  extraQuote?(code: string, market?: 'tse' | 'otc'): Promise<import('./types').Quote & { prevClose?: number } | null>;
}

/** 可重播的資料來源（mock）額外提供的播放控制。 */
export interface PlaybackControl {
  readonly speed: number;
  readonly paused: boolean;
  setSpeed(multiplier: number): void;
  pause(): void;
  resume(): void;
  restart(): void;
}
