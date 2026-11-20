import { describe, expect, it } from 'vitest';
import { dailyForecast, dailyVol, type StockCalib } from '../domain/stockForecast';

const calib: StockCalib = {
  deciles: Array.from({ length: 10 }, (_, k) => ({ decile: k + 1, n: 100, avg: (k - 4.5) / 100, excess: 0, beat: 0.5 })),
  zq: { p10: -1.2, p50: 0, p90: 1.25 },
  coverage: [],
  horizon: 21,
};
const closes = Array.from({ length: 100 }, (_, i) => 100 * Math.exp(0.01 * (i % 2 ? 1 : -1)));

describe('個股日 K 預測', () => {
  it('波動', () => {
    expect(dailyVol(closes)).toBeGreaterThan(0.015);
    expect(dailyVol([1, 2, 3])).toBeNaN();
  });
  it('分數決定中線、區間隨時間變寬', () => {
    const top = dailyForecast(closes, 95, calib);
    const bot = dailyForecast(closes, 5, calib);
    expect(top.decile).toBe(9);
    expect(top.path).toHaveLength(21);
    expect(top.path[20].mid).toBeGreaterThan(bot.path[20].mid);
    expect(top.path[20].hi - top.path[20].lo).toBeGreaterThan(top.path[0].hi - top.path[0].lo);
    expect(top.path[20].mid / closes[99] - 1).toBeCloseTo(0.045, 6);
  });
  it('不在可選範圍用全部平均', () => {
    expect(dailyForecast(closes, null, calib).avg).toBeCloseTo(0, 6);
  });
});
