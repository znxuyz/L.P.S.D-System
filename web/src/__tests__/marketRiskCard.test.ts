import { describe, expect, it } from 'vitest';
import type { MarketRisk } from '../data/marketRisk';
import { riskCardHtml } from '../ui/marketExtras';

const risk: MarketRisk = {
  asOf: '2025-06-03',
  rows: [
    ['2025-05-30', 168.2, 2900, 7_000_000, 200_000, -18000],
    ['2025-06-02', 150.4, 2850, 6_900_000, 210_000, -26000],
    ['2025-06-03', 138.1, 2700, 6_500_000, 205_000, -35000],
  ],
};

describe('大盤風險卡片', () => {
  it('顯示最新的維持率、外資淨空單與危險提示', () => {
    const html = riskCardHtml(risk);
    expect(html).toContain('138.1%');
    expect(html).toContain('淨空 35,000 口');
    expect(html).toContain('危險區');
    expect(html).toContain('<svg');
  });
  it('模擬盤：只看模擬日以前、不畫走勢圖', () => {
    const html = riskCardHtml(risk, { upTo: '2025-06-03', chart: false });
    expect(html).toContain('150.4%');
    expect(html).not.toContain('138.1%');
    expect(html).not.toContain('<svg');
  });
});
