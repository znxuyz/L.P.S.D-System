import { describe, expect, it } from 'vitest';
import { addMonths, isRebalanceDate, latestKnownMonth, rebalanceDays } from '../../../scripts/lib/revDates';

describe('營收選股的日期規則', () => {
  it('月份加減', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-11', 3)).toBe('2026-02');
  });
  it('只用已公布的營收（次月 11 日起）', () => {
    expect(latestKnownMonth('2026-11-10')).toBe('2026-09');
    expect(latestKnownMonth('2026-11-11')).toBe('2026-10');
    expect(latestKnownMonth('2026-01-12')).toBe('2025-12');
  });
  it('換股日：每月 12 日以後第一個交易日', () => {
    const cal = ['2026-11-10', '2026-11-11', '2026-11-13', '2026-11-16', '2026-12-11', '2026-12-14', '2026-12-15'];
    expect(rebalanceDays(cal).map((i) => cal[i])).toEqual(['2026-11-13', '2026-12-14']);
    expect(isRebalanceDate('2026-11-13', '2026-11-11')).toBe(true);
    expect(isRebalanceDate('2026-11-16', '2026-11-13')).toBe(false);
    expect(isRebalanceDate('2026-12-14', '2026-12-11')).toBe(true);
  });
});
