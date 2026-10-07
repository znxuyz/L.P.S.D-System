import { describe, expect, it } from 'vitest';
import { classifyEvent, parseMopsTables } from '../data/mopsParse';

describe('parseMopsTables', () => {
  it('讀出多個表格、欄位名稱去掉空白', () => {
    const html = `<table><tr><th>公司<br> 代號</th><th>公司名稱</th><th>毛利率(%)</th></tr>
      <tr><td>2330</td><td>台積電</td><td>67.03</td></tr></table>
      <table><tr><th>公司代號</th><th>公司名稱</th><th>基本每股盈餘（元）</th></tr>
      <tr><td>2881</td><td>富邦金</td><td>&nbsp;5.12</td></tr><tr><td>合計</td><td></td><td></td></tr></table>`;
    const t = parseMopsTables(html);
    expect(t['2330']['毛利率(%)']).toBe('67.03');
    expect(t['2881']['基本每股盈餘（元）']).toBe('5.12');
    expect(Object.keys(t)).toEqual(['2330', '2881']);
  });
});

describe('classifyEvent', () => {
  it('依主旨分類，例行公告不算', () => {
    expect(classifyEvent('本公司董事會決議與某公司進行合併')).toBe('merger');
    expect(classifyEvent('公告本公司董事會通過115年第二季合併財務報告')).toBeNull();
    expect(classifyEvent('公告處分台南廠土地')).toBe('merger');
    expect(classifyEvent('公告本公司上修115年財測')).toBe('guidance-up');
    expect(classifyEvent('獲經濟部科專計畫補助')).toBe('subsidy');
    expect(classifyEvent('公告本公司9月營收')).toBeNull();
  });
});
