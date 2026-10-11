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
  placeOrder,
  pledgeBorrow,
  pledgeRatio,
  pledgeRelease,
  pledgeRepay,
  repayLoan,
  setStop,
  summarize,
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
