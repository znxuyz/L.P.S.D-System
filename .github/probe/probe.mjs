// 暫時的探測腳本：確認證交所 / 櫃買中心開放資料的格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
for (const url of [
  'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
  'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const t = await res.text();
    let n = '?', sample = t.slice(0, 600);
    try { const j = JSON.parse(t); n = Array.isArray(j) ? j.length : 'obj'; sample = JSON.stringify(Array.isArray(j) ? j.slice(0, 2) : j).slice(0, 900); const hit = Array.isArray(j) && j.find((r) => JSON.stringify(r).includes('3441')); if (hit) sample += '\n3441: ' + JSON.stringify(hit); } catch {}
    console.log(`\n===== ${url} -> ${res.status} ${res.headers.get('content-type')} rows ${n}\n${sample}`);
  } catch (e) {
    console.log(`\n===== ${url} ERROR ${e} ${e.cause?.message ?? ''}`);
  }
}
