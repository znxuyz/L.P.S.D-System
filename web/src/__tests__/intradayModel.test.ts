import { describe, expect, it } from 'vitest';
import { BARS, HORIZONS, forecastDay, windowVol, type Bar, type DayModel, type IntradayModel } from '../domain/intradayModel';

const zeros = (n: number) => new Array(n).fill(0);
const lin = (k: number, c0 = 0) => ({ mean: zeros(k), sd: new Array(k).fill(1), coef: [c0, ...zeros(k)] });
// 走勢預測全部 0（不會動）、振幅＝時段平均、高低點各 1%
const m: IntradayModel = { mean: zeros(13), sd: new Array(13).fill(1), coef: HORIZONS.map(() => zeros(14)), resid: HORIZONS.map(() => new Array(7).fill(0.5)) };
const base = Array.from({ length: BARS }, (_, b) => Math.log(b < 6 || b > 48 ? 0.004 : 0.002));
const dm: DayModel = { base, rng: lin(7), up: lin(6, 0.01), down: lin(6, 0.01), gap: lin(5, 0.005), gapSd: 0.01 };
const ctx = { prevDay: 0, prev5: 0, prevIntra: 0, futChg: NaN, prevRange: 0.01 };
const day: Bar[] = Array.from({ length: BARS }, (_, b) => [100 + b * 0.1, 100.3 + b * 0.1, 99.9 + b * 0.1, 100.1 + b * 0.1]);

describe('forecastDay', () => {
  it('開盤前：預測跳空、54 根都是預測，區間包含跳空的不確定性', () => {
    const f = forecastDay(m, dm, [], -1, null, 100, ctx);
    expect(f.from).toBe(0);
    expect(f.bars).toHaveLength(BARS);
    expect(f.open).toBeCloseTo(100 * Math.exp(0.005));
    for (const b of f.bars) {
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
      expect(b.hi).toBeGreaterThan(b.c);
    }
    // 開盤時段的振幅比中午大
    const r = (i: number) => Math.log(f.bars[i].h / f.bars[i].l);
    expect(r(0)).toBeGreaterThan(r(25));
    expect(f.dayHigh).toBeCloseTo(f.open * Math.exp(0.01));
  });
  it('盤中：已經走過的用實際值，只預測剩下的', () => {
    const f = forecastDay(m, dm, day, 20, day[0][0], 100, ctx);
    expect(f.from).toBe(20);
    expect(f.bars[0].bar).toBe(20);
    expect(f.bars).toHaveLength(BARS - 20);
    expect(f.bars[0].o).toBeCloseTo(day[19][3]);
    expect(f.dayHigh).toBeGreaterThanOrEqual(Math.max(...day.slice(0, 20).map((b) => b[1])));
    // 區間越往後越寬
    expect(f.bars.at(-1)!.hi - f.bars.at(-1)!.lo).toBeGreaterThan(f.bars[0].hi - f.bars[0].lo);
  });
  it('windowVol：開盤附近同樣長度的波動比較大', () => {
    expect(windowVol(base, 0, 3)).toBeGreaterThan(windowVol(base, 20, 3));
  });
});
