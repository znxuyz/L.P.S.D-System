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

import { knockout, BARS } from '../domain/intradayModel';
describe('knockout（相似日淘汰賽）', () => {
  const ctx = { prevDay: 0, prev5: 0, prevIntra: 0, futChg: 0, prevRange: 0.012 } as unknown as Parameters<typeof knockout>[1];
  const day = (date: string, slope: number) => ({ date, gap: 0, r: Array.from({ length: BARS + 1 }, (_, j) => slope * j), ctx });
  it('偏離的會被淘汰、停在偏離的那一根，至少留 3 條', () => {
    const lib = [day('a', 0), day('b', 0.0001), day('c', -0.0001), day('d', 0.003), day('e', -0.003)];
    const actual = Array.from({ length: 11 }, () => 100);
    const out = knockout(lib, ctx, actual, 5, 0.6, 3);
    const alive = out.filter((l) => l.out == null).map((l) => l.date).sort();
    expect(alive).toEqual(['a', 'b', 'c']);
    expect(out.find((l) => l.date === 'd')!.out).toBeGreaterThan(0);
  });
});

import { limitBand } from '../ui/predictIntraday';
describe('limitBand（漲跌停）', () => {
  it('00631L 昨收 22.50 → 漲停 27.00、跌停 18.00', () => {
    expect(limitBand(22.5, 0.2, 0.01)).toEqual([18, 27]);
  });
  it('漲停往下取到跳動單位、跌停往上取', () => {
    expect(limitBand(21.24, 0.2, 0.01)).toEqual([17, 25.48]);
  });
});
