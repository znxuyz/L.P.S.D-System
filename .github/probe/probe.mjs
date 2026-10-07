// 暫時的探測腳本：歷史重大訊息的參數（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const tries = [
  ['ajax_t05st02', { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: 'all', year: '115', month: '9', day: '15' }],
  ['ajax_t05st02', { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: 'sii', year: '115', month: '09', day: '15' }],
  ['ajax_t05st02', { encodeURIComponent: '1', step: '0', firstin: 'true', off: '1', TYPEK: 'all', year: '115', month: '09', day: '15', queryName: 'co_id', inpuType: 'co_id' }],
  ['ajax_t05sr01_1', { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: 'all', year: '115', month: '09', day: '15' }],
  ['ajax_t05st01', { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: 'all', co_id: '2330', year: '115', month: '9' }],
];
for (const [path, o] of tries) {
  try {
    const res = await fetch(`https://mopsov.twse.com.tw/mops/web/${path}`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), signal: AbortSignal.timeout(90000) });
    const t = (await res.text()).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    console.log(`\n== ${path} ${JSON.stringify(o)}\n-> ${res.status} len ${t.length}: ${t.slice(0, 600)}`);
  } catch (e) { console.log(`\n== ${path} ERROR ${e}`); }
  await new Promise((r) => setTimeout(r, 4000));
}
