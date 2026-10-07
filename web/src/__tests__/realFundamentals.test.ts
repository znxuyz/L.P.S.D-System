import { describe, expect, it } from 'vitest';
import { externalFundamentals } from '../data/mockUniverse';
import { coverageOf, indexDirectory, overlayReal, realNote, type Chips } from '../data/realFundamentals';
import type { StockDirectory } from '../data/stockDirectory';

const dir: StockDirectory = {
  asOf: '2026-10-06',
  stocks: [
    { code: '2330', name: '台積電', market: 'tse', close: 1000, pe: 25, yieldPct: 2 },
    { code: '9999', name: '虧損股', market: 'tse', close: 50, yieldPct: 0, pb: 1.2 },
  ],
};
const chips: Chips = {
  generatedAt: '',
  inst: { asOf: '2026-10-06', days: 20, streak: { '2330': -3 } },
  big: { asOf: '2026-10-02', from: '2026-09-04', chg: { '2330': 0.42 } },
};

describe('overlayReal', () => {
  it('用官方本益比、殖利率換算 EPS 與股利，並套用籌碼', () => {
    const f = externalFundamentals('2330', 'semi', 1000);
    overlayReal('2330', f, indexDirectory(dir), chips);
    expect(f.eps4q).toBeCloseTo(40);
    expect(f.dividend).toBeCloseTo(20);
    expect(f.instBuyDays).toBe(-3);
    expect(f.bigHolderChg).toBe(0.42);
    // 示意的 5 年區間要涵蓋真實本益比附近
    expect(f.pe5y![0]).toBeLessThan(25 * 1.4);
  });

  it('沒有本益比（虧損）時 EPS 為負', () => {
    const f = externalFundamentals('9999', 'trad', 50);
    overlayReal('9999', f, indexDirectory(dir), null);
    expect(f.eps4q).toBeLessThan(0);
  });

  it('套用財報、配息與事件；不在清單上代表沒有', () => {
    const fin = {
      generatedAt: '',
      quarter: '2026Q2',
      dividends: true,
      events: 45,
      stocks: { '2330': { epsYoY: 39.6, grossMarginChg: 8.1, opMarginChg: 9.9, fcfPositive: true, dividendYears: 10, events: ['merger', 'bogus'] } },
    };
    const f = externalFundamentals('2330', 'semi', 1000);
    overlayReal('2330', f, indexDirectory(dir), null, fin);
    expect([f.epsYoY, f.grossMarginChg, f.opMarginChg, f.fcfPositive, f.dividendYears]).toEqual([39.6, 8.1, 9.9, true, 10]);
    expect(f.events).toEqual(['merger']);
    const g = externalFundamentals('9999', 'trad', 50);
    overlayReal('9999', g, indexDirectory(dir), null, fin);
    expect(g.dividendYears).toBe(0);
    expect(g.events).toEqual([]);
    expect(realNote(coverageOf({ directory: dir, chips, fin }), chips, fin)).toContain('仍為模擬資料：5 年本益比區間，');
  });

  it('資料來源說明列出真實與模擬欄位', () => {
    const note = realNote(coverageOf({ directory: dir, chips }), chips);
    expect(note).toContain('法人連買賣（2026-10-06）');
    expect(note).toContain('千張大戶（2026-09-04 → 2026-10-02）');
    expect(note).not.toContain('法人籌碼');
  });
});
