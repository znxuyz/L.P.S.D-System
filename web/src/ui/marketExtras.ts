/**
 * 市場情報頁的「今日排行」與「新聞」（原本只有模擬盤有，首頁也放一份）。
 *
 * - 排行：熱力圖股票池（盤中跟著行情更新），或全市場（最近一個交易日收盤，部署時產生的每日行情）。
 * - 新聞：最近一天的國內外大事件與公司重大訊息（模擬盤用的同一份新聞）。
 */
import { ratioLevel, type MarketRisk, type RiskRow } from '../data/marketRisk';
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

// ---------------------------------------------------------------- 大盤風險


const signed = (v: number, d = 0) => `${v > 0 ? '+' : ''}${num(v, d)}`;

/** 融資維持率（線）與外資淨未平倉（柱）的走勢圖：最近 n 天。 */
function riskChart(rows: RiskRow[], n = 250): string {
  const data = rows.slice(-n);
  if (data.length < 2) return '';
  const W = 640;
  const H = 220;
  const top = 10;
  const ph = 120;
  const fy0 = 160;
  const fh = 50;
  const x = (i: number) => 6 + (i / (data.length - 1)) * (W - 50);
  const ratios = data.map((r) => r[1]).filter((v): v is number => v != null);
  const lo = Math.min(125, ...ratios);
  const hi = Math.max(180, ...ratios);
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * ph;
  let path = '';
  data.forEach((r, i) => {
    if (r[1] != null) path += `${path ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r[1]).toFixed(1)}`;
  });
  const guide = (v: number, cls: string, label: string) =>
    `<line class="${cls}" x1="6" x2="${W - 44}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="risk-axis" x="${W - 40}" y="${(y(v) + 4).toFixed(1)}">${label}</text>`;
  const fut = data.map((r) => r[5] ?? 0);
  const fmax = Math.max(1, ...fut.map((v) => Math.abs(v)));
  const bw = Math.max(1, (W - 50) / data.length - 0.5);
  const bars = data
    .map((r, i) => {
      const v = r[5];
      if (v == null) return '';
      const h = (Math.abs(v) / fmax) * (fh / 2);
      const mid = fy0 + fh / 2;
      return `<rect class="${v < 0 ? 'risk-short' : 'risk-long'}" x="${(x(i) - bw / 2).toFixed(1)}" y="${(v < 0 ? mid : mid - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
    })
    .join('');
  const first = data[0][0];
  const last = data[data.length - 1][0];
  return `<svg class="risk-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="融資維持率與外資淨未平倉走勢">
    ${guide(140, 'risk-line-bad', '140%')}${guide(130, 'risk-line-bad2', '130%')}${guide(160, 'risk-line-ok', '160%')}
    <path class="risk-ratio" d="${path}"/>
    <text class="risk-axis" x="6" y="${fy0 - 4}">外資台指期淨未平倉（上：淨多單、下：淨空單）</text>
    <line class="risk-zero" x1="6" x2="${W - 44}" y1="${fy0 + fh / 2}" y2="${fy0 + fh / 2}"/>${bars}
    <text class="risk-axis" x="6" y="${H - 2}">${first}</text><text class="risk-axis" x="${W - 44}" y="${H - 2}" text-anchor="end">${last}</text>
  </svg>`;
}

/** 首頁市場情報的「大盤風險」卡片。upTo：只看這一天以前（模擬盤用）；不給時看最新。 */
export function riskCardHtml(risk: MarketRisk | null | undefined, opts: { upTo?: string; chart?: boolean } = {}): string {
  if (risk === undefined) return '<p class="muted">載入中⋯⋯</p>';
  const rows = (risk?.rows ?? []).filter((r) => !opts.upTo || r[0] < opts.upTo);
  const withRatio = rows.filter((r) => r[1] != null);
  const withFut = rows.filter((r) => r[5] != null);
  if (!withRatio.length && !withFut.length) return '<p class="muted">還沒有資料（每天收盤後更新，正在回補 2020 年以後的歷史）。</p>';
  const m = withRatio.at(-1);
  const mPrev = withRatio.at(-2);
  const f = withFut.at(-1);
  const fPrev = withFut.at(-2);
  const lvl = m?.[1] != null ? ratioLevel(m[1]) : null;
  const shortRatio = m && m[3] > 0 ? (m[4] / m[3]) * 100 : null;
  const kpis = `<dl class="risk-kpis">
    ${
      m
        ? `<div><dt>上市融資維持率 <small class="muted">${m[0].slice(5).replace('-', '/')}</small></dt><dd class="num risk-${lvl!.cls}">${num(m[1]!, 1)}%${mPrev?.[1] != null ? ` <small>${signed(m[1]! - mPrev[1], 1)}</small>` : ''}</dd></div>
           <div><dt>融資餘額</dt><dd class="num">${num(m[2], 0)} 億${mPrev ? ` <small class="${m[2] - mPrev[2] >= 0 ? 'up' : 'down'}">${signed(m[2] - mPrev[2], 1)}</small>` : ''}</dd></div>
           <div><dt>券資比</dt><dd class="num">${shortRatio == null ? '—' : `${num(shortRatio, 2)}%`}</dd></div>`
        : ''
    }
    ${
      f
        ? `<div><dt>外資台指期淨未平倉 <small class="muted">${f[0].slice(5).replace('-', '/')}</small></dt><dd class="num ${f[5]! < 0 ? 'down' : 'up'}">${f[5]! < 0 ? '淨空' : '淨多'} ${num(Math.abs(f[5]!), 0)} 口${fPrev?.[5] != null ? ` <small>${signed(f[5]! - fPrev[5], 0)}</small>` : ''}</dd></div>`
        : ''
    }
  </dl>`;
  const say = lvl ? `<p class="risk-say risk-${lvl.cls}">${lvl.text}</p>` : '';
  const futSay =
    f?.[5] != null
      ? `<p class="muted risk-note">外資淨空單越多，代表外資在期貨押注下跌或大量避險；淨空單快速增加時，常伴隨現貨賣壓。${f[5] < -30000 ? '<b>目前淨空單偏多。</b>' : ''}</p>`
      : '';
  return `${kpis}${say}${opts.chart === false ? '' : riskChart(rows)}${futSay}
    <p class="muted risk-note">維持率＝融資買進股票的市值 ÷ 融資金額（上市股票，用收盤價估算）。個股低於 130% 會被追繳、補不出來就斷頭；大盤平均掉到 140% 左右時，常出現融資斷頭的連環賣壓。期貨＝大台＋小台÷4 折合大台口數。</p>`;
}
