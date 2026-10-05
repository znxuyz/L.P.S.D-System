/**
 * L.P.L.C. 證交所即時行情轉接服務（Cloudflare Worker）
 *
 * 證交所「基本市況報導」不允許網頁直接呼叫，這個 Worker 代替網頁去查，
 * 再把結果加上 CORS 標頭回傳。只轉接 getStockInfo 這一支查詢，
 * 而且只接受下面 ALLOWED_ORIGINS 列出的網站，避免被別人拿去用。
 *
 * 用法：GET https://<你的 worker>.workers.dev/?ex_ch=tse_2330.tw|otc_6488.tw
 */

// 允許使用這個轉接服務的網站。改了 GitHub repo 名稱或用自己的網域時，要一起改這裡。
const ALLOWED_ORIGINS = [
  'https://znxuyz.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];

// 一次最多查幾個代號
const MAX_CHANNELS = 100;

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status, type = 'text/plain; charset=utf-8') =>
      new Response(body, { status, headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply('method not allowed', 405);
    if (!allowed) return reply('這個網站沒有被允許使用轉接服務（請修改 ALLOWED_ORIGINS）', 403);

    const exCh = new URL(request.url).searchParams.get('ex_ch') || '';
    const channels = exCh.split('|');
    if (!exCh || channels.length > MAX_CHANNELS || !channels.every((c) => /^(tse|otc)_[0-9A-Za-z]{2,8}\.tw$/.test(c))) {
      return reply('ex_ch 格式錯誤，例：tse_2330.tw|otc_6488.tw', 400);
    }

    const target =
      'https://mis.twse.com.tw/stock/api/getStockInfo.jsp' +
      `?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (L.P.L.C. personal dashboard)',
          Accept: 'application/json, text/javascript, */*',
          Referer: 'https://mis.twse.com.tw/stock/index.jsp',
        },
      });
      return reply(await res.text(), res.status, 'application/json; charset=utf-8');
    } catch (err) {
      return reply(`無法連線證交所：${err}`, 502);
    }
  },
};
