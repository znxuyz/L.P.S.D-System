import { describe, expect, it } from 'vitest';
import { BARS, parseMi5Index } from '../../../scripts/lib/intraday';

/** 產生一天每 5 秒的資料：09:00:00 是昨收 100，之後每 5 秒 +0.01。 */
function fakeDay(): unknown {
  const data: string[][] = [];
  for (let s = 0; s <= 270 * 60; s += 5) {
    const h = 9 + Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    data.push([t, (s === 0 ? 100 : 100 + s / 500).toLocaleString('en-US', { minimumFractionDigits: 2 }), '1']);
  }
  return { stat: 'OK', fields: ['時間', '發行量加權股價指數', '未含金融保險股指數'], data };
}

describe('parseMi5Index', () => {
  it('組成 54 根 5 分 K', () => {
    const d = parseMi5Index(fakeDay())!;
    expect(d.pre).toBe(100);
    expect(d.ix).toHaveLength(BARS);
    // 第一根：09:00:05 ～ 09:05:00
    expect(d.ix[0][0]).toBeCloseTo(100.01);
    expect(d.ix[0][3]).toBeCloseTo(100.6);
    // 最後一根收在 13:30:00
    expect(d.ix[53][3]).toBeCloseTo(100 + 16200 / 500);
    for (const [o, h, l, c] of d.ix) expect(h >= Math.max(o, c) && l <= Math.min(o, c)).toBe(true);
  });
  it('新版 tables 格式、沒有資料', () => {
    const j = fakeDay() as { fields: string[]; data: string[][] };
    expect(parseMi5Index({ stat: 'OK', tables: [{ fields: j.fields, data: j.data }] })?.ix).toHaveLength(BARS);
    expect(parseMi5Index({ stat: '很抱歉，沒有符合條件的資料!' })).toBeNull();
  });
});
