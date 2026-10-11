import { describe, expect, it } from 'vitest';
import type { Candle } from '../domain/technicals';
import {
  LOAN_LIMIT,
  annuity,
  beginDay,
  benchValue,
  buildMarket,
  closeDay,
  debtOf,
  equityOf,
  investedOf,
  migrate,
  newSim,
  openDay,
  placeOrder,
  pledgeBorrow,
  pledgeRatio,
  pledgeRelease,
  pledgeRepay,
  priceNow,
  repayLoan,
  setDca,
  setStop,
  summarize,
  toggleFav,
  takeLoan,
  tickTo,
} from '../domain/sim';

const bar = (date: string, open: number, high: number, low: number, close: number, volume = 1000): Candle => ({ date, open, high, low, close, volume });

function setup(rows: Candle[], monthly = 0) {
  const m = buildMarket(new Map([['2330', rows]]));
  const s = newSim({ start: rows[0].date, capital: 1_000_000, discount: 1, monthly });
  return { m, s };
}

describe('停損／停利', () => {
  it('多方停損：價格跌到停損價時以當下價格賣出整個部位', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 100, 101, 90, 92)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 2000 });
    expect(setStop(s, m, '2330', 'cash', 'long', 101)).toMatch(/低於現價/);
    expect(setStop(s, m, '2330', 'cash', 'long', 95, 120)).toBeNull();
    closeDay(s, m);
    beginDay(s, m, '2024-01-03');
    tickTo(s, m, 270);
    expect(s.pos).toHaveLength(0);
    expect(s.stops).toHaveLength(0);
    const sell = s.trades.at(-1)!;
    expect(sell.side).toBe('sell');
    expect(sell.shares).toBe(2000);
    expect(sell.price).toBeLessThanOrEqual(95);
    expect(s.notes.some((n) => n.text.includes('停損觸發'))).toBe(true);
  });

  it('空方停利：價格跌到停利價時回補', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 100, 100, 80, 85)]);
    placeOrder(s, m, { code: '2330', side: 'sell', kind: 'short', shares: 1000 });
    expect(setStop(s, m, '2330', 'short', 'short', 110, 90)).toBeNull();
    closeDay(s, m);
    beginDay(s, m, '2024-01-03');
    tickTo(s, m, 270);
    expect(s.pos).toHaveLength(0);
    expect(s.trades.at(-1)!.pnl!).toBeGreaterThan(0);
  });
});

describe('薪資、信貸、質押', () => {
  it('每月第一個交易日薪資入帳，報酬率以累計投入計算', () => {
    const { m, s } = setup([bar('2024-01-31', 100, 100, 100, 100), bar('2024-02-01', 100, 100, 100, 100), bar('2024-02-02', 100, 100, 100, 100)], 20_000);
    closeDay(s, m);
    beginDay(s, m, '2024-02-01');
    expect(s.cash).toBe(1_020_000);
    expect(investedOf(s)).toBe(1_020_000);
    closeDay(s, m);
    expect(s.days.at(-1)).toMatchObject({ d: '2024-02-01', flow: 20_000, eq: 1_020_000 });
    expect(summarize(s, m).ret).toBe(0);
    beginDay(s, m, '2024-02-02');
    expect(s.cash).toBe(1_020_000);
  });

  it('信貸：本息平均攤還、每月扣款、提前還款後月付金重算、額度上限', () => {
    const { m, s } = setup([bar('2024-01-31', 100, 100, 100, 100), bar('2024-02-01', 100, 100, 100, 100)]);
    expect(takeLoan(s, LOAN_LIMIT + 1, 12)).toMatch(/額度/);
    expect(takeLoan(s, 120_000, 12)).toBeNull();
    const l = s.loans[0];
    expect(l.payment).toBe(annuity(120_000, 0.035, 12));
    expect(s.cash).toBe(1_120_000);
    expect(equityOf(s, m)).toBe(1_000_000);
    expect(debtOf(s)).toBe(120_000);
    closeDay(s, m);
    beginDay(s, m, '2024-02-01');
    expect(l.left).toBe(11);
    expect(l.balance).toBeCloseTo(120_000 + 350 - l.payment, -1);
    const before = l.payment;
    expect(repayLoan(s, l.id, 50_000)).toBeNull();
    expect(l.payment).toBeLessThan(before);
    expect(repayLoan(s, l.id, 1e9)).toBeNull();
    expect(s.loans).toHaveLength(0);
  });

  it('質押：最多借六成、質押中的股票不能賣、還款後才能解除', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 2000 });
    expect(pledgeBorrow(s, m, '2330', 3000, 0)).toMatch(/不足/);
    expect(pledgeBorrow(s, m, '2330', 1000, 70_000)).toMatch(/最多/);
    expect(pledgeBorrow(s, m, '2330', 1000, 60_000)).toBeNull();
    expect(pledgeRatio(s, m)).toBeCloseTo(100_000 / 60_000);
    expect(placeOrder(s, m, { code: '2330', side: 'sell', kind: 'cash', shares: 2000 })).toMatch(/質押中/);
    expect(placeOrder(s, m, { code: '2330', side: 'sell', kind: 'cash', shares: 1000 })).toBeNull();
    expect(pledgeRelease(s, m, '2330', 1000)).toMatch(/先還款/);
    expect(pledgeRepay(s, '2330', 60_000)).toBeNull();
    expect(pledgeRelease(s, m, '2330', 1000)).toBeNull();
    expect(s.pledges).toHaveLength(0);
  });

  it('質押維持率低於 120% 收盤強制賣出還款', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 100, 100, 70, 70)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 });
    pledgeBorrow(s, m, '2330', 1000, 60_000);
    closeDay(s, m);
    beginDay(s, m, '2024-01-03');
    closeDay(s, m);
    expect(s.pledges).toHaveLength(0);
    expect(s.pos).toHaveLength(0);
    expect(s.notes.some((n) => n.text.includes('強制賣出'))).toBe(true);
  });

  it('同額投入大盤的對照組', () => {
    const { s } = setup([bar('2024-01-02', 100, 100, 100, 100)], 20_000);
    s.flows.push(['2024-02-01', 20_000]);
    const idx: Record<string, number> = { '2023-12-29': 100, '2024-01-31': 200, '2024-02-29': 300 };
    const prev: Record<string, string> = { '2024-01-02': '2023-12-29', '2024-02-01': '2024-01-31' };
    expect(benchValue(s, (d) => idx[d], (d) => prev[d], '2024-02-29')).toBeCloseTo((1_000_000 / 100 + 20_000 / 200) * 300);
  });

  it('舊存檔補上新欄位', () => {
    const old = { ...newSim({ start: '2024-01-02', capital: 1, discount: 1 }) } as Record<string, unknown>;
    delete old.stops;
    delete old.loans;
    delete old.days;
    const s = migrate(old)!;
    expect(s.stops).toEqual([]);
    expect(s.loans).toEqual([]);
    expect(s.days).toEqual([]);
  });
});

describe('定期定額、開盤停損、自選股', () => {
  it('月初以開盤價買進定期定額（可以買零股）', () => {
    const m = buildMarket(new Map([['0050', [bar('2024-01-31', 100, 100, 100, 100), bar('2024-02-01', 150, 155, 149, 152)]]]));
    const s = newSim({ start: '2024-01-31', capital: 100_000, discount: 1, monthly: 20_000 });
    expect(setDca(s, '0050', 500)).toMatch(/至少/);
    expect(setDca(s, '0050', 10_000)).toBeNull();
    closeDay(s, m);
    beginDay(s, m, '2024-02-01');
    const t = s.trades.at(-1)!;
    expect(t).toMatchObject({ code: '0050', side: 'buy', price: 150, shares: 66 });
    expect(t.shares * t.price + t.fee).toBeLessThanOrEqual(10_000);
    expect(s.cash).toBe(120_000 - (t.shares * t.price + t.fee));
    setDca(s, '0050', 0);
    expect(s.dca).toHaveLength(0);
  });

  it('開盤跳空跌破停損價：以開盤價賣出', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 90, 95, 88, 94)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 });
    setStop(s, m, '2330', 'cash', 'long', 95);
    closeDay(s, m);
    beginDay(s, m, '2024-01-03');
    expect(s.pos).toHaveLength(0);
    expect(s.trades.at(-1)!.price).toBe(90);
  });

  it('開盤一價鎖跌停：停損賣不掉並提醒', () => {
    const { m, s } = setup([bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 90, 90, 90, 90)]);
    placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 });
    setStop(s, m, '2330', 'cash', 'long', 95);
    closeDay(s, m);
    beginDay(s, m, '2024-01-03');
    expect(s.pos).toHaveLength(1);
    expect(s.notes.at(-1)!.text).toMatch(/鎖跌停/);
  });

  it('自選股', () => {
    const s = newSim({ start: '2024-01-02', capital: 1, discount: 1 });
    expect(toggleFav(s, '2330')).toBe(true);
    expect(s.fav).toEqual(['2330']);
    expect(toggleFav(s, '2330')).toBe(false);
    expect(s.fav).toEqual([]);
  });
});

describe('盤前委託與開盤撮合', () => {
  const rows = [bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 105, 110, 95, 98), bar('2024-01-04', 110, 110, 110, 110)];

  it('盤前看不到今天的價格，委託在開盤時以開盤價撮合', () => {
    const m = buildMarket(new Map([['2330', rows]]));
    const s = newSim({ start: '2024-01-02', capital: 1_000_000, discount: 1 });
    closeDay(s, m);
    beginDay(s, m, '2024-01-03', true);
    expect(s.pre).toBe(true);
    expect(priceNow(s, m, '2330')).toBe(100);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 })).toBeNull();
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000, limit: 106 })).toBeNull();
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000, limit: 96 })).toBeNull();
    expect(s.trades).toHaveLength(0);
    expect(s.orders).toHaveLength(3);
    openDay(s, m);
    expect(s.pre).toBe(false);
    // 市價、限價 106 以開盤價 105 成交；限價 96 留到盤中
    expect(s.trades.map((t) => t.price)).toEqual([105, 105]);
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0].limit).toBe(96);
    tickTo(s, m, 270);
    expect(s.trades.at(-1)!.price).toBe(96);
  });

  it('盤前買進，開盤一價鎖漲停時買不到', () => {
    const m = buildMarket(new Map([['2330', [bar('2024-01-02', 100, 100, 100, 100), bar('2024-01-03', 110, 110, 110, 110)]]]));
    const s = newSim({ start: '2024-01-02', capital: 1_000_000, discount: 1 });
    closeDay(s, m);
    beginDay(s, m, '2024-01-03', true);
    expect(placeOrder(s, m, { code: '2330', side: 'buy', kind: 'cash', shares: 1000 })).toBeNull();
    openDay(s, m);
    expect(s.trades).toHaveLength(0);
    expect(s.notes.at(-1)!.text).toMatch(/鎖漲停/);
  });

  it('新局可以從第一天的盤前開始', () => {
    const s = newSim({ start: '2024-01-02', capital: 1, discount: 1 }, '2330', true);
    expect(s.pre).toBe(true);
  });
});
