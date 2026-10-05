// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const get = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-TW', ...(opts.headers ?? {}) }, method: opts.method, body: opts.body, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  return { res, text: await res.text() };
};
const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

async function apis(label, url) {
  try {
    const { res, text } = await get(url);
    console.log(`\n===== JS ${label} ${url} status ${res.status} len ${text.length}`);
    const hits = new Set();
    for (const m of text.matchAll(/["'`]((?:https?:\/\/[^"'`\s]{3,120})|(?:\/?[A-Za-z0-9_\-]*\/?(?:api|Api|API)[A-Za-z0-9_\-\/\.]{0,100}))["'`]/g)) hits.add(m[1]);
    console.log([...hits].filter((h) => !/googletag|facebook|fonts|w3\.org|angular|github/.test(h)).slice(0, 120).join('\n'));
    for (const kw of ['Shareholding', 'Holding', 'holding', 'PCF', 'Pcf', 'pcf', 'Portfolio', 'portfolio', 'Stock', 'baseUrl', 'apiUrl', 'environment']) {
      const i = text.indexOf(kw);
      if (i >= 0) console.log(`-- ctx[${kw}]:`, text.slice(Math.max(0, i - 200), i + 200).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`\n===== JS ${label} ${url} ERROR ${e} cause ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`);
  }
}

// 1. 群益：伺服器渲染的頁面，看持股表格附近的內容
try {
  const { text } = await get('https://www.capitalfund.com.tw/etf/product/detail/399/portfolio');
  const plain = strip(text);
  for (const kw of ['股票代號', '持股', '權重', '台積電', '申購買回清單']) {
    const i = plain.indexOf(kw);
    console.log(`\n===== capital ctx[${kw}] at ${i}:`, i >= 0 ? plain.slice(Math.max(0, i - 300), i + 1500) : '');
  }
  const i = text.indexOf('pct-stock-table');
  console.log('\n===== capital raw html near pct-stock-table:', text.slice(i - 500, i + 2500).replace(/\s+/g, ' '));
  const tr = text.indexOf('ng-state');
  console.log('\n===== capital ng-state present:', tr, tr >= 0 ? text.slice(tr, tr + 1500) : '');
} catch (e) {
  console.log('capital ERROR', e);
}

// 2. 野村、安聯的前端程式：找資料介面
await apis('nomura', 'https://www.nomurafunds.com.tw/ETFWEB/main.7ecbffde18d5367d.js');
await apis('allianz', 'https://etf.allianzgi.com.tw/main-OP4EL5NS.js');
await apis('capital', 'https://www.capitalfund.com.tw/main.5bc920293693e11c.js');

// 3. 統一：看連線錯誤原因
for (const u of ['https://www.ezmoney.com.tw/', 'https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW']) {
  try {
    const { res, text } = await get(u);
    console.log(`\n===== ezmoney ${u} status ${res.status} len ${text.length}`, strip(text).slice(0, 600));
  } catch (e) {
    console.log(`\n===== ezmoney ${u} ERROR ${e} cause ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`);
  }
}

// 4. 證交所 ETF e添富：找 ETF 相關資料頁
try {
  const { text } = await get('https://www.twse.com.tw/rsrc/sites/etfortune/js/main.js');
  const hits = new Set([...text.matchAll(/["'`](\/[A-Za-z0-9_\-\/\.?=&]{3,120})["'`]/g)].map((m) => m[1]));
  console.log('\n===== twse etfortune main.js paths:\n' + [...hits].slice(0, 80).join('\n'));
} catch (e) {
  console.log('twse ERROR', e);
}
