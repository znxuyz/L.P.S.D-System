import { describe, expect, it } from 'vitest';
import { boardSeed, chainAt } from '../data/simBoard';
import { sha256Hex } from '../data/sha256';
import { boardStats } from '../domain/simRank';
import { newSim } from '../domain/sim';

describe('排行榜雜湊鏈', () => {
  it('k(i) = SHA-256(k(i-1))，檢查點不影響結果', async () => {
    const seed = boardSeed('x'.repeat(64));
    expect(await chainAt(seed, 0)).toBe(seed);
    expect(await chainAt(seed, 1)).toBe(sha256Hex(seed));
    const k2500 = await chainAt(seed, 2500);
    expect(sha256Hex(await chainAt(seed, 2499))).toBe(k2500);
    expect(await chainAt(seed, 1001)).toBe(sha256Hex(await chainAt(seed, 1000)));
  });
});

describe('排行榜成績', () => {
  it('最近 N 個交易日的報酬與超額報酬；天數不夠的區間是 null', () => {
    const s = newSim({ start: '2024-01-02', capital: 100, discount: 1 });
    s.equity = [['2024-01-02', 110], ['2024-01-03', 121]];
    const idx: Record<string, number> = { '2023-12-29': 100, '2024-01-02': 100, '2024-01-03': 105 };
    const st = boardStats(s, (d) => idx[d], (d) => (d === '2024-01-02' ? '2023-12-29' : undefined));
    expect(st.days).toBe(2);
    expect(st.r.d1).toBeCloseTo(0.1);
    expect(st.x.d1).toBeCloseTo(0.1 - 0.05);
    expect(st.r.d5).toBeNull();
    expect(st.r.all).toBeCloseTo(0.21);
    expect(st.x.all).toBeCloseTo(0.21 - 0.05);
  });
  it('區間內的薪資投入不算報酬', () => {
    const s = newSim({ start: '2024-01-31', capital: 100, discount: 1, monthly: 10 });
    s.equity = [['2024-01-31', 100], ['2024-02-01', 110]];
    s.flows = [['2024-02-01', 10]];
    const st = boardStats(s, () => 1, () => '2024-01-30');
    expect(st.r.d1).toBeCloseTo(0);
    expect(st.r.all).toBeCloseTo(0);
  });
});
