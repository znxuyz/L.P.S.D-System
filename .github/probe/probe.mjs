// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function calls(label, url, filter) {
  const text = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  console.log(`\n===== HTTP CALLS ${label}`);
  const seen = new Set();
  for (const m of text.matchAll(/http\.(get|post)\(/g)) {
    const ctx = text.slice(Math.max(0, m.index - 160), m.index + 220).replace(/\s+/g, ' ');
    if (filter && !filter.test(ctx)) continue;
    const key = ctx.slice(150, 260);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log('--', ctx);
    if (seen.size > 70) break;
  }
}
await calls('nomura', 'https://www.nomurafunds.com.tw/ETFWEB/main.7ecbffde18d5367d.js', /Fund|Stock|Share|Pcf|PCF|Hold|Asset|Portfolio|Weight/i);
await calls('allianz', 'https://etf.allianzgi.com.tw/main-OP4EL5NS.js', /Fund|Stock|Share|Pcf|PCF|Hold|Asset|Portfolio|Weight|Etf/i);
await calls('capital', 'https://www.capitalfund.com.tw/main.5bc920293693e11c.js', /buyback|pcf|Pcf|portfolio|stock/i);

// 統一：手動跟隨轉址並保留 cookie
async function withCookies(url) {
  const jar = new Map();
  for (let i = 0; i < 12; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      jar.set(k.trim(), v.join('='));
    }
    const loc = res.headers.get('location');
    console.log(`ezmoney hop ${i} ${res.status} ${url} -> ${loc ?? ''} cookies ${[...jar.keys()].join(',')}`);
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    const text = await res.text();
    console.log('ezmoney final len', text.length, text.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500));
    const hits = new Set([...text.matchAll(/["'](\/[A-Za-z0-9_\-\/]*(?:api|Api|API|PCF|Pcf|Asset|Stock|Fund)[A-Za-z0-9_\-\/\.?=&]*)["']/g)].map((m) => m[1]));
    console.log('ezmoney paths:', [...hits].slice(0, 60).join(' | '));
    return;
  }
}
try {
  await withCookies('https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW');
} catch (e) {
  console.log('ezmoney ERROR', e, e.cause);
}
