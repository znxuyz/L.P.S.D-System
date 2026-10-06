// 暫時的探測腳本：確認證交所 / 櫃買中心「某一天全市場收盤」的資料格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function show(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(40000) });
    const t = await res.text();
    console.log(`\n===== ${url}\n-> ${res.status} ${res.headers.get('content-type')} len ${t.length} ${Date.now() - t0}ms`);
    try {
      const j = JSON.parse(t);
      console.log('keys', Object.keys(j).join(','));
      if (j.tables) for (const tb of j.tables) console.log('table:', tb.title, '| fields:', JSON.stringify(tb.fields), '| rows', tb.data?.length, '| first', JSON.stringify(tb.data?.[0]));
      if (j.fields) console.log('fields', JSON.stringify(j.fields), 'rows', j.data?.length, JSON.stringify(j.data?.[0]));
      if (j.aaData) console.log('aaData rows', j.aaData.length, JSON.stringify(j.aaData[0]), JSON.stringify(j.aaData.find((r) => r[0] === '8299')));
      const raw = JSON.stringify(j);
      const i = raw.indexOf('"8299"');
      if (i >= 0) console.log('8299 ctx:', raw.slice(i - 20, i + 300));
    } catch {
      console.log('text:', t.slice(0, 500));
    }
  } catch (e) {
    console.log(`\n===== ${url} ERROR ${e} ${e.cause?.message ?? ''}`);
  }
}
await show('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261005&type=ALLBUT0999&response=json');
await show('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20261001&stockNo=2330&response=json');
await show('https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=2026%2F10%2F05&type=EW&response=json');
await show('https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F10%2F05&id=&response=json');
await show('https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=115/10/05&o=json');
await show('https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=8299&date=2026%2F10%2F01&response=json');
// 一年前的日期也查得到嗎
await show('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20251006&type=ALLBUT0999&response=json');
await show('https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=114/10/06&o=json');
