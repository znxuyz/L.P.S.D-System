import { describe, expect, it } from 'vitest';
import { decodeHtml, parseRevenueHtml } from '../../../scripts/lib/revenueParse';
import { revenueKnownFrom } from '../../../scripts/lib/revDates';

describe('月營收解析', () => {
  it('抓出代號、當月營收、去年當月營收', () => {
    const html = `<table><tr><th>公司代號</th><th>公司名稱</th></tr>
      <tr><td align=center>2330</td><td>台積電</td><td align=right>&nbsp;263,708,978</td><td>236,021,112</td><td>210,302,672</td><td>11.73</td><td>25.39</td><td>2,894,307,699</td><td>2,342,825,076</td><td>23.54</td><td>-</td></tr>
      <tr><td>合計</td><td></td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td></tr>
      <tr><td>6666</td><td>新公司</td><td>1,000</td><td>900</td><td>-</td><td>11</td><td>-</td><td>1</td><td>1</td><td>1</td><td>-</td></tr></table>`;
    expect(parseRevenueHtml(html)).toEqual({ '2330': [263708978, 210302672], '6666': [1000, null] });
  });
  it('Big5 解碼', () => {
    const big5 = new Uint8Array([0xa5, 0x78, 0xbf, 0x6e]); // 台積
    const head = new TextEncoder().encode('<meta charset="big5">');
    const buf = new Uint8Array([...head, ...big5]);
    expect(decodeHtml(buf.buffer)).toContain('台積');
  });
  it('公告後才算知道', () => {
    expect(revenueKnownFrom('2026-10')).toBe('2026-11-11');
    expect(revenueKnownFrom('2025-12')).toBe('2026-01-11');
  });
});
