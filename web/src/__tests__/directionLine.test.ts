import { describe, expect, it } from 'vitest';
import { directionLine } from '../domain/intradayModel';
import { directionPath } from '../domain/stockForecast';

describe('directionLine（盤中方向預測）', () => {
  const L = (end: number) => ({ date: 'x', closes: [100, (100 + end) / 2, end] });
  it('綜合預測往上 → 用最後也往上的相似日平均（不會是平線）', () => {
    const out = directionLine([L(103), L(97), L(102), L(104), L(96)], [100, 100.1, 100.2], 100);
    expect(out.at(-1)!).toBeGreaterThan(102);
  });
  it('綜合預測往下但同方向的相似日不夠 → 鏡射全部平均，一定往下', () => {
    const out = directionLine([L(103), L(104), L(102), L(99)], [100, 99.9, 99.8], 100);
    expect(out.at(-1)!).toBeLessThan(100);
  });
});

describe('directionPath（日 K 方向預測）', () => {
  it('方向跟相似走勢平均一致，幅度用同方向那幾段', () => {
    const lines = [{ at: 1, path: [0.01, 0.05] }, { at: 2, path: [0, -0.02] }, { at: 3, path: [0.02, 0.07] }];
    const out = directionPath({ lines, avg: [0.01, 0.0333] });
    expect(out[1]).toBeCloseTo(0.06, 5);
  });
  it('同方向不到 2 段 → 鏡射平均', () => {
    const out = directionPath({ lines: [{ at: 1, path: [0, 0.03] }, { at: 2, path: [0, -0.01] }], avg: [0, -0.001] });
    expect(out[1]).toBeLessThanOrEqual(0);
  });
});

describe('directionLine 幅度（endSize）', () => {
  it('終點落在指定幅度、方向不變', () => {
    const L2 = (end: number) => ({ date: 'x', closes: [100, (100 + end) / 2, end] });
    const out = directionLine([L2(90), L2(88), L2(91)], [100, 99, 98], 100, 7, 0.02);
    expect(Math.log(out.at(-1)! / 100)).toBeCloseTo(-0.02, 6);
  });
});
