import { describe, expect, it } from 'vitest';
import type { Candle } from '../domain/technicals';
import { advance, buildMarket, cancelOrder, feeOf, lockedLimit, newSim, placeOrder, summarize, taxOf } from '../domain/sim';

const bar = (date: string, open: number, high: number, low: number, close: number): Candle => ({ date, open, high, low, close, volume: 1000 });
const D = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];

function setup(rows: Candle[], ex: Parameters<typeof buildMarket>[1] = []) {
  const m = buildMarket(new Map([['2330', rows]]), ex);
  const s = newSim({ start: D[0], capital: 1_000_000, discount: 1 }, D[0]);
  return { m, s };
}

describe('模擬盤', () => {
  it('手續費與證交稅', () => {
    expect(feeOf(100_000, 1, 1000)).toBe(142);
    expect(feeOf(1000, 1, 1000)).toBe(20);
    expect(feeOf(1000, 1, 10)).toBe(1);
    expect(taxOf(100_000, '2330')).toBe(300);
    expect(taxOf(100_000, '0050')).toBe(100);
  });

  it('市價單隔天開盤成交，賣出算實現損益', () => {
    const { m, s } = setup([bar(D[0], 100, 101, 99, 100), bar(D[1], 102, 105, 101, 104), bar(D[2], 110, 112, 108, 111)]);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000 })).toBeNull();
    advance(s, m, D[1]);
    expect(s.trades[0]).toMatchObject({ price: 102, fee: 145 });
    expect(s.cash).toBe(1_000_000 - 102_000 - 145);
    expect(s.equity.at(-1)![1]).toBe(Math.round(1_000_000 - 102_145 + 104_000));
    expect(placeOrder(s, m, { code: '2330', side: 'sell', shares: 2000 })).toMatch(/不足/);
    placeOrder(s, m, { code: '2330', side: 'sell', shares: 1000 });
    advance(s, m, D[2]);
    expect(s.holdings['2330']).toBeUndefined();
    const t = s.trades[1];
    expect(t.pnl).toBe(110_000 - 156 - 330 - 102_145);
    expect(summarize(s, m).wins).toBe(1);
  });

  it('限價單沒碰到就取消，碰到用較有利的開盤價', () => {
    const { m, s } = setup([bar(D[0], 100, 101, 99, 100), bar(D[1], 98, 99, 97, 98), bar(D[2], 95, 96, 94, 95)]);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000, limit: 96 });
    advance(s, m, D[1]);
    expect(s.trades).toHaveLength(0);
    expect(s.notes[0].text).toMatch(/沒碰到/);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000, limit: 97 });
    advance(s, m, D[2]);
    expect(s.trades[0].price).toBe(95);
  });

  it('一價漲停買不到、沒資料取消、可以撤單', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 110, 110, 110, 110)]);
    expect(lockedLimit(bar(D[1], 110, 110, 110, 110), 100)).toBe(1);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000 });
    advance(s, m, D[1]);
    expect(s.trades).toHaveLength(0);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000 });
    advance(s, m, D[2]);
    expect(s.notes.at(-1)!.text).toMatch(/沒有成交資料/);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 1000 });
    cancelOrder(s, s.orders[0].id);
    expect(s.orders).toHaveLength(0);
  });

  it('除息入帳、除權配股', () => {
    const rows = [bar(D[0], 100, 100, 100, 100), bar(D[1], 100, 100, 100, 100), bar(D[2], 95, 96, 94, 95), bar(D[3], 90, 91, 89, 90)];
    const { m, s } = setup(rows, [
      [D[2], '2330', 100, 95, 5, '息'],
      [D[3], '2330', 95, 86.36, 8.64, '權'],
    ]);
    placeOrder(s, m, { code: '2330', side: 'buy', shares: 2000 });
    advance(s, m, D[1]);
    const cash = s.cash;
    advance(s, m, D[2]);
    expect(s.cash).toBe(cash + 10_000);
    advance(s, m, D[3]);
    expect(s.holdings['2330'].shares).toBe(2000 + Math.floor(2000 * (95 / 86.36 - 1)));
  });

  it('現金不足不能下單', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100)]);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', shares: 10_000 })).toMatch(/現金不足/);
    expect(placeOrder(s, m, { code: '9999', side: 'buy', shares: 1000 })).toMatch(/沒有成交資料/);
  });
});
