import { describe, expect, it } from 'vitest';
import { detectPatterns, zigzag } from '../domain/patterns';
import type { Candle } from '../domain/technicals';

/** 由收盤價路徑產生日 K（高低各 ±0.5%）。 */
function candles(path: number[]): Candle[] {
  return path.map((close, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1000,
  }));
}

/** 在幾個關鍵價位之間線性插值。 */
function legs(points: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let k = 1; k < points.length; k++) {
    const [n, to] = points[k];
    const from = points[k - 1][1];
    for (let j = 0; j < n; j++) out.push(from + ((to - from) * (j + 1)) / n);
  }
  return out;
}

describe('zigzag', () => {
  it('找出交錯的高低點', () => {
    const p = zigzag(candles(legs([[0, 100], [10, 120], [10, 100], [10, 125]])), 0.05);
    expect(p.map((x) => x.kind)).toEqual(['L', 'H', 'L', 'H']);
    expect(p.at(-1)!.tentative).toBe(true);
  });
});

describe('detectPatterns', () => {
  it('W 底突破頸線', () => {
    // 下跌 → 左腳 100 → 反彈 115 → 右腳 101 → 突破 120
    const c = candles(legs([[0, 130], [20, 100], [12, 115], [12, 101], [15, 122]]));
    const w = detectPatterns(c).patterns.find((p) => p.id === 'double-bottom');
    expect(w).toBeTruthy();
    expect(w!.status).toContain('已確認');
    expect(w!.scenarios[0].when).toContain('頸線');
  });

  it('M 頭跌破頸線', () => {
    const c = candles(legs([[0, 80], [20, 110], [12, 96], [12, 109], [15, 90]]));
    const m = detectPatterns(c).patterns.find((p) => p.id === 'double-top');
    expect(m?.status).toContain('已確認');
    expect(m?.bias).toBe('bear');
  });

  it('上升通道', () => {
    const path = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + (i % 10 < 5 ? 2 : -2));
    const ch = detectPatterns(candles(path)).patterns.find((p) => p.id === 'channel');
    expect(ch?.name).toBe('上升通道');
  });

  it('上漲推動浪', () => {
    const c = candles(legs([[0, 100], [10, 120], [8, 110], [15, 150], [8, 138], [10, 160]]));
    const w = detectPatterns(c).patterns.find((p) => p.id === 'wave');
    expect(w).toBeTruthy();
    expect(w!.status).toBe('可能在第 5 浪');
  });
});

describe('缺口與量價', () => {
  it('找出未回補與已回補的缺口', () => {
    const c = candles(legs([[0, 100], [20, 102]]));
    // 第 21 天向上跳空到 110，之後一路在 110 以上 → 未回補
    for (let k = 0; k < 10; k++) c.push({ ...c[c.length - 1], date: `2026-03-${String(k + 1).padStart(2, '0')}`, open: 110 + k, high: 111 + k, low: 109.5 + k, close: 110.5 + k, volume: k === 0 ? 4000 : 1000 });
    const p = detectPatterns(c).patterns.find((x) => x.id === 'gap');
    expect(p?.zones?.length).toBe(1);
    expect(p!.zones![0].lo).toBeCloseTo(102 * 1.005, 1);
    expect(p!.status).toBe('1 個未回補');
  });

  it('爆量長紅標記', () => {
    const c = candles(Array.from({ length: 60 }, (_, i) => 100 + (i % 5)));
    const lastC = c[c.length - 1];
    c.push({ date: '2026-03-20', open: lastC.close, high: lastC.close * 1.07, low: lastC.close * 0.99, close: lastC.close * 1.06, volume: 5000 });
    const v = detectPatterns(c).patterns.find((x) => x.id === 'volume');
    expect(v?.points.some((pt) => pt.label === '長紅')).toBe(true);
    expect(v?.summary).toContain('爆量長紅');
  });
});
