import { describe, expect, it } from 'vitest';
import { baselineFor, currentRegime, regimeView, type PatternStats } from '../data/patternStats';

const series = (closes: number[]) => new Map(closes.map((c, i) => [`d${String(i).padStart(4, '0')}`, c]));

describe('大盤行情分組', () => {
  it('收盤在 120 日均線之上是多頭、之下是空頭，資料不足回傳 null', () => {
    expect(currentRegime(series(Array.from({ length: 119 }, () => 100)))).toBeNull();
    expect(currentRegime(series([...Array.from({ length: 119 }, () => 100), 110]))).toBe('bull');
    expect(currentRegime(series([...Array.from({ length: 119 }, () => 100), 90]))).toBe('bear');
    // 只看最近 120 天
    expect(currentRegime(series([...Array.from({ length: 50 }, () => 1000), ...Array.from({ length: 119 }, () => 100), 101]))).toBe('bull');
  });

  it('regimeView 換成該行情的基準與勝率', () => {
    const st: PatternStats = {
      generatedAt: '', from: '', to: '', stocks: 1, horizon: 20, candleHorizon: 5,
      baseline: { up20: 0.5, up5: 0.5 },
      patterns: { 'channel|bull': { n: 100, win: 0.5, avg: 1 } },
      candles: {},
      regimes: {
        rule: '',
        bear: { days: 10, baseline: { up20: 0.4, up5: 0.45 }, patterns: { 'channel|bull': { n: 50, win: 0.42, avg: 0.2 } }, candles: {} },
      },
    };
    const v = regimeView(st, 'bear')!;
    expect(v.patterns['channel|bull'].win).toBe(0.42);
    expect(baselineFor(v, 'bull')).toBe(0.4);
    expect(baselineFor(v, 'bear')).toBeCloseTo(0.6);
    expect(regimeView(st, 'bull')).toBeNull();
  });
});
