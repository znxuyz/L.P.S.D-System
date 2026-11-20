import { describe, expect, it } from 'vitest';
import { BARS, HORIZONS, forecastDay, windowVol, type Bar, type DayModel, type IntradayModel } from '../domain/intradayModel';

const zeros = (n: number) => new Array(n).fill(0);
const lin = (k: number, c0 = 0) => ({ mean: zeros(k), sd: new Array(k).fill(1), coef: [c0, ...zeros(k)] });
// 走勢預測全部 0（不會動）、振幅＝時段平均、高低點各 1%
const m: IntradayModel = { mean: zeros(16), sd: new Array(16).fill(1), coef: HORIZONS.map(() => zeros(17)), resid: HORIZONS.map(() => new Array(7).fill(0.5)) };
const base = Array.from({ length: BARS }, (_, b) => Math.log(b < 6 || b > 48 ? 0.004 : 0.002));
const dm: DayModel = { base, rng: lin(7), up: lin(6, 0.01), down: lin(6, 0.01), gap: lin(8, 0.005), gapSd: 0.01 };
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

import { simulateRange, type RangeLevels } from '../domain/intradayModel';

describe('simulateRange（進出場模擬）', () => {
  const flat = (p: number): Bar => [p, p, p, p];
  const mk = (bars: Array<[number, Bar]>) => {
    const ix: Bar[] = Array.from({ length: BARS }, () => flat(100));
    for (const [i, b] of bars) ix[i] = b;
    return ix;
  };
  const lv: RangeLevels = { k: 6, now: 100, buy: 99, buyTarget: 100, buyStop: 98, short: 101, shortTarget: 100, shortStop: 102 };
  it('跌到買進點成交，之後回到停利出場', () => {
    const r = simulateRange(mk([[10, [100, 100, 98.9, 99]], [12, [99, 100.2, 99, 100]]]), lv);
    expect(r.side).toBe(1);
    expect(r.how).toBe('target');
    expect(r.exit).toBe(100);
  });
  it('成交那一根就跌破停損：保守算停損', () => {
    const r = simulateRange(mk([[10, [100, 100, 97.5, 98]]]), lv);
    expect(r.how).toBe('stop');
    expect(r.exit).toBe(98);
  });
  it('漲到放空點成交、收盤還沒碰到停利停損就收盤出場', () => {
    const r = simulateRange(mk([[10, [100, 101.2, 100, 101]], ...Array.from({ length: 43 }, (_, i) => [11 + i, flat(100.5)] as [number, Bar])]), lv);
    expect(r.side).toBe(-1);
    expect(r.how).toBe('close');
    expect(r.ret).toBeCloseTo(-Math.log(100.5 / 101));
  });
  it('設定時間之前的 K 棒不算；兩邊都沒碰到就不交易', () => {
    expect(simulateRange(mk([[3, [100, 100, 90, 95]]]), lv).side).toBe(0);
  });
});

import { DISC_SLOTS, FEATURE_NAMES, RAW_NAMES, discCandidates, discName, discValue, features, predictAt, rawBlocks } from '../domain/intradayModel';

describe('自創指標', () => {
  const c = Array.from({ length: BARS + 1 }, (_, i) => 100 + Math.sin(i / 5));
  const ctx = { prevDay: 0.01, prev5: 0.02, prevIntra: -0.003, futChg: 0.5, prevRange: 0.012, usSox: 0.02, usTsm: 0.01, usSpx: 0.005, night: 0.004, usVix: -0.05, nightRange: 0.008, nightPos: 0.9 };
  it('原始數據與名稱數量一致，特徵多出固定的自創欄位', () => {
    expect(rawBlocks(c, 10, 99, ctx)).toHaveLength(RAW_NAMES.length);
    expect(features(c, 10, 99, ctx)).toHaveLength(FEATURE_NAMES.length);
    expect(features(c, 10, 99, ctx).slice(-DISC_SLOTS)).toEqual([0, 0, 0, 0]);
  });
  it('組合方式', () => {
    const raw = [2, -3];
    expect(discValue(raw, { a: 0, b: 1, op: 0 })).toBe(-6);
    expect(discValue(raw, { a: 0, b: 1, op: 1 })).toBe(6);
    expect(discValue(raw, { a: 0, b: 1, op: 2 })).toBe(-2);
    expect(discValue(raw, { a: 1, b: 1, op: 3 })).toBe(-3);
    expect(discName({ a: 17, b: 1, op: 0 })).toBe('夜盤振幅 × 開盤跳空');
  });
  it('候選不重複', () => {
    const all = discCandidates();
    expect(new Set(all.map((s) => `${s.a},${s.b},${s.op}`)).size).toBe(all.length);
  });
  it('模型帶自創指標時會用到（開盤前就知道的夜盤位置）', () => {
    const n = FEATURE_NAMES.length;
    const disc = [{ a: 18, b: 18, op: 3 as const }];
    const coef = HORIZONS.map(() => [0, ...new Array(n - DISC_SLOTS).fill(0), 1, 0, 0, 0]);
    const m: IntradayModel = { mean: new Array(n).fill(0), sd: new Array(n).fill(1), coef, resid: [], disc };
    expect(predictAt(m, c, 5, 99, ctx)[0]).toBeCloseTo(0.4, 6);
    expect(predictAt({ ...m, disc: [] }, c, 5, 99, ctx)[0]).toBe(0);
  });
});

import * as IM from '../domain/intradayModel';
describe('切換 K 線時間單位', () => {
  it('預測長度以分鐘換算成根數，切回 5 分 K 不變', () => {
    IM.setTimeframe(1);
    expect(IM.BARS).toBe(270);
    expect(IM.HORIZONS).toEqual([5, 10, 15, 30, 60, 270]);
    expect(IM.timeBucket(46)).toBe(2);
    IM.setTimeframe(3);
    expect(IM.BARS).toBe(90);
    expect(IM.HORIZONS).toEqual([2, 3, 5, 10, 20, 90]);
    IM.setTimeframe(5);
    expect(IM.BARS).toBe(54);
    expect(IM.HORIZONS).toEqual([1, 2, 3, 6, 12, 54]);
    expect(IM.timeBucket(10)).toBe(2);
  });
});
