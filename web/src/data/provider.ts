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
