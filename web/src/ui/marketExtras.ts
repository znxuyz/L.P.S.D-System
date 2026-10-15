/**
 * 市場情報頁的「今日排行」與「新聞」（原本只有模擬盤有，首頁也放一份）。
 *
 * - 排行：熱力圖股票池（盤中跟著行情更新），或全市場（最近一個交易日收盤，部署時產生的每日行情）。
 * - 新聞：最近一天的國內外大事件與公司重大訊息（模擬盤用的同一份新聞）。
 */
import type { NewsItem, SimMonth } from '../data/simData';
import type { MarketMetrics } from '../domain/metrics';
import { escapeHtml as esc, num, pct, price } from './format';

export type MarketRankKey = 'up' | 'down' | 'turnover' | 'flow';
export type MarketRankScope = 'pool' | 'all';
const KEY_NAME: Record<MarketRankKey, string> = { up: '漲幅', down: '跌幅', turnover: '成交額', flow: '資金流' };

interface Row {
  code: string;
  name: string;
  price: number;
  chg: number;
  /** 成交額（億元）；全市場用張數 × 均價估算。 */
  turnover: number;
  flow?: number;
}

/** 全市場某一天（收盤）的列表。 */
export function marketRows(month: SimMonth, date: string, nameOf: (code: string) => string): Row[] {
  const day = month.days[date];
  if (!day) return [];
  const out: Row[] = [];
  day.forEach((r, i) => {
    if (!r) return;
    const [o, h, l, c, v, pc] = r;
    const code = month.codes[i];
    out.push({ code, name: nameOf(code), price: c, chg: pc ? (c / pc - 1) * 100 : 0, turnover: (v * 1000 * ((o + h + l + c) / 4)) / 1e8 });
  });
  return out;
}

export function rankCardHtml(opts: {
  metrics: MarketMetrics;
  key: MarketRankKey;
  scope: MarketRankScope;
  all: { date: string; rows: Row[] } | null | undefined;
}): string {
  const { key, scope } = opts;
  const allOk = !!opts.all?.rows.length;
  const rows: Row[] =
    scope === 'all' && allOk
      ? opts.all!.rows
      : [...opts.metrics.stockByCode.values()].map((s) => ({ code: s.code, name: s.name, price: s.price, chg: s.changePct, turnover: s.turnover, flow: s.flow }));
  const k = scope === 'all' && key === 'flow' ? 'turnover' : key;
  const val = (r: Row) => (k === 'up' ? r.chg : k === 'down' ? -r.chg : k === 'turnover' ? r.turnover : r.flow ?? 0);
  const top = [...rows].sort((a, b) => val(b) - val(a)).slice(0, 15);
  const tabs = (Object.keys(KEY_NAME) as MarketRankKey[])
    .filter((x) => !(scope === 'all' && x === 'flow'))
    .map((x) => `<button type="button" data-mrank="${x}" aria-pressed="${k === x}">${KEY_NAME[x]}</button>`)
    .join('');
  const scopes = `<button type="button" data-mscope="pool" aria-pressed="${scope === 'pool'}">熱力圖股票池</button><button type="button" data-mscope="all" aria-pressed="${scope === 'all'}" ${
    opts.all === null ? 'disabled title="全市場資料讀不到"' : ''
  }>全市場</button>`;
  const body = top
    .map(
      (r, i) => `<tr data-analyze="${esc(r.code)}"><td class="num muted">${i + 1}</td><td><b>${esc(r.code)}</b> ${esc(r.name)}</td>
        <td class="num">${price(r.price)}</td><td class="num ${r.chg > 0 ? 'up' : r.chg < 0 ? 'down' : ''}">${pct(r.chg)}</td>
        <td class="num muted">${k === 'flow' ? `${(r.flow ?? 0) >= 0 ? '+' : ''}${num(r.flow ?? 0, 1)}` : num(r.turnover, 1)}</td></tr>`,
    )
    .join('');
  const note =
    scope === 'all'
      ? opts.all === undefined
        ? '載入全市場資料⋯⋯'
        : allOk
          ? `全市場 ${num(opts.all!.rows.length)} 檔，${opts.all!.date} 收盤；成交額依張數與均價估算。`
          : '全市場資料讀不到。'
      : '熱力圖股票池，跟著行情更新。';
  return `<div class="mrank-tools"><div class="seg">${scopes}</div><div class="seg">${tabs}</div></div>
    <div class="mrank-wrap"><table class="mrank"><thead><tr><th>#</th><th>股票</th><th>價格</th><th>漲跌</th><th>${k === 'flow' ? '資金流（億）' : '成交額（億）'}</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted mrank-note">${note}點一列看個股分析。</p>`;
}

/** 最近一天的新聞（日期 ≤ today）。 */
export function newsCardHtml(items: NewsItem[] | undefined, today: string): string {
  if (!items) return '<p class="muted">載入新聞⋯⋯</p>';
  const past = items.filter(([d]) => d <= today);
  if (!past.length) return '<p class="muted">沒有新聞資料。</p>';
  const last = past[past.length - 1][0];
  const day = past.filter(([d]) => d === last).sort((a, b) => (a[1] < b[1] ? 1 : -1));
  return `<p class="muted mnews-date">${last}</p><ul class="mnews">${day
    .map(([, t, lv, title]) => `<li class="lv-${lv}"><span class="num muted">${t}</span> ${esc(title)}</li>`)
    .join('')}</ul>`;
}
