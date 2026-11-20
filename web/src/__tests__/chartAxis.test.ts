import { describe, expect, it } from 'vitest';
import { futureWeekdays } from '../ui/predictStock';

describe('futureWeekdays', () => {
  it('跳過週末、從隔天開始', () => {
    // 2026-11-20 是週五
    expect(futureWeekdays('2026-11-20', 3)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
  });
  it('跨月、跨年', () => {
    const d = futureWeekdays('2026-12-30', 3);
    expect(d).toEqual(['2026-12-31', '2027-01-01', '2027-01-04']);
  });
});
