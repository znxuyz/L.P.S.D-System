// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const js = async (u) => (await fetch(u, { headers: { 'User-Agent': UA } })).text();
function around(label, text, re, n = 12, w = 260) {
  console.log(`\n===== ${label} ${re}`);
  let k = 0;
  for (const m of text.matchAll(re)) {
    console.log('--', text.slice(Math.max(0, m.index - w), m.index + w).replace(/\s+/g, ' '));
    if (++k >= n) break;
  }
}
async function post(label, url, body, headers = {}) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', ...headers }, body: JSON.stringify(body) });
    const t = await res.text();
    console.log(`\n===== POST ${label} ${url} ${JSON.stringify(body)} -> ${res.status} ${res.headers.get('content-type')} len ${t.length}\n${t.slice(0, 1500)}`);
  } catch (e) {
    console.log(`POST ${label} ERROR ${e} ${e.cause?.message ?? ''}`);
  }
}

// 野村
const nomura = await js('https://www.nomurafunds.com.tw/ETFWEB/main.7ecbffde18d5367d.js');
around('nomura apiUrl', nomura, /apiUrl\s*\+|\.apiUrl\}|so\.apiUrl/g, 40, 180);

// 安聯
const allianz = await js('https://etf.allianzgi.com.tw/main-OP4EL5NS.js');
around('allianz GetFundAssets call', allianz, /\.GetFundAssets\(/g, 6, 400);
around('allianz GetFundDropdownOptions call', allianz, /\.GetFundDropdownOptions\(/g, 3, 300);
around('allianz apiBaseUrl', allianz, /apiBaseUrl\s*=/g, 3, 200);
await post('allianz dropdown', 'https://etf.allianzgi.com.tw/webapi/api/Activity/GetFundDropdownOptions', {});
await post('allianz overview', 'https://etf.allianzgi.com.tw/webapi/api/Fund/GetFundOverview', {});

// 群益
const capital = await js('https://www.capitalfund.com.tw/main.5bc920293693e11c.js');
around('capital getBuyback call', capital, /\.getBuyback\(/g, 4, 400);
await post('capital buyback', 'https://www.capitalfund.com.tw/api/etf/buyback', { fundId: '399', date: null });

// 統一（帶 cookie）
const jar = new Map();
async function ez(url, opts = {}) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers ?? {}) }, redirect: 'manual' });
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
    return res;
  }
}
const info = await (await ez('https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW')).text();
const plain = strip(info);
for (const kw of ['股票代號', '持股', '權重', '台積電', '資產']) {
  const i = plain.indexOf(kw);
  console.log(`\n===== ezmoney ctx[${kw}] at ${i}:`, i >= 0 ? plain.slice(Math.max(0, i - 200), i + 1200) : '');
}
around('ezmoney AssetExcelNPOI', info, /AssetExcelNPOI/g, 3, 400);
around('ezmoney ValueJson', info, /ValueJson/g, 3, 300);
around('ezmoney asset json', info, /DataAsset|assetData|StockList|FundAsset/g, 4, 300);
