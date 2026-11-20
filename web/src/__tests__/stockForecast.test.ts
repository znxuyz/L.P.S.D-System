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

import { analogBacktest, analogForecast } from '../domain/stockForecast';
describe('相似走勢預測線', () => {
  // 週期 40 天的正弦走勢：最像的過去時段之後的走勢應該跟真實的一樣
  const cyc = Array.from({ length: 600 }, (_, i) => 100 * Math.exp(0.1 * Math.sin((2 * Math.PI * i) / 40) + 0.002 * Math.sin(i * 1.7)));
  it('只用結果已經揭曉的時段，平均線抓得到週期', () => {
    const end = 500;
    const f = analogForecast(cyc, end)!;
    expect(f.lines.length).toBeGreaterThan(0);
    for (const l of f.lines) expect(l.at + 21).toBeLessThanOrEqual(end);
    const act = Math.log(cyc[end + 10] / cyc[end]);
    expect(Math.sign(f.avg[9])).toBe(Math.sign(act));
  });
  it('回測：週期走勢的方向命中率高、誤差比不會動小', () => {
    const b = analogBacktest(cyc)!;
    expect(b.hit).toBeGreaterThan(0.8);
    expect(b.rmse).toBeLessThan(b.rmseFlat);
  });
});
