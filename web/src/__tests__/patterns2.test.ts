import { describe, expect, it } from 'vitest';
import { detectCandles } from '../domain/candlesticks';
import { detectPatterns } from '../domain/patterns';
import type { Candle } from '../domain/technicals';

const day = (k: number) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10);
function series(path: number[]): Candle[] {
  return path.map((close, k) => ({ date: day(k), open: close, high: close * 1.005, low: close * 0.995, close, volume: 1000 }));
}
function legs(points: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let k = 1; k < points.length; k++) {
    const [n, to] = points[k];
    const from = points[k - 1][1];
    for (let j = 0; j < n; j++) out.push(from + ((to - from) * (j + 1)) / n);
  }
  return out;
}
const ids = (c: Candle[]) => detectPatterns(c).patterns.map((p) => p.id);

describe('K 棒訊號', () => {
  const down = series(legs([[0, 120], [20, 100]]));
  it('下跌後的錘子線', () => {
    const c = [...down, { date: day(30), open: 98, high: 99.3, low: 94, close: 99.2, volume: 1000 }];
    expect(detectCandles(c).at(-1)?.name).toBe('錘子線');
  });
  it('下跌後的多頭吞噬', () => {
    const c = [...down, { date: day(30), open: 100, high: 100.2, low: 97.8, close: 98, volume: 1000 }, { date: day(31), open: 97.5, high: 101.5, low: 97.4, close: 101.2, volume: 1000 }];
    expect(detectCandles(c).at(-1)?.name).toBe('多頭吞噬');
  });
  it('晨星', () => {
    const c = [
      ...down,
      { date: day(30), open: 100, high: 100.2, low: 95.8, close: 96, volume: 1000 },
      { date: day(31), open: 95.5, high: 95.9, low: 94.8, close: 95.3, volume: 1000 },
      { date: day(32), open: 95.6, high: 99.5, low: 95.5, close: 99.2, volume: 1000 },
    ];
    expect(detectCandles(c).at(-1)?.name).toBe('晨星');
  });
});

describe('更多型態與輔助線', () => {
  it('上升旗形', () => {
    const c = series([...legs([[0, 100], [30, 101], [8, 125]]), ...legs([[0, 125], [5, 121], [5, 124], [4, 122]])]);
    expect(ids(c)).toContain('flag');
  });
  it('費波納契、分價量表、布林、扣抵都會產生', () => {
    const c = series(legs([[0, 100], [60, 140], [40, 120]]));
    const got = ids(c);
    for (const id of ['fib', 'vprofile', 'boll', 'deduct'] as const) expect(got).toContain(id);
    const vp = detectPatterns(c).patterns.find((p) => p.id === 'vprofile')!;
    expect(vp.hbars!.filter((b) => b.poc)).toHaveLength(1);
  });
  it('三重底', () => {
    const c = series(legs([[0, 130], [15, 100], [10, 115], [10, 101], [10, 116], [10, 100.5], [12, 120]]));
    expect(ids(c)).toContain('triple');
  });
  it('圓弧底', () => {
    const path = Array.from({ length: 120 }, (_, k) => 100 + 0.006 * (k - 60) ** 2);
    expect(ids(series(path))).toContain('rounding');
  });
});
