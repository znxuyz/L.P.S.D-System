// 暫時的探測腳本：法人買賣超、集保股權分散（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function show(url, csv = false) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    console.log(`\n===== ${url}\n-> ${res.status} ${res.headers.get('content-type')} len ${t.length}`);
    if (csv) { console.log(t.split('\n').slice(0, 4).join('\n')); console.log(t.split('\n').filter((l) => l.includes(',2330,') || l.includes('"2330"')).join('\n')); return; }
    try {
      const j = JSON.parse(t);
      console.log('keys', Object.keys(j).join(','), 'stat', j.stat, 'date', j.date);
      if (j.fields) console.log('fields', JSON.stringify(j.fields), 'rows', j.data?.length, JSON.stringify(j.data?.find((r) => String(r[0]).trim() === '2330') ?? j.data?.[0]));
      if (j.tables) for (const tb of j.tables) console.log('table:', tb.title, '| fields:', JSON.stringify(tb.fields), '| rows', tb.data?.length, '| first', JSON.stringify(tb.data?.[0]), JSON.stringify(tb.data?.find((r) => String(r[0]).trim() === '8299')));
    } catch { console.log('text:', t.slice(0, 400)); }
  } catch (e) { console.log(`\n===== ${url} ERROR ${e}`); }
}
await show('https://www.twse.com.tw/rwd/zh/fund/T86?date=20261005&selectType=ALLBUT0999&response=json');
await show('https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=2026%2F10%2F05&response=json');
await show('https://www.twse.com.tw/rwd/zh/fund/T86?date=20260805&selectType=ALLBUT0999&response=json');
await show('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5', true);
