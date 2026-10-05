// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
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
    console.log(`\n===== POST ${label} ${url} ${JSON.stringify(body)} -> ${res.status} ${res.headers.get('content-type')} len ${t.length}\n${t.slice(0, 2500)}`);
    return t;
  } catch (e) {
    console.log(`POST ${label} ERROR ${e} ${e.cause?.message ?? ''}`);
  }
}

// 統一：解析頁面內嵌的持股 JSON
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
if (m) {
  const assets = JSON.parse(decode(m[1]));
  console.log('\n===== ezmoney DataAsset groups:', assets.map((a) => `${a.AssetCode}:${a.AssetName}:${a.Details?.length ?? 0}`).join(' | '));
  const st = assets.find((a) => a.Details?.length);
  console.log('ezmoney sample asset keys:', Object.keys(st ?? {}).join(','));
  console.log('ezmoney first details:', JSON.stringify(st?.Details?.slice(0, 3)));
}
const funds = html.match(/id="DataFunds?" data-content="([^"]*)"/);
console.log('\n===== ezmoney funds list:', funds ? decode(funds[1]).slice(0, 1500) : 'none');
around('ezmoney data ids', html, /<div id="Data[A-Za-z]+"/g, 20, 40);

// 安聯：GetFundAssets 的參數格式
const allianz = await js('https://etf.allianzgi.com.tw/main-OP4EL5NS.js');
around('allianz fundAssetsReq', allianz, /fundAssetsReq\s*=/g, 3, 200);
around('allianz route fund', allianz, /queryParams\.subscribe|this\.route\.queryParams/g, 3, 200);
around('allianz categoryService baseUrl', allianz, /GetFundTypeDropdownOptions\(e\)\{/g, 2, 500);
for (const id of ['00984A', 'E0001', '1', 'AL0984A']) await post('allianz assets', 'https://etf.allianzgi.com.tw/webapi/api/Fund/GetFundAssets', { FundID: id });
await post('allianz detail', 'https://etf.allianzgi.com.tw/webapi/api/Fund/GetFundDetail', { FundNo: '00984A' });

// 群益：前端用 /CFWeb 前綴
const capital = await js('https://www.capitalfund.com.tw/main.5bc920293693e11c.js');
around('capital getBuyback usage', capital, /getBuyback/g, 6, 300);
around('capital CFWeb', capital, /CFWeb/g, 6, 200);
await post('capital buyback', 'https://www.capitalfund.com.tw/CFWeb/api/etf/buyback', { fundId: '399', date: null });

// 野村：共用 post(path, body) 的路徑
const nomura = await js('https://www.nomurafunds.com.tw/ETFWEB/main.7ecbffde18d5367d.js');
around('nomura Fund paths', nomura, /["'`][A-Za-z]+\/(?:Get|Query|Search)[A-Za-z]*(?:Stock|Share|Asset|Hold|Pcf|PCF|Portfolio|Weight)[A-Za-z]*["'`]/g, 20, 200);
const paths = new Set([...nomura.matchAll(/["'`]([A-Z][A-Za-z]+\/[A-Z][A-Za-z]+)["'`]/g)].map((x) => x[1]));
console.log('\n===== nomura API-like paths:', [...paths].slice(0, 150).join(' | '));
