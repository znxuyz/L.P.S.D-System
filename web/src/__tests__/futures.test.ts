import { describe, expect, it } from 'vitest';
import { nearMonthContract, thirdWednesday } from '../data/futures';
import { MockMarketProvider } from '../data/mockProvider';
import { computeMetrics } from '../domain/metrics';

describe('台指期', () => {
  it('第三個星期三', () => {
    expect(thirdWednesday(2026, 10)).toBe(21); // 2026/10/1 是星期四
    expect(thirdWednesday(2026, 4)).toBe(15); // 2026/4/1 是星期三
  });

  it('近月合約在結算日之後換到下個月', () => {
    expect(nearMonthContract('2026-10-06').symbol).toBe('TXFJ6');
    expect(nearMonthContract('2026-10-21').symbol).toBe('TXFJ6');
    expect(nearMonthContract('2026-10-22').symbol).toBe('TXFK6');
    expect(nearMonthContract('2026-12-31').symbol).toBe('TXFA7');
  });

  it('模擬行情：期貨和現貨差距維持在合理的價差內', async () => {
    const p = new MockMarketProvider({ tickMs: 1e9 });
    const u = await p.loadUniverse();
    let snap!: Parameters<typeof computeMetrics>[1];
    p.subscribe((s) => (snap = s))();
    const m = computeMetrics(u, snap);
    expect(m.futures).toBeDefined();
    expect(Math.abs(m.futures!.basis)).toBeLessThan(80);
    expect(m.futures!.series.length).toBe(snap.index.series.length);
    expect(m.futures!.volume).toBeGreaterThan(0);
  });
});
