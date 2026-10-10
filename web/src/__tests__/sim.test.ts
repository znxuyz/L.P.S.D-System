import { describe, expect, it } from 'vitest';
import type { Candle } from '../domain/technicals';
import { SESSION_MINUTES, intradayPath, roundTick, tickSize } from '../domain/intraday';
import {
  MARGIN_LOAN,
  SHORT_DEPOSIT,
  beginDay,
  buildMarket,
  cancelOrder,
  closeDay,
  equityOf,
  feeOf,
  lockedLimit,
  migrate,
  newSim,
  placeOrder,
  priceNow,
  summarize,
  taxOf,
  tickTo,
} from '../domain/sim';

const bar = (date: string, open: number, high: number, low: number, close: number, volume = 1000): Candle => ({ date, open, high, low, close, volume });
const D = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];

function setup(rows: Candle[], ex: Parameters<typeof buildMarket>[1] = [], capital = 1_000_000) {
  const m = buildMarket(new Map([['2330', rows]]), ex);
  const s = newSim({ start: rows[0].date, capital, discount: 1 });
  return { m, s };
}

describe('偽即時盤中路徑', () => {
  it('開盤＝開盤價、收盤＝收盤價，碰得到高低且不超出，價格符合升降單位', () => {
    const p = intradayPath('2330', '2024-01-02', { open: 593, high: 600, low: 585, close: 598, volume: 30000 });
    expect(p.price[0]).toBe(593);
    expect(p.price[SESSION_MINUTES]).toBe(598);
    const arr = [...p.price];
    expect(Math.max(...arr)).toBe(600);
    expect(Math.min(...arr)).toBe(585);
    for (const v of arr) expect(Math.abs(v - roundTick(v)) < 1e-9).toBe(true);
    expect(p.cumVolume[SESSION_MINUTES]).toBeCloseTo(30000);
  });
  it('同一檔同一天每次都一樣；一價到底是一直線', () => {
    const b = { open: 50, high: 52, low: 49, close: 51, volume: 100 };
    expect([...intradayPath('1101', '2024-01-02', b).price]).toEqual([...intradayPath('1101', '2024-01-02', b).price]);
    const flat = intradayPath('1101', '2024-01-02', { open: 55, high: 55, low: 55, close: 55, volume: 10 });
    expect(new Set(flat.price).size).toBe(1);
  });
  it('升降單位', () => {
    expect(tickSize(9.5)).toBe(0.01);
    expect(tickSize(49)).toBe(0.05);
    expect(tickSize(99)).toBe(0.1);
    expect(tickSize(499)).toBe(0.5);
    expect(tickSize(999)).toBe(1);
    expect(tickSize(1000)).toBe(5);
    expect(tickSize(120, true)).toBe(0.05);
  });
});

describe('模擬盤交易', () => {
  it('手續費與證交稅（當沖減半）', () => {
    expect(feeOf(100_000, 1, 1000)).toBe(142);
    expect(feeOf(1000, 1, 10)).toBe(1);
    expect(taxOf(100_000, '2330')).toBe(300);
    expect(taxOf(100_000, '2330', true)).toBe(150);
    expect(taxOf(100_000, '0050', true)).toBe(100);
  });

  it('市價單用當下價格立刻成交，賣出算實現損益', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 110, 110, 110, 110)]);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 })).toBeNull();
    expect(s.trades[0]).toMatchObject({ price: 100, fee: 142 });
    expect(s.cash).toBe(1_000_000 - 100_142);
    closeDay(s, m);
    expect(s.equity.at(-1)).toEqual([D[0], 1_000_000 - 142]);
    beginDay(s, m, D[1]);
    placeOrder(s, m, { code: '2330', side: 'sell', kind: 'cash', shares: 1000 });
    expect(s.trades[1].pnl).toBe(110_000 - 156 - 330 - 100_142);
    expect(summarize(s, m).wins).toBe(1);
    expect(placeOrder(s, m, { code: '2330', side: 'sell', kind: 'cash', shares: 1000 })).toMatch(/不足/);
  });

  it('限價單在價格碰到時成交，收盤沒碰到就取消', () => {
    const { m, s } = setup([bar(D[0], 100, 104, 96, 101)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000, limit: 96 });
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000, limit: 90 });
    expect(s.orders).toHaveLength(2);
    tickTo(s, m, SESSION_MINUTES);
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0].price).toBe(96);
    closeDay(s, m);
    expect(s.orders).toHaveLength(0);
    expect(s.notes.at(-1)!.text).toMatch(/未成交/);
  });

  it('一價漲停買不到、收盤後不能下單、可以撤單', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 110, 110, 110, 110), bar(D[2], 100, 105, 99, 104)]);
    expect(lockedLimit(bar(D[1], 110, 110, 110, 110), 100)).toBe(1);
    closeDay(s, m);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 })).toMatch(/收盤/);
    beginDay(s, m, D[1]);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 })).toMatch(/漲停/);
    closeDay(s, m);
    beginDay(s, m, D[2]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000, limit: 90 });
    cancelOrder(s, s.orders[0].id);
    expect(s.orders).toHaveLength(0);
  });

  it('當沖：先賣後買，稅減半；沒沖銷的收盤自動沖銷', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100)]);
    placeOrder(s, m, { code: '2330', side: 'sell', kind: 'day', shares: 1000 });
    expect(s.trades[0].tax).toBe(150);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'day', shares: 1000 });
    expect(s.pos).toHaveLength(0);
    expect(s.trades[1].pnl).toBe(100_000 - 142 - 150 - 100_142);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'day', shares: 2000 });
    closeDay(s, m);
    expect(s.pos).toHaveLength(0);
    expect(s.notes.some((n) => /自動賣出/.test(n.text))).toBe(true);
  });

  it('融資：自備四成，賣出還款並扣利息', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 120, 120, 120, 120)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'margin', shares: 1000 });
    expect(s.cash).toBe(1_000_000 - 100_000 * (1 - MARGIN_LOAN) - 142);
    expect(s.pos[0].loan).toBe(60_000);
    closeDay(s, m);
    expect(s.pos[0].interest).toBeGreaterThan(0);
    beginDay(s, m, D[1]);
    placeOrder(s, m, { code: '2330', side: 'sell', kind: 'margin', shares: 1000 });
    expect(s.pos).toHaveLength(0);
    expect(s.trades[1].pnl).toBeGreaterThan(19_000);
  });

  it('融券：繳九成保證金，跌了回補賺錢；融券要付現金股利', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 90, 90, 90, 90)], [[D[1], '2330', 100, 95, 5, '息']]);
    placeOrder(s, m, { code: '2330', side: 'sell', kind: 'short', shares: 1000 });
    expect(s.cash).toBe(1_000_000 - 100_000 * SHORT_DEPOSIT);
    closeDay(s, m);
    const before = s.cash;
    beginDay(s, m, D[1]);
    expect(s.cash).toBe(before - 5000);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'short', shares: 1000 });
    expect(s.pos).toHaveLength(0);
    expect(s.trades[1].pnl).toBeGreaterThan(9000);
  });

  it('維持率低於 120% 收盤強制了結', () => {
    const { m, s } = setup([bar(D[0], 100, 100, 100, 100), bar(D[1], 60, 60, 60, 60)], [], 100_000);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'margin', shares: 2000 });
    closeDay(s, m);
    beginDay(s, m, D[1]);
    closeDay(s, m);
    expect(s.pos).toHaveLength(0);
    expect(s.notes.some((n) => /斷頭/.test(n.text))).toBe(true);
  });

  it('現金不足不能下單；總資產跟著盤中價格變動', () => {
    const { m, s } = setup([bar(D[0], 100, 110, 95, 105)]);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 20_000 })).toMatch(/現金不足/);
    expect(placeOrder(s, m, { code: '9999', side: 'buy', kind: 'cash', shares: 1000 })).toMatch(/沒有交易/);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 });
    tickTo(s, m, 120);
    expect(equityOf(s, m)).toBeCloseTo(s.cash + 1000 * priceNow(s, m, '2330')!);
  });

  it('舊版存檔轉換', () => {
    const v1 = { v: 1, settings: { start: D[0], capital: 1e6, discount: 1 }, date: D[1], cash: 900_000, holdings: { '2330': { shares: 1000, cost: 100_142 } }, orders: [], trades: [{ date: D[1], code: '2330', side: 'buy', shares: 1000, price: 100, fee: 142, tax: 0 }], notes: [], equity: [[D[0], 1e6], [D[1], 1e6]], nextId: 2, watch: '2330' };
    const s = migrate(v1)!;
    expect(s.v).toBe(2);
    expect(s.minute).toBe(SESSION_MINUTES);
    expect(s.pos[0]).toMatchObject({ code: '2330', kind: 'cash', dir: 'long', shares: 1000 });
    expect(s.trades[0].day).toBe(2);
  });
});
