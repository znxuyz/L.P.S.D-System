import { describe, expect, it } from 'vitest';
import { beginDay, buildMarket, closeDay, equityOf, newSim, placeOrder, repairSplits, setStop } from '../domain/sim';
import { adjustForSplits, detectSplits } from '../domain/splits';
import type { Candle } from '../domain/technicals';

const bar = (date: string, open: number, close = open, volume = 1000): Candle => ({ date, open, high: Math.max(open, close), low: Math.min(open, close), close, volume });
// 一拆四：188 → 47
const rows: Candle[] = [
  bar('2025-06-02', 180),
  bar('2025-06-03', 182),
  bar('2025-06-04', 184),
  bar('2025-06-05', 185),
  bar('2025-06-06', 186),
  bar('2025-06-09', 187),
  bar('2025-06-10', 188),
  bar('2025-06-18', 47.5, 47.6),
  bar('2025-06-19', 48),
];

describe('股票分割', () => {
  it('從價格找出一拆四；跌停（-10%）或除權息不算', () => {
    expect(detectSplits(rows)).toEqual([['2025-06-18', 4]]);
    const limitDown = [...rows.slice(0, 7), bar('2025-06-11', 169.2)];
    expect(detectSplits(limitDown)).toEqual([]);
    expect(detectSplits(rows, new Set(['2025-06-18']))).toEqual([]);
  });

  it('持股 ×4、總成本不變、停損價 ÷4，總資產不會因為分割掉 75%', () => {
    const m = buildMarket(new Map([['0050', rows]]));
    const s = newSim({ start: '2025-06-09', capital: 1_000_000, discount: 1 }, '0050');
    expect(placeOrder(s, m, { code: '0050', side: 'buy', kind: 'cash', shares: 2000 })).toBeNull();
    expect(setStop(s, m, '0050', 'cash', 'long', 160)).toBeNull();
    const cost = s.pos[0].cost;
    closeDay(s, m);
    beginDay(s, m, '2025-06-10');
    closeDay(s, m);
    const before = equityOf(s, m);
    beginDay(s, m, '2025-06-18', true);
    expect(s.pos[0].shares).toBe(8000);
    expect(s.pos[0].cost).toBe(cost);
    expect(s.stops[0].loss).toBe(40);
    // 盤前用換算後的昨收（188 ÷ 4）
    expect(m.prevClose('0050', '2025-06-18')).toBe(47);
    expect(Math.abs(equityOf(s, m) - before)).toBeLessThan(1);
    expect(s.notes.at(-1)?.text ?? JSON.stringify(s.notes.at(-1))).toMatch(/分割/);
  });

  it('圖表只還原已經發生的分割', () => {
    const split = detectSplits(rows);
    expect(adjustForSplits(rows, split, '2025-06-10')[0].close).toBe(180);
    const adj = adjustForSplits(rows, split, '2025-06-18');
    expect(adj[0].close).toBe(45);
    expect(adj[0].volume).toBe(4000);
    expect(adj[7].close).toBe(47.6);
  });

  it('舊存檔漏掉的分割會補上（均價變 1/4），已經換算過的不會重複', () => {
    const m = buildMarket(new Map([['0050', rows]]));
    const s = newSim({ start: '2025-06-09', capital: 1_000_000, discount: 1 }, '0050');
    placeOrder(s, m, { code: '0050', side: 'buy', kind: 'cash', shares: 2000 });
    const cost = s.pos[0].cost;
    // 模擬舊版：過了分割日但股數沒換算
    s.date = '2025-06-19';
    expect(repairSplits(s, m)).toBe(1);
    expect(s.pos[0].shares).toBe(8000);
    expect(s.pos[0].cost / s.pos[0].shares).toBeCloseTo(cost / 8000);
    expect(repairSplits(s, m)).toBe(0);
    // 已經換算過、但沒有紀錄的存檔
    s.splitsDone = undefined;
    expect(repairSplits(s, m)).toBe(0);
    expect(s.pos[0].shares).toBe(8000);
  });
});
