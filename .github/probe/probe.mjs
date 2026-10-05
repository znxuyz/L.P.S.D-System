// 暫時的探測腳本：在 GitHub Actions 上查看各投信網站的回應格式（合併前會刪除）
const urls = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
for (const url of urls) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-TW' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    console.log(`\n===== ${url}\nstatus ${res.status} final ${res.url} type ${res.headers.get('content-type')} len ${text.length}`);
    const hits = new Set();
    for (const m of text.matchAll(/["'`(]((?:https?:)?\/{0,2}[^"'`()\s<>]*(?:api|Api|API|pcf|PCF|hold|Hold|portfolio|Portfolio|stock|Stock|\.json|\.ashx|\.aspx|\.csv|\.xls)[^"'`()\s<>]*)["'`)]/g)) {
      if (m[1].length < 200) hits.add(m[1]);
    }
    console.log('links:', [...hits].slice(0, 60).join('\n  '));
    const scripts = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    console.log('scripts:', scripts.slice(0, 20).join('\n  '));
    console.log('head:', text.replace(/\s+/g, ' ').slice(0, 1200));
  } catch (e) {
    console.log(`\n===== ${url}\nERROR ${e}`);
  }
}
