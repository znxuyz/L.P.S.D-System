import { describe, expect, it } from 'vitest';
import { classifyEvent, parseMopsRows, parseMopsTables, rocToIso } from '../data/mopsParse';

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
    expect(classifyEvent('公告本公司115年9月合併營業收入')).toBeNull();
    expect(classifyEvent('公告本公司一一五年九月份合併營運情形')).toBeNull();
    expect(classifyEvent('代子公司元大證券公告取得 上海商業儲蓄銀行股份有限公司一百一十五年度第一期次順位金融債券')).toBeNull();
    expect(classifyEvent('代子公司公告取得AmpUp, Inc. 100%股權')).toBe('merger');
  });
});

describe('parseMopsRows', () => {
  it('同一家公司的多則訊息都保留', () => {
    const html = `<table><tr><th>發言日期</th><th>公司代號</th><th>主旨</th></tr>
      <tr><td>&nbsp;115/09/14</td><td>&nbsp;2330</td><td>A</td></tr><tr><td>115/09/15</td><td>2330</td><td>B</td></tr></table>`;
    const rows = parseMopsRows(html);
    expect(rows.map((r) => r['主旨'])).toEqual(['A', 'B']);
    expect(rocToIso(rows[0]['發言日期'])).toBe('2026-09-14');
    expect(rocToIso('1151007')).toBe('2026-10-07');
  });
});
