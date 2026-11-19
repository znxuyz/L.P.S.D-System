import { describe, expect, it } from 'vitest';
import { logistic, maxDrawdown, rankCenter, ridge, sigmoid, spearman, standardizer } from '../../../scripts/lib/ml';
import { dayTradeBands, dayTradeCall, type PredictData } from '../data/predict';

describe('ml', () => {
  it('ridge 還原線性關係', () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = Math.sin(i);
      const b = Math.cos(i * 1.7);
      X.push([a, b]);
      y.push(1 + 2 * a - 3 * b);
    }
    const beta = ridge(X, y, 0);
    expect(beta[0]).toBeCloseTo(1, 6);
    expect(beta[1]).toBeCloseTo(2, 6);
    expect(beta[2]).toBeCloseTo(-3, 6);
    // L2 讓係數縮小、截距不受影響
    const shrunk = ridge(X, y, 1);
    expect(Math.abs(shrunk[1])).toBeLessThan(2);
  });

  it('logistic 分得開兩群', () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = (i - 100) / 30;
      X.push([x]);
      y.push(x + Math.sin(i * 7) * 0.5 > 0 ? 1 : 0);
    }
    const beta = logistic(X, y, 0.001);
    expect(beta[1]).toBeGreaterThan(1);
    expect(sigmoid(beta[0] + beta[1] * 2)).toBeGreaterThan(0.9);
    expect(sigmoid(beta[0] + beta[1] * -2)).toBeLessThan(0.1);
  });

  it('排名、Spearman、標準化、最大回落', () => {
    expect([...rankCenter([3, 1, 2, NaN])]).toEqual([0.5, -0.5, 0, 0]);
    const a = Array.from({ length: 20 }, (_, i) => i);
    expect(spearman(a, a.map((v) => v * v))).toBeCloseTo(1);
    expect(spearman(a, a.map((v) => -v))).toBeCloseTo(-1);
    const st = standardizer([[1], [2], [3]]);
    expect(st.apply([2])[0]).toBeCloseTo(0);
    expect(st.apply([NaN])[0]).toBe(0);
    expect(maxDrawdown([1, 1.2, 0.9, 1.3])).toBeCloseTo(-0.25);
  });
});

describe('00631L 當沖換算', () => {
  const d = { lastClose: 100, cost: 0.003, rule: { a: 0, b: 0.005, gapMean: 0, gapSd: 0.01 } } as NonNullable<PredictData['dayTrade']>;
  it('跳空越大預測越高，超過成本才出手', () => {
    expect(dayTradeCall(d, 100).action).toBe(0);
    expect(dayTradeCall(d, 101).action).toBe(1); // z = 1 → 0.5% > 0.3%
    expect(dayTradeCall(d, 99).action).toBe(-1);
  });
  it('換算成開盤價門檻', () => {
    const b = dayTradeBands(d);
    expect(b.long).toBe('≥ 100.60');
    expect(b.short).toBe('≤ 99.40');
  });
});
