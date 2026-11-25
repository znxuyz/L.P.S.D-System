/**
 * 每日推播「今天怎麼做」（跟網站預測頁最上方同一套模擬帳戶規則）。
 *
 *   node scripts/notify.ts <資料資料夾>
 *
 * 有設哪個就推哪個（金鑰放 GitHub Secrets，不寫在程式裡）：
 * - ntfy：NTFY_TOPIC（手機裝 ntfy App 訂閱同名頻道；名稱取長一點、別人猜不到）
 * - Discord：DISCORD_WEBHOOK_URL
 * - Telegram：TELEGRAM_BOT_TOKEN＋TELEGRAM_CHAT_ID
 * - LINE（官方帳號 Messaging API）：LINE_CHANNEL_TOKEN＋LINE_USER_ID
 * NOTIFY_DRY=1 只印出內容不送。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const read = <T>(f: string): T | null => {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
  } catch {
    return null;
  }
};
type Paper = {
  asOf: string | null;
  start: string | null;
  days: number;
  ret: number;
  benchmark: number;
  positions: Array<{ code: string; name: string }>;
  holdings?: { trend: { value: number; cash: number; price: number | null } };
  trend?: { nextHold: boolean; nextWeight?: number; bottomLeft?: number; ratio?: number | null; ma: number; dist: number; asOf: string };
};
type Rev = { rebalanceTomorrow: boolean; nextRebalance: string; trendOk: boolean; top: Array<{ code: string; name: string }>; decisions?: Array<{ code: string; name: string; action: string }> };
const paper = read<Paper>('paper.json');
const bt = read<Paper>('paper-backtest.json');
const rev = read<{ revStocks?: Rev }>('predict.json')?.revStocks;
const heat = read<{ now: number; bottom?: { state: string } }>('heat-index.json');
const SITE = process.env.SITE_URL ?? 'https://znxuyz.github.io/L.P.S.D-System/#predict';

const tr = paper?.trend ?? bt?.trend;
if (!paper || !tr) {
  console.log('推播：沒有模擬帳戶資料，略過');
  process.exit(0);
}
const pct = (x: number, d = 0) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const h = paper.holdings;
const val = h ? h.trend.value + h.trend.cash : 0;
const cur = h && val > 0 ? h.trend.value / val : 0;
const tgt = tr.nextHold ? (tr.nextWeight ?? 1) : 0;
let act = false;
let l: string;
if (tgt === 0 && cur > 0) (l = '全部賣出 00631L'), (act = true);
else if (tgt > 0 && cur === 0) (l = `買進 00631L（這一半資金的 ${Math.round(tgt * 100)}%，約 ${n0(val * tgt)} 元）`), (act = true);
else if (tgt > 0 && Math.abs(tgt - cur) > 0.2) (l = `00631L 調整到 ${Math.round(tgt * 100)}%（目前 ${Math.round(cur * 100)}%）`), (act = true);
else if (tgt > 0) l = `續抱 00631L（約 ${Math.round(cur * 100)}%）`;
else l = '不買，持有現金';
const gap = (Math.abs(tr.dist) * 100).toFixed(1);
const lWhen =
  tgt > 0
    ? tr.dist >= 0
      ? `賣出條件：加權指數收盤跌破 200 日均線 ${n0(tr.ma)}（現在高 ${gap}%）`
      : `抄底期還剩 ${tr.bottomLeft ?? 0} 天，到期仍在 200 日均線 ${n0(tr.ma)} 之下就賣`
    : `買進條件：加權指數站回 200 日均線 ${n0(tr.ma)}（現在低 ${gap}%），或融資維持率跌破 140%（${tr.ratio != null ? `現在 ${tr.ratio.toFixed(1)}%` : '還沒公布'}）`;
let r = '';
if (rev) {
  const names = (xs: Array<{ code: string; name: string }>) => xs.map((x) => `${x.code} ${x.name}`).join('、');
  if (rev.rebalanceTomorrow && rev.trendOk) {
    const keep = new Set(rev.top.map((x) => x.code));
    const sells = paper.positions.filter((x) => !keep.has(x.code));
    const buys = (rev.decisions ?? []).filter((x) => x.action === 'buy');
    r = `換股｜買進：${names(buys.length ? buys : rev.top)}${sells.length ? `｜賣出：${names(sells)}` : ''}`;
    act = true;
  } else if (rev.rebalanceTomorrow && !rev.trendOk) {
    r = paper.positions.length ? '全部賣出（大盤在 200 日均線之下）' : '不買，持有現金';
    if (paper.positions.length) act = true;
  } else r = paper.positions.length ? `續抱 ${paper.positions.length} 檔` : '不買，持有現金';
  r += `（下次換股 ${rev.nextRebalance}）`;
}
const light = heat?.bottom?.state === 'go' ? '綠燈（斷頭潮）' : heat?.bottom?.state === 'watch' ? '黃燈' : '沒亮';
const title = `${act ? '要動作' : '不用動作'}｜依 ${tr.asOf} 收盤，下一個交易日開盤`;
const body = [
  `00631L：${l}`,
  `　${lWhen}`,
  rev ? `營收選股：${r}` : '',
  heat ? `融資熱度 ${Math.round(heat.now)}，找底燈號 ${light}` : '',
  bt ? `回測（${bt.start} 起）帳戶 ${pct(bt.ret)}、大盤 ${pct(bt.benchmark)}` : '',
  SITE,
]
  .filter(Boolean)
  .join('\n');
console.log(`${title}\n${body}`);
if (process.env.NOTIFY_DRY === '1') process.exit(0);

const env = process.env;
const send: Array<[string, () => Promise<Response>]> = [];
const post = (url: string, data: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data), signal: AbortSignal.timeout(20_000) });
if (env.NTFY_TOPIC) send.push(['ntfy', () => post('https://ntfy.sh/', { topic: env.NTFY_TOPIC, title, message: body, priority: act ? 5 : 3, tags: [act ? 'rotating_light' : 'chart_with_upwards_trend'], click: SITE })]);
if (env.DISCORD_WEBHOOK_URL) send.push(['Discord', () => post(env.DISCORD_WEBHOOK_URL!, { content: `**${title}**\n${body}` })]);
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) send.push(['Telegram', () => post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: `${title}\n${body}` })]);
if (env.LINE_CHANNEL_TOKEN && env.LINE_USER_ID) send.push(['LINE', () => post('https://api.line.me/v2/bot/message/push', { to: env.LINE_USER_ID, messages: [{ type: 'text', text: `${title}\n${body}` }] }, { Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` })]);
if (!send.length) {
  console.log('推播：沒有設定任何推播（NTFY_TOPIC、DISCORD_WEBHOOK_URL、TELEGRAM_*、LINE_*），只印出內容');
  process.exit(3); // 沒送出：不記成「今天推過了」，之後設定好就會推
}
let okAny = false;
for (const [name, fn] of send) {
  try {
    const res = await fn();
    okAny ||= res.ok;
    console.log(`推播 ${name}：${res.ok ? '成功' : `失敗 HTTP ${res.status} ${(await res.text()).slice(0, 200)}`}`);
  } catch (e) {
    console.log(`推播 ${name}：失敗 ${e}`);
  }
}
if (!okAny) process.exit(4);
