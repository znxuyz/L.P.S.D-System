import { describe, expect, it } from 'vitest';
import { fillBars, hasGap } from '../data/backfill';
import type { FugleCandleRaw } from '../data/fugle';

const OPEN = Date.UTC(2026, 10, 19, 1, 0, 0); // 台北 09:00
const M = 60_000;
const iso = (min: number) => new Date(OPEN + min * M).toISOString();

describe('hasGap', () => {
  it('開盤後沒有紀錄、或中間斷掉才算缺', () => {
    expect(hasGap([], OPEN, OPEN + 2 * M)).toBe(false);
    expect(hasGap([], OPEN, OPEN + 30 * M)).toBe(true);
    const full = Array.from({ length: 30 }, (_, i) => ({ t: OPEN + (i + 1) * M, byStock: {} }));
    expect(hasGap(full, OPEN, OPEN + 30 * M)).toBe(false);
    expect(hasGap(full.filter((b) => b.t < OPEN + 10 * M || b.t > OPEN + 20 * M), OPEN, OPEN + 30 * M)).toBe(true);
  });
});

describe('fillBars', () => {
  // 每分鐘 100 股 × 10 元
  const candles: FugleCandleRaw[] = Array.from({ length: 10 }, (_, i) => ({ date: iso(i), close: 10 + i, volume: 100 }));

  it('補上缺的分鐘：第 t 分鐘是 t 以前的累計，並用即時成交額校正', () => {
    const bars = fillBars([], new Map([['2330', candles]]), { '2330': 20 }, OPEN, OPEN + 10 * M);
    expect(bars.map((b) => (b.t - OPEN) / M)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bars[0].prices!['2330']).toBe(10);
    expect(bars[9].prices!['2330']).toBe(19);
    // 累計到最後一根＝即時成交額
    expect(bars[9].byStock['2330']).toBeCloseTo(20);
    // 單調遞增
    for (let i = 1; i < bars.length; i++) expect(bars[i].byStock['2330']).toBeGreaterThan(bars[i - 1].byStock['2330']);
  });

  it('已經有的分鐘不動，結果依時間排序', () => {
    const live = [{ t: OPEN + 5 * M, byStock: { '2330': 999 }, prices: { '2330': 1 } }];
    const bars = fillBars(live, new Map([['2330', candles]]), { '2330': 20 }, OPEN, OPEN + 10 * M);
    expect(bars).toHaveLength(10);
    expect(bars.find((b) => b.t === OPEN + 5 * M)!.byStock['2330']).toBe(999);
    expect(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t)).toBe(true);
  });

  it('不會補到最後一根 1 分 K 之後', () => {
    const bars = fillBars([], new Map([['2330', candles.slice(0, 3)]]), {}, OPEN, OPEN + 60 * M);
    expect(bars.at(-1)!.t).toBe(OPEN + 3 * M);
  });
});
