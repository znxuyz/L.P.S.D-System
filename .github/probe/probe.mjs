// 暫時的探測腳本：財報、股利、重大訊息來源（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function show(url, opt = {}) {
  try {
    const res = await fetch(url, { ...opt, headers: { 'User-Agent': UA, ...(opt.headers ?? {}) }, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    console.log(`\n===== ${url} ${opt.body ?? ''}\n-> ${res.status} ${res.headers.get('content-type')} len ${t.length}`);
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) { console.log('array', j.length, JSON.stringify(j[0]).slice(0, 700)); const h = j.find((r) => Object.values(r).some((v) => String(v).trim() === '2330')); if (h) console.log('2330:', JSON.stringify(h).slice(0, 700)); }
      else {
        console.log('keys', Object.keys(j).join(','), 'stat', j.stat);
        if (j.paths) console.log('paths:', Object.keys(j.paths).join(' '));
        if (j.fields) console.log('fields', JSON.stringify(j.fields), 'rows', j.data?.length, JSON.stringify(j.data?.[0]), JSON.stringify(j.data?.find((r) => String(r[0]).trim() === '2330' || String(r[1]).trim() === '2330')));
        if (j.tables) for (const tb of j.tables) console.log('table:', tb.title, JSON.stringify(tb.fields), tb.data?.length, JSON.stringify(tb.data?.[0]));
      }
    } catch {
      const text = t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      console.log('text head:', text.slice(0, 900));
      const i = text.indexOf(' 2330 ');
      if (i >= 0) console.log('2330 ctx:', text.slice(i - 50, i + 400));
    }
  } catch (e) { console.log(`\n===== ${url} ERROR ${e} ${e.cause?.code ?? ''}`); }
}
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const q = { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', isQuery: 'Y', TYPEK: 'sii', year: '115', season: '02' };
for (const host of ['https://mopsov.twse.com.tw', 'https://mops.twse.com.tw']) {
  await show(`${host}/mops/web/ajax_t163sb04`, form(q));
  await show(`${host}/mops/web/ajax_t163sb06`, form(q));
}
await show('https://mopsov.twse.com.tw/mops/web/ajax_t163sb04', form({ ...q, TYPEK: 'otc' }));
await show('https://mopsov.twse.com.tw/mops/web/ajax_t163sb20', form(q));
await show('https://openapi.twse.com.tw/v1/swagger.json');
await show('https://www.tpex.org.tw/openapi/swagger.json');
await show('https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci');
await show('https://openapi.twse.com.tw/v1/opendata/t187ap17_L');
await show('https://openapi.twse.com.tw/v1/opendata/t187ap04_L');
await show('https://openapi.twse.com.tw/v1/opendata/t187ap45_L');
await show('https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=20250101&endDate=20251231&response=json');
await show('https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=20160101&endDate=20161231&response=json');
await show('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=2025%2F01%2F01&endDate=2025%2F12%2F31&response=json');
