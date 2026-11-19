import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyedRefresh } from '../data/refresh';

describe('keyedRefresh', () => {
  afterEach(() => vi.useRealTimers());

  it('ttl 內沿用、超過就重抓；重抓失敗沿用上一次', async () => {
    vi.useFakeTimers();
    let n = 0;
    const results: Array<string | null> = ['a', null, 'c'];
    const get = keyedRefresh(async () => results[n++], (v) => v != null, { ttl: 1000 });
    expect(await get('k')).toBe('a');
    expect(await get('k')).toBe('a');
    expect(n).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await get('k')).toBe('a'); // 重抓失敗 → 舊的
    expect(n).toBe(2);
    vi.advanceTimersByTime(1001);
    expect(await get('k')).toBe('c');
  });

  it('超過 max 個 key 時丟掉最早的', async () => {
    let n = 0;
    const get = keyedRefresh(async (k) => `${k}${n++}`, () => true, { max: 2 });
    await get('a');
    await get('b');
    await get('c');
    expect(await get('a')).toBe('a3');
    expect(await get('c')).toBe('c2');
  });
});
