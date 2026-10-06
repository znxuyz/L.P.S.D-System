import { describe, expect, it } from 'vitest';
import { externalFundamentals } from '../data/mockUniverse';
import { industryIdOf, searchDirectory, type DirEntry } from '../data/stockDirectory';
import { pePercentile } from '../domain/screens';

const dir: DirEntry[] = [
  { code: '3441', name: '聯一光', market: 'otc', industry: '光電業', close: 232, change: 21 },
  { code: '2330', name: '台積電', market: 'tse', industry: '半導體業', close: 1085 },
  { code: '1101', name: '台泥', market: 'tse', industry: '水泥工業', close: 27 },
];

describe('全市場股票目錄', () => {
  it('依代號、名稱搜尋', () => {
    expect(searchDirectory(dir, '3441')?.name).toBe('聯一光');
    expect(searchDirectory(dir, '3441 聯一光')?.code).toBe('3441');
    expect(searchDirectory(dir, '聯一光')?.code).toBe('3441');
    expect(searchDirectory(dir, '9999')).toBeUndefined();
  });

  it('產業名稱對應到熱力圖分組，對不上的歸到傳產', () => {
    expect(industryIdOf('光電業')).toBe('opto');
    expect(industryIdOf('半導體業')).toBe('semi');
    expect(industryIdOf('水泥工業')).toBe('trad');
    expect(industryIdOf(undefined)).toBeUndefined();
  });

  it('股票池以外的股票：有真實本益比、殖利率時用真實數字換算', () => {
    const f = externalFundamentals('3441', 'opto', 232, { pe: 25, yieldPct: 2 });
    expect(232 / f.eps4q).toBeCloseTo(25);
    expect((f.dividend / 232) * 100).toBeCloseTo(2);
    // 5 年本益比分布以真實本益比為中心產生，分位不會卡在兩端
    const p = pePercentile(25, f.pe5y)!;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(externalFundamentals('3441', 'opto', 232, { pe: 25, yieldPct: 2 })).toEqual(f);
  });
});
