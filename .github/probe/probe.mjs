// 暫時的探測腳本：歷史本益比、集保歷史、歷史重大訊息（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function show(url, opt = {}, find = '2330') {
  try {
    const res = await fetch(url, { ...opt, headers: { 'User-Agent': UA, ...(opt.headers ?? {}) }, signal: AbortSignal.timeout(90000) });
    const t = await res.text();
    console.log(`\n===== ${url} ${opt.body ?? ''}\n-> ${res.status} ${res.headers.get('content-type')} len ${t.length}`);
    try {
      const j = JSON.parse(t);
      console.log('keys', Object.keys(j).join(','), 'stat', j.stat, 'date', j.date);
      if (j.fields) console.log('fields', JSON.stringify(j.fields), 'rows', j.data?.length, JSON.stringify(j.data?.find((r) => String(r[0]).trim() === find) ?? j.data?.[0]));
      if (j.tables) for (const tb of j.tables) console.log('table:', tb.title, JSON.stringify(tb.fields), tb.data?.length, JSON.stringify(tb.data?.find((r) => String(r[0]).trim() === find) ?? tb.data?.[0]));
      if (j.aaData) console.log('aaData', j.aaData.length, JSON.stringify(j.aaData.find((r) => String(r[0]).trim() === find) ?? j.aaData[0]));
    } catch {
      const text = t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      console.log('text head:', text.slice(0, 700));
      const i = text.indexOf(find);
      if (i >= 0) console.log(`${find} ctx:`, text.slice(Math.max(0, i - 100), i + 500));
    }
    return { res, t };
  } catch (e) { console.log(`\n===== ${url} ERROR ${e}`); return {}; }
}
await show('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=20211029&selectType=ALL&response=json');
await show('https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=2021%2F10%2F29&response=json', {}, '8299');
await show('https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&d=110/10/29&o=json', {}, '8299');
// 歷史重大訊息
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
await show('https://mopsov.twse.com.tw/mops/web/ajax_t05st02', form({ encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: 'all', year: '115', month: '09', day: '15' }), '主旨');
// 集保股權分散表查詢
const page = await show('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', {}, 'scaDate');
if (page.t) {
  const token = page.t.match(/name="SYNCHRONIZER_TOKEN"[^>]*value="([^"]+)"/)?.[1];
  const dates = [...page.t.matchAll(/<option value="(\d{8})"/g)].map((m) => m[1]);
  const cookie = (page.res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log('token', !!token, 'dates', dates.length, dates.slice(0, 6).join(','), dates.at(-1), 'cookie', cookie.length);
  await show('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', { ...form({ SYNCHRONIZER_TOKEN: token ?? '', SYNCHRONIZER_URI: '/portal/zh/smWeb/qryStock', method: 'submit', firDate: dates[0] ?? '', scaDate: dates[3] ?? '', sqlMethod: 'StockNo', stockNo: '2330', stockName: '' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie } }, '1,000,001');
}
