import { describe, expect, it } from 'vitest';
import type { SimFund } from '../data/simData';
import { fundHtml } from '../ui/sim/analysis';

const fund: SimFund = {
  q: [
    ['2024Q1', '2024-05-31', 100_000, 50_000, 30_000, 20_000, 1.0, 10_000],
    ['2024Q2', '2024-08-31', 110_000, 55_000, 33_000, 22_000, 1.1, 10_000],
    ['2025Q1', '2025-05-31', 150_000, 80_000, 50_000, 40_000, 2.0, 10_000],
  ],
  r: [
    ['2024-06-03', 4, 2, 40],
    ['2025-06-02', 8, 3, 50],
  ],
};

describe('模擬盤基本面', () => {
  it('還沒公布的季報看不到', () => {
    const html = fundHtml({ code: '1234', etf: false, fund, date: '2025-05-30', prevClose: 100 });
    expect(html).not.toMatch(/>2\.00<\/td>/);
    expect(html).toContain('1.10');
  });
  it('公布後看得到，年增率跟去年同季比', () => {
    const html = fundHtml({ code: '1234', etf: false, fund, date: '2025-06-03', prevClose: 100 });
    expect(html).toMatch(/>2\.00<\/td>/);
    expect(html).toContain('+100.0%'); // EPS 1.0 → 2.0
    // 本益比用昨收 ÷ 近四季 EPS（6/2 那筆 8 元）
    expect(html).toContain('12.5 倍');
  });
  it('不顯示年份', () => {
    const html = fundHtml({ code: '1234', etf: false, fund, date: '2025-06-03', prevClose: 100 });
    expect(html).not.toMatch(/20\d\d/);
  });
});
