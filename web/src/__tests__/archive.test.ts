import { describe, expect, it } from 'vitest';
import { canArchive } from '../../../scripts/lib/archiveTime';

/** 台北時間 → epoch ms */
const tp = (s: string) => Date.parse(`${s}+08:00`);

describe('事前存檔的時間', () => {
  it('只在收盤後到下一個平日 08:45 前可以存', () => {
    expect(canArchive('2026-11-18', tp('2026-11-18T13:00:00'))).toBe(false); // 盤中
    expect(canArchive('2026-11-18', tp('2026-11-18T18:37:00'))).toBe(true); // 收盤後
    expect(canArchive('2026-11-18', tp('2026-11-19T08:30:00'))).toBe(true); // 隔天開盤前
    expect(canArchive('2026-11-18', tp('2026-11-19T09:00:00'))).toBe(false); // 隔天已經開盤
    // 週五收盤後到週一開盤前都可以
    expect(canArchive('2026-11-20', tp('2026-11-22T20:00:00'))).toBe(true);
    expect(canArchive('2026-11-20', tp('2026-11-23T10:00:00'))).toBe(false);
  });
});

describe('早上那份存檔的時間', () => {
  it('只能在下一個交易日 05:00～08:45 存', () => {
    expect(canArchive('2026-11-19', tp('2026-11-19T17:01:00'), true)).toBe(false); // 當天傍晚（還沒有美股、夜盤）
    expect(canArchive('2026-11-19', tp('2026-11-20T04:30:00'), true)).toBe(false);
    expect(canArchive('2026-11-19', tp('2026-11-20T07:13:00'), true)).toBe(true);
    expect(canArchive('2026-11-19', tp('2026-11-20T08:50:00'), true)).toBe(false);
    // 週五收盤 → 週一早上
    expect(canArchive('2026-11-20', tp('2026-11-21T07:13:00'), true)).toBe(false);
    expect(canArchive('2026-11-20', tp('2026-11-23T07:13:00'), true)).toBe(true);
  });
});
