// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function post(label, url, body, headers = {}) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', ...headers }, body: JSON.stringify(body) });
    const t = await res.text();
    console.log(`\n===== POST ${label} ${url} ${JSON.stringify(body)} -> ${res.status} ${res.headers.get('content-type')} len ${t.length}\n${t.slice(0, 1800)}`);
    return t;
  } catch (e) {
    console.log(`POST ${label} ERROR ${e} ${e.cause?.message ?? ''}`);
  }
}
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

// 野村
const N = 'https://www.nomurafunds.com.tw/API/ETFAPI/api/';
await post('nomura assets', N + 'Fund/GetFundAssets', { FundID: '00980A', SearchDate: today });
await post('nomura assets nodate', N + 'Fund/GetFundAssets', { FundID: '00980A', SearchDate: null });
await post('nomura fundlist', N + 'Fund/GetFundList', {});

// 安聯
const A = 'https://etf.allianzgi.com.tw/webapi/api/';
const list = await post('allianz dropdown', A + 'Category/GetFundDropdownOptions', { TypeID: -1, IsAddAllOption: false });
for (const body of [{ FundID: 1 }, { FundID: 'E0001' }, { FundID: '' }, { FundNo: '00984A' }]) await post('allianz assets', A + 'Fund/GetFundAssets', body);
try {
  const j = JSON.parse(list ?? '{}');
  for (const e of (j.Entries ?? []).slice(0, 12)) {
    console.log('allianz fund', JSON.stringify(e).slice(0, 300));
  }
  const active = (j.Entries ?? []).find((e) => /00984A/.test(JSON.stringify(e)));
  if (active) {
    for (const k of ['FundNo', 'FundID', 'Id', 'ID', 'SecuritiesCode']) {
      if (active[k] !== undefined) await post(`allianz assets via ${k}`, A + 'Fund/GetFundAssets', { FundID: active[k] });
    }
  }
} catch (e) {
  console.log('allianz parse error', e);
}

// 統一：股票明細的欄位
const jar = new Map();
async function ez(url) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      jar.set(k.trim(), v.join('='));
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    return res.text();
  }
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const html = await ez('https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW');
const m = html.match(/id="DataAsset" data-content="([^"]*)"/);
const st = JSON.parse(decode(m[1])).find((a) => a.AssetCode === 'ST');
console.log('\n===== ezmoney ST details (first 3):', JSON.stringify(st.Details.slice(0, 3)));
console.log('ezmoney ST sum NavRate:', st.Details.reduce((s, d) => s + (d.NavRate ?? 0), 0));
