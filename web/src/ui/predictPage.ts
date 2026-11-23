/**
 * 「預測」頁：L.P.L.C. 的三個預測模型（個股 20 日排名、大盤 20 日方向、00631L 當沖）。
 *
 * - 每個模型都附上樣本外回測成績，並自動判斷「有沒有比隨便猜更好」；沒有的就直接說沒有。
 * - 點個股可以跳到個股分析頁。
 */
import { loadCloseFile } from '../data/closeProvider';
import { dayTradeBands, dayTradeCall, loadAnalogs, loadPaper, loadPaperBacktest, loadPredict, loadPredictIntraday, type PaperData, type PredictData, type RevStocks, type Verdict, loadHeatIndex, type HeatIndex } from '../data/predict';
import { sessionAt, taipeiDate } from '../data/liveProvider';
import { sessionOpenMs } from '../data/twse';
import type { IndexPoint } from '../data/types';
import { setTimeframe, type AnalogDay } from '../domain/intradayModel';
import { intradayHtml, liveBars, type IntradayData, type IntradayState } from './predictIntraday';
import { bindStockForecast, stockForecastShell } from './predictStock';
import { fillDaily } from './predictDaily';
import { escapeHtml as esc, num } from './format';

const pctTxt = (v: number | null | undefined, digits = 1, sign = true) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const x = Number((v * 100).toFixed(digits));
  return `${sign && x > 0 ? '+' : ''}${num(x, digits)}%`;
};
const cls = (v: number | null | undefined) => (v == null || !v ? '' : v > 0 ? 'up' : 'down');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

const VERDICT: Record<Verdict, { tag: string; cls: string }> = {
  signal: { tag: '✅ 回測有預測能力', cls: 'is-ok' },
  none: { tag: '⚠️ 回測沒有預測能力', cls: 'is-warn' },
};
const badge = (v: Verdict) => `<span class="pd-verdict ${VERDICT[v].cls}">${VERDICT[v].tag}</span>`;

/** 淨值折線（多條）；values 的每一列是 [日期, ...各條線]。 */
function lineChart(rows: Array<[string, ...number[]]>, series: Array<{ name: string; cls: string }>, opts: { log?: boolean; height?: number } = {}): string {
  if (rows.length < 2) return '';
  const W = 640;
  const Hh = opts.height ?? 200;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const tf = (v: number) => (opts.log ? Math.log(v) : v);
  const all = rows.flatMap((r) => r.slice(1) as number[]).filter((v) => Number.isFinite(v) && (!opts.log || v > 0));
  const lo = Math.min(...all.map(tf));
  const hi = Math.max(...all.map(tf));
  const sx = (i: number) => pad.l + (i / (rows.length - 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - (tf(v) - lo) / (hi - lo || 1)) * (Hh - pad.t - pad.b);
  const paths = series
    .map((s, k) => {
      const d = rows
        .map((r, i) => {
          const v = r[k + 1] as number;
          return Number.isFinite(v) && (!opts.log || v > 0) ? `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}` : '';
        })
        .join('');
      return `<path class="pd-line ${s.cls}" d="${d}"/>`;
    })
    .join('');
  // 縱軸：淨值 1 的基準線、上下界
  const ticks = [opts.log ? Math.exp(lo) : lo, opts.log ? Math.exp(hi) : hi];
  const base = opts.log || (lo <= 1 && hi >= 1) ? `<line class="pd-base" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(1).toFixed(1)}" y2="${sy(1).toFixed(1)}"/>` : '';
  const xs = [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  return `<svg class="pd-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(series.map((s) => s.name).join('、'))}">
    ${base}${paths}
    ${ticks.map((v) => `<text class="pd-tick" x="${pad.l - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${num(v, 2)}</text>`).join('')}
    ${xs.map((i) => `<text class="pd-tick" x="${sx(i).toFixed(1)}" y="${Hh - 6}" text-anchor="${i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}">${rows[i][0].slice(0, 7)}</text>`).join('')}
  </svg>
  <p class="pd-legend">${series.map((s) => `<span class="${s.cls}"><i></i>${esc(s.name)}</span>`).join('')}</p>`;
}


/** 實盤成績（事前存檔）的小區塊。 */
const FW_INTRO = '每天收盤後就把預測存進 forecasts 分支（只會新增、不會修改，git 時間證明是事前做的），結果出來後只拿存檔的數字打分數，完全不可能看答案。';
function fwBlock(title: string, n: number, body: string, wait: string): string {
  return `<div class="pd-fw"><h3 class="pd-sub">實盤成績（事前存檔）</h3><p class="muted pd-small">${FW_INTRO}</p>${n ? `<p class="pd-fw-sum">${title}</p>${body}` : `<p class="muted">${wait}</p>`}</div>`;
}
function fwMarket(f: PredictData['forward']): string {
  const x = f?.market;
  if (!x) return '';
  const rows = x.rows.map((r) => `<tr><td class="num">${esc(r.asOf)}</td><td class="num">${num(r.probUp * 100, 0)}%</td><td class="num ${cls(r.actual)}">${pctTxt(r.actual)}</td><td>${(r.probUp > 0.5) === (r.actual > 0) ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>'}</td></tr>`).join('');
  return fwBlock(`${x.n} 期：方向猜對 <b>${x.hit}</b> 期`, x.n, `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>預測日</th><th class="num">上漲機率</th><th class="num">之後 20 日</th><th>對錯</th></tr></thead><tbody>${rows}</tbody></table></div>`, '從今天開始存檔；看 20 個交易日，約一個月後出現第一筆。');
}
function fwDayTrade(f: PredictData['forward']): string {
  const x = f?.dayTrade;
  if (!x) return '';
  const act = (a: number) => (a > 0 ? '<span class="up">做多</span>' : a < 0 ? '<span class="down">做空</span>' : '<span class="muted">觀望</span>');
  const rows = x.rows.map((r) => `<tr><td class="num">${esc(r.date)}</td><td class="num ${cls(r.gap)}">${pctTxt(r.gap, 2)}</td><td>${act(r.action)}</td><td class="num ${cls(r.actual)}">${pctTxt(r.actual, 2)}</td><td class="num ${cls(r.pnl)}">${r.action ? pctTxt(r.pnl, 2) : '—'}</td></tr>`).join('');
  return fwBlock(`${x.n} 天、出手 ${x.trades} 次，累計（扣成本）<b class="${cls(x.total)}">${pctTxt(x.total, 2)}</b>`, x.n, `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>交易日</th><th class="num">跳空</th><th>動作</th><th class="num">開→收</th><th class="num">損益</th></tr></thead><tbody>${rows}</tbody></table></div>`, '從今天開始存檔；下一個交易日收盤後出現第一筆。');
}


/** 模型模擬帳戶：完全照事前存檔的預測自動下單（紙上交易）。 */
/** 每年的報酬（帳戶、大盤），從每月報酬連乘。 */
function yearly(p: PaperData): Array<[string, number, number]> {
  const y = new Map<string, [number, number]>();
  for (const [m, a, b] of p.monthly ?? []) {
    const k = m.slice(0, 4);
    const v = y.get(k) ?? [1, 1];
    y.set(k, [v[0] * (1 + (a ?? 0)), v[1] * (1 + (b ?? 0))]);
  }
  return [...y].map(([k, [a, b]]) => [k, a - 1, b - 1]);
}

/**
 * 走向真錢的階段與停止條件（事先定好，不因結果放寬）：
 * 1. 模擬實盤：滿 60 個交易日（約 3 個月），而且沒有觸發停止條件 → 2.
 * 2. 小錢實戰：總資金的 10%，再 60 個交易日 → 3.
 * 3. 逐步加碼：每 60 個交易日最多加 20%。
 * 停止條件（任何一個成立就停下檢討、不加碼）：落後同期加權指數超過 15 個百分點；從最高點回落超過 35%（比回測最大回落 −32% 還深，代表跟回測不一樣）。
 */
function stageHtml(p: PaperData | null): string {
  const days = p?.days ?? 0;
  const gap = (p?.ret ?? 0) - (p?.benchmark ?? 0);
  const dd = p?.maxDD ?? 0;
  const stop = days > 0 && (gap < -0.15 || dd < -0.35);
  const stage = stop ? 0 : days >= 120 ? 3 : days >= 60 ? 2 : 1;
  const step = (n: number, t: string, d: string) => `<li class="${stage === n ? 'is-now' : stage > n ? 'is-done' : ''}"><b>${t}</b>　<span class="muted">${d}</span></li>`;
  return `<details class="pd-more pd-stage" open><summary>走向真錢的流程（事先定好的條件）</summary>
    ${stop ? `<p class="pd-note is-warn"><b>⚠ 觸發停止條件：</b>${gap < -0.15 ? `模擬帳戶落後加權指數 ${num(-gap * 100, 1)} 個百分點（上限 15）` : `最大回落 ${num(dd * 100, 1)}%（上限 −35%）`}。先停下檢討、不要用真錢加碼。</p>` : ''}
    <ol class="pd-steps">
      ${step(1, '① 模擬實盤', `完全照事前存檔自動交易，滿 60 個交易日（約 3 個月）。目前 ${num(days)} 天${days ? `，報酬 ${pctTxt(p!.ret)} vs 加權指數 ${pctTxt(p!.benchmark)}` : ''}。`)}
      ${step(2, '② 小錢實戰', '總資金的 10% 照同樣規則下單 60 個交易日，比對實際成交價與模擬帳戶的差距（滑價、手續費、自己有沒有照規則做）。')}
      ${step(3, '③ 逐步加碼', '每 60 個交易日最多加 20%；任何時候觸發停止條件就停。')}
    </ol>
    <p class="muted pd-small">停止條件（任何一個成立就停下檢討、不加碼）：落後同期加權指數超過 15 個百分點；從最高點回落超過 35%（比回測最大回落 −32% 還深，代表實際跟回測不一樣）。這些條件現在就寫死，之後不因為結果放寬。</p>
  </details>`;
}

/** 模擬帳戶目前持有什麼（不管有沒有持股都顯示：00631L、營收選股的每一檔、兩個部位的現金）。 */
function holdingsHtml(p: PaperData, tr: PaperData['trend']): string {
  const h = p.holdings;
  const rows: string[] = [];
  const money = (v: number) => num(v, 0);
  if (h && h.trend.shares > 0)
    rows.push(`<tr><td>趨勢</td><td><b>00631L</b> 元大台灣50正2<small class="muted">${num(h.trend.shares)} 股${h.trend.price != null ? ` × ${num(h.trend.price, 2)}` : ''}${h.trend.since ? `・${esc(h.trend.since)} 起` : ''}</small></td><td class="num">${money(h.trend.value)}</td><td class="num">—</td></tr>`);
  if (h) rows.push(`<tr><td>趨勢</td><td>現金 <span class="muted">（年息 1.5%）</span></td><td class="num">${money(h.trend.cash)}</td><td class="num">—</td></tr>`);
  for (const x of p.positions)
    rows.push(`<tr><td>選股</td><td><b>${esc(x.code)}</b> ${esc(x.name)}<small class="muted">${num(x.shares)} 股・成本 ${num(x.cost, 2)}</small></td><td class="num">${x.price == null ? '—' : money(x.shares * x.price)}</td><td class="num ${cls(x.ret)}">${x.ret == null ? '—' : pctTxt(x.ret)}</td></tr>`);
  if (h) rows.push(`<tr><td>選股</td><td>現金 <span class="muted">（年息 1.5%）</span></td><td class="num">${money(h.stocksCash)}</td><td class="num">—</td></tr>`);
  const allCash = !p.positions.length && !(h && h.trend.shares > 0);
  const why = allCash
    ? `<p class="pd-advice">目前<b>全部是現金</b>：${tr ? `加權指數 ${esc(tr.asOf)} 收盤 ${num(tr.close, 0)}，${tr.dist < 0 ? `低於 200 日均線 ${num(Math.abs(tr.dist) * 100, 1)}%，` : ''}` : ''}規則是大盤在 200 日均線之下就不持股，<b>例外是斷頭抄底</b>：大盤融資維持率跌破 140%（${tr?.ratio != null ? `目前 ${num(tr.ratio, 1)}%` : '最新一天還沒公布'}），隔天開盤買 00631L 抱 20 個交易日（比例依波動調整）。否則等加權指數收盤站回均線，<b>隔天開盤</b>買 00631L；營收選股在站回均線後的<b>下一個換股日</b>（每月 12 日後第一個交易日）買下面「營收選股」名單的 20 檔。</p>`
    : '';
  return `<h3 class="pd-sub">目前持有（${esc(p.asOf ?? '')} 收盤）</h3>${why}
    ${rows.length ? `<div class="pd-table-wrap pd-hold-wrap"><table class="pd-table pd-hold"><thead><tr><th>部位</th><th>持有</th><th class="num">市值</th><th class="num">報酬</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : ''}`;
}

/** 最近的交易：直接列出最近 10 筆，其餘收在「更多」。 */
function tradesHtml(p: PaperData, book: Record<string, string>): string {
  const row = (t: PaperData['trades'][number]) =>
    `<tr><td class="num">${esc(t.date)}</td><td>${book[t.book] ?? t.book}</td><td><b>${esc(t.code)}</b> ${esc(t.name)}</td><td class="${t.side === 'buy' ? 'up' : t.side === 'sell' ? 'down' : ''}">${t.side === 'buy' ? '買進' : t.side === 'sell' ? '賣出' : t.side === 'long' ? '做多' : '做空'}</td><td class="num">${t.price == null ? '—' : num(t.price, 2)}</td><td class="num ${cls(t.pnl)}">${t.pnl == null ? '—' : num(t.pnl, 0)}</td><td class="muted">${esc(t.note)}</td></tr>`;
  const head = '<thead><tr><th>日期</th><th>部位</th><th>標的</th><th>動作</th><th class="num">價格</th><th class="num">損益</th><th>說明</th></tr></thead>';
  if (!p.trades.length) return '<h3 class="pd-sub">交易紀錄</h3><p class="muted">還沒有任何交易（開始以來規則都是持有現金）。</p>';
  const first = p.trades.slice(0, 10);
  const rest = p.trades.slice(10);
  return `<h3 class="pd-sub">最近的交易（共 ${num(p.tradeCount)} 筆）</h3>
    <div class="pd-table-wrap"><table class="pd-table">${head}<tbody>${first.map(row).join('')}</tbody></table></div>
    ${rest.length ? `<details class="pd-more"><summary>更早的 ${num(rest.length)} 筆</summary><div class="pd-table-wrap"><table class="pd-table">${head}<tbody>${rest.map(row).join('')}</tbody></table></div></details>` : ''}`;
}

function paperHtml(p: PaperData | null, bt: PaperData | null, alt: PaperData | null = null): string {
  const pct = (v: number | null | undefined) => pctTxt(v ?? 0);
  const tr = p?.trend ?? bt?.trend;
  const head = `<header class="pd-head"><div><p class="eyebrow">Paper trading · 100 萬</p><h2>模型模擬帳戶</h2></div></header>
    <p class="pd-lead">完全照規則與「開盤前就存檔」的預測自動交易，用之後實際的開盤價、收盤價成交，扣手續費（不打折、每筆最低 20 元，保守）與證交稅；每檔金額不夠買一整張的部分當作買零股，零股成交價假設比開盤價差 0.5%（買貴、賣便宜；台灣 50 成分股實際約 0.2%，中小型股較大）。<b>這是判斷模型能不能賺錢的依據</b>，每週檢查時也依它來修正。</p>
    <ul class="pd-rules"><li><b>趨勢 50%</b>：前一天加權指數收盤在 200 日均線之上 → 持有 00631L（2 倍槓桿），跌破 → 全部換現金，隔天開盤換。這是公開研究的經典規則（槓桿 ETF＋200 日均線），不是用我們的資料調出來的。<b>持有比例依波動調整</b>：比例＝長期一般波動 ÷ 近 20 日波動（最多 100%），市場很亂時少放一點，壓低最大回落。</li>
      <li><b>現金</b>（趨勢不持有、營收選股持有現金時）以年息 1.5% 計（定存或貨幣基金）。</li>
      <li><b>營收選股 50%</b>：每月 12 日後第一個交易日開盤，換成下面「營收選股」的 20 檔（留在名單的不動）；大盤在 200 日均線之下就全部持有現金。</li></ul>
    <p class="muted pd-small">00631L 開盤當沖、區間進出場 2022～2026 回測都沒有贏大盤，不放錢（舊的逆勢個股排名已經拿掉）。</p>
    ${tr ? `<p class="pd-advice">下一個交易日：<b class="${tr.nextHold ? 'up' : 'down'}">${tr.nextHold ? `持有 00631L ${num((tr.nextWeight ?? 1) * 100, 0)}%${tr.dist < 0 && tr.bottomLeft ? `（斷頭抄底，還剩 ${tr.bottomLeft} 天）` : ''}` : '持有現金（不持有 00631L）'}</b>　<span class="muted">加權指數 ${esc(tr.asOf)} 收盤 ${num(tr.close, 0)}，200 日均線 ${num(tr.ma, 0)}（${tr.dist >= 0 ? '高於' : '低於'}均線 ${num(Math.abs(tr.dist) * 100, 1)}%）${tr.ratio != null ? `；融資維持率 ${num(tr.ratio, 1)}%（跌破 140% 抄底）` : ''}${tr.vol20 != null && tr.volMed != null ? `；近 20 日波動 ${num(tr.vol20 * 100, 0)}%（一般 ${num(tr.volMed * 100, 0)}%）` : ''}</span></p>` : ''}`;
  const book: Record<string, string> = { stocks: '個股', dayTrade: '開盤當沖', trend: '趨勢', range: '區間進出場' };
  const live = !p || !p.days
    ? '<p class="pd-advice">第一份事前存檔今晚產生，<b>下一個交易日開盤開始自動交易</b>；之後每天收盤後更新帳戶。</p>'
    : `<h3 class="pd-sub">實盤（${esc(p.start ?? '')} 起，${num(p.days)} 天）</h3>
    <dl class="pd-stats">
      <div><dt>帳戶總值</dt><dd class="num ${cls(p.ret)}">${num(p.equity, 0)}</dd></div>
      <div><dt>總報酬</dt><dd class="num ${cls(p.ret)}">${pct(p.ret)}</dd></div>
      <div><dt>同期間買大盤</dt><dd class="num ${cls(p.benchmark)}">${pct(p.benchmark)}</dd></div>
      <div><dt>趨勢／營收選股</dt><dd class="num"><span class="${cls(p.books.trend)}">${pct(p.books.trend)}</span>／<span class="${cls(p.books.stocks)}">${pct(p.books.stocks)}</span></dd></div>
    </dl>
    ${p.curve.length >= 2 ? lineChart(p.curve.map((c) => [c[0], c[1] / p.capital, c[5] / p.capital] as [string, number, number]), [{ name: '模型模擬帳戶', cls: 's1' }, { name: '同額買大盤', cls: 's3' }]) : ''}
    ${holdingsHtml(p, tr)}
    ${tradesHtml(p, book)}`;
  const hist = bt && bt.days
    ? `<h3 class="pd-sub">歷史回測（${esc(bt.start ?? '')} ～ ${esc(bt.asOf ?? '')}，同一套規則）</h3>
    <dl class="pd-stats">
      <div><dt>總報酬</dt><dd class="num ${cls(bt.ret)}">${pct(bt.ret)}</dd></div>
      <div><dt>同期間買大盤</dt><dd class="num ${cls(bt.benchmark)}">${pct(bt.benchmark)}</dd></div>
      <div><dt>最大回落</dt><dd class="num down">${pct(bt.maxDD)}</dd></div>
      <div><dt>趨勢／營收選股</dt><dd class="num"><span class="${cls(bt.books.trend)}">${pct(bt.books.trend)}</span>／<span class="${cls(bt.books.stocks)}">${pct(bt.books.stocks)}</span></dd></div>
    </dl>
    ${lineChart(bt.curve.filter((_, i) => i % 5 === 0 || i === bt.curve.length - 1).map((c) => [c[0], c[1] / bt.capital, c[5] / bt.capital] as [string, number, number]), [{ name: '模擬帳戶（回測）', cls: 's1' }, { name: '同額買大盤', cls: 's3' }], { log: true })}
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>年度</th><th class="num">帳戶</th><th class="num">大盤</th><th class="num">差距</th></tr></thead><tbody>${yearly(bt).map(([y, a, b]) => `<tr><td>${esc(y)}</td><td class="num ${cls(a)}">${pct(a)}</td><td class="num ${cls(b)}">${pct(b)}</td><td class="num ${cls(a - b)}">${pct(a - b)}</td></tr>`).join('')}</tbody></table></div>
    ${alt?.days ? `<p class="pd-note">對照：<b>不依波動調整</b>（趨勢部位一律 100%）同期間總報酬 ${pct(alt.ret)}、最大回落 ${pct(alt.maxDD)}。波動調整少賺一些，換來最大回落從 ${pct(alt.maxDD)} 降到 ${pct(bt.maxDD)}；真錢的話，回落太深最容易撐不住而在低點認賠。</p>` : ''}
    <p class="pd-note is-warn">回測的個股與當沖預測都是逐段往前滾（每天只用那天以前的資料）。但要誠實說：這套配置是看過 2022～2026 的回測後才決定的（個股改用營收選股、拿掉當沖）；趨勢規則本身是公開文獻的標準設定（200 日均線），沒有用這段資料調參數。槓桿 ETF 的回落比大盤大，而且盤整來回震盪時會被巴（2020～2026 共換手約 18 次）。真正公正的成績看上面的「實盤」。</p>`
    : '';
  return `<section class="pd-card glass" id="pd-paper">${head}${stageHtml(p)}${live}${hist}</section>`;
}

/** 一條指數（S&P 500 或加權指數）＋熱度 < 抄底線（▲）／> 過熱線（▼）標記。 */
function heatPriceChart(rows: Array<[string, number, number]>, name: string, buy: number, hot: number): string {
  if (rows.length < 20) return '';
  const W = 520;
  const H = 190;
  const pad = { l: 46, r: 8, t: 18, b: 4 };
  const n = rows.length;
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const cs = rows.map((r) => r[1]);
  const lo = Math.min(...cs) * 0.96;
  const hi = Math.max(...cs) * 1.04;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[1]).toFixed(1)}`).join('');
  const marks = rows
    .map((r, i) => (r[2] < buy ? `<path class="hx-buy" d="M${x(i).toFixed(1)},${(y(r[1]) + 5).toFixed(1)}l-3.5,6h7z"/>` : r[2] > hot ? `<path class="hx-sell" d="M${x(i).toFixed(1)},${(y(r[1]) - 5).toFixed(1)}l-3.5,-6h7z"/>` : ''))
    .join('');
  return `<svg class="pd-chart hx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${name}">
    <text class="pd-tick hx-name" x="${pad.l}" y="12">${name}</text>
    ${[lo, (lo + hi) / 2, hi].map((v) => `<text class="pd-tick" x="${pad.l - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${num(v, 0)}</text>`).join('')}
    <path class="hx-close" d="${line}"/>${marks}</svg>`;
}

/** 熱度 0～100（抄底區綠底、過熱區紅底）。 */
function heatScoreChart(rows: Array<[string, number]>, buy: number, hot: number, extra: Array<{ cls: string; vals: Array<number | null> }> = []): string {
  const W = 520;
  const H = 150;
  const pad = { l: 46, r: 8, t: 6, b: 22 };
  const n = rows.length;
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[1]).toFixed(1)}`).join('');
  const years = rows.map((r, i) => [r[0], i] as const).filter(([d], i) => i > n * 0.06 && d.slice(0, 4) !== rows[i - 1][0].slice(0, 4));
  return `<svg class="pd-chart hx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="熱度">
    <rect class="hx-zone-buy" x="${pad.l}" y="${y(buy).toFixed(1)}" width="${W - pad.l - pad.r}" height="${(y(0) - y(buy)).toFixed(1)}"/>
    <rect class="hx-zone-sell" x="${pad.l}" y="${y(100).toFixed(1)}" width="${W - pad.l - pad.r}" height="${(y(hot) - y(100)).toFixed(1)}"/>
    ${[buy, hot].map((v) => `<line class="hx-th" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="pd-tick" x="${pad.l - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('')}
    ${extra.map((e) => `<path class="${e.cls}" d="${e.vals.map((v, i) => (v == null ? '' : `${i && e.vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('')}"/>`).join('')}
    <path class="hx-score" d="${line}"/>
    ${years.map(([d, i]) => `<text class="pd-tick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.slice(0, 4)}</text>`).join('')}
  </svg>`;
}

/** 熱度的顏色：0 綠（籌碼乾淨）→ 50 黃 → 100 紅（散戶瘋狂）。 */
function heatColor(v: number): string {
  const t = Math.max(0, Math.min(1, v / 100));
  const hue = 140 - 140 * t;
  return `hsl(${hue.toFixed(0)} 75% 55%)`;
}

/** 雷達圖：每個元件今天的分數（0～100），30／80 兩圈參考線。 */
function heatRadar(items: Array<{ name: string; score: number }>, buy: number, hot: number): string {
  const n = items.length;
  if (n < 3) return '';
  const S = 300;
  const c = S / 2;
  const R = 96;
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, v: number) => [c + Math.cos(ang(i)) * (R * v) / 100, c + Math.sin(ang(i)) * (R * v) / 100];
  const ring = (v: number, cl: string) => `<polygon class="${cl}" points="${items.map((_, i) => pt(i, v).map((x) => x.toFixed(1)).join(',')).join(' ')}"/>`;
  const shape = items.map((it, i) => pt(i, Math.max(2, it.score)).map((x) => x.toFixed(1)).join(',')).join(' ');
  const avg = items.reduce((t, x) => t + x.score, 0) / n;
  const labels = items
    .map((it, i) => {
      const [x, y] = pt(i, 128);
      const anchor = Math.abs(x - c) < 8 ? 'middle' : x > c ? 'start' : 'end';
      const short = it.name.replace(/（.*$/, '');
      return `<text class="hr-lab" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${esc(short)}<tspan class="hr-val" dx="4" fill="${heatColor(it.score)}">${num(it.score, 0)}</tspan></text>`;
    })
    .join('');
  return `<svg class="hr-radar" viewBox="-110 -6 ${S + 220} ${S + 12}" role="img" aria-label="各元件雷達圖">
    ${ring(100, 'hr-ring')}${ring(hot, 'hr-hot')}${ring(buy, 'hr-buy')}
    ${items.map((_, i) => `<line class="hr-axis" x1="${c}" y1="${c}" x2="${pt(i, 100)[0].toFixed(1)}" y2="${pt(i, 100)[1].toFixed(1)}"/>`).join('')}
    <polygon class="hr-shape" points="${shape}" style="fill:${heatColor(avg)};stroke:${heatColor(avg)}"/>
    ${labels}
  </svg>`;
}

/** 找底燈號：熱度低＝黃燈（籌碼乾淨但可能還在跌），再加上融資維持率跌破門檻（斷頭潮）＝綠燈。 */
function bottomLight(h: HeatIndex): string {
  const b = h.bottom;
  if (!b) return '';
  const r = b.ratio == null ? '' : `融資維持率 ${num(b.ratio, 1)}%（${esc(b.ratioDate ?? '')}）`;
  const [cls, label, why] =
    b.state === 'go'
      ? ['go', '綠燈・確認到底', `熱度低＋斷頭潮（${esc(b.trigger ?? '')} 起，還剩 ${b.left} 個交易日）；${r}`]
      : b.state === 'watch'
        ? ['watch', '黃燈・還沒確認', `籌碼乾淨，但還沒出現斷頭潮；${r}，跌破 ${b.ratioTh}% 才亮綠燈`]
        : ['off', '沒亮', `熱度還沒低於 ${h.thresholds.buy}；${r}`];
  return `<p class="hx-light hx-${cls}"><i></i><b>找底燈號：${label}</b><span class="muted">${why}</span></p>`;
}

function heatHtml(h: HeatIndex | null): string {
  if (!h?.series?.length || !h.events?.tw) return '';
  const t = h.thresholds;
  const zone = h.now < t.buy ? '籌碼乾淨・低檔區' : h.now > t.hot ? '散戶瘋狂・過熱' : '中性';
  const col = heatColor(h.now);
  const items = h.components.filter((x) => x.score != null).map((x) => ({ name: x.name, score: x.score! }));
  const rows = h.series.filter((r) => r[2] != null);
  const e = h.events.tw;
  const wf = h.weighting;
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return `<section class="pd-card glass hx-top" id="pd-heat">
    <div class="hx-hero">
      <div class="hx-gauge" style="--hx:${col}">
        <p class="eyebrow">台美融資熱度・${esc(h.asOf)}</p>
        <div class="hx-big num" style="color:${col}">${num(h.now, 0)}</div>
        <div class="hx-bar"><i style="left:${Math.max(0, Math.min(100, h.now))}%"></i><span style="left:${t.buy}%"></span><span style="left:${t.hot}%"></span></div>
        <p class="hx-zone" style="color:${col}">${zone}</p>
        <p class="muted hx-sub">${h.now > h.prev ? '▲ 比前一天回升' : h.now < h.prev ? '▼ 比前一天下降' : '和前一天持平'}（${num(h.prev, 0)}）・美股 ${h.usNow == null ? '—' : num(h.usNow, 0)}／台股 ${h.twNow == null ? '—' : num(h.twNow, 0)}</p>
        ${bottomLight(h)}
      </div>
      ${heatRadar(items, t.buy, t.hot)}
    </div>
    <details class="pd-more"><summary>走勢、權重與驗證</summary>
      ${heatPriceChart(rows.map((r) => [r[0], r[1], r[2]!] as [string, number, number]), '台灣加權指數（▲ 熱度 &lt; ' + t.buy + '、▼ &gt; ' + t.hot + '）', t.buy, t.hot)}
      ${heatScoreChart(rows.map((r) => [r[0], r[2]!] as [string, number]), t.buy, t.hot, [{ cls: 'hx-us', vals: rows.map((r) => r[3]) }, { cls: 'hx-tw', vals: rows.map((r) => r[4]) }])}
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>元件</th><th class="num">權重</th><th class="num">今天</th></tr></thead><tbody>
        ${h.components.map((x) => `<tr><td>${esc(x.group)}・${esc(x.name)}</td><td class="num">${num(x.weight * 100, 1)}%</td><td class="num">${x.score == null ? '—' : num(x.score, 0)}</td></tr>`).join('')}
      </tbody></table></div>
      ${h.rules?.length ? `<p class="pd-small"><b>熱度低不等於到底</b>：崩跌途中熱度會一路停在低檔。下表比較幾種「確認到底」的進場規則（事先定好規則、用樣本外熱度），看之後的加權指數：</p>
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>進場規則</th><th class="num">次數</th><th class="num">20 日</th><th class="num">60 日</th><th class="num">60 日上漲</th></tr></thead><tbody>
        ${h.rules.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.n}</td><td class="num">${r.avg20 == null ? '—' : pctTxt(r.avg20)}</td><td class="num">${r.avg60 == null ? '—' : pctTxt(r.avg60)}</td><td class="num">${r.up60 == null ? '—' : num(r.up60 * 100, 0) + '%'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <p class="muted pd-small">權重由程式自己挑：目標是「熱度越低、之後 ${wf?.horizon ?? 60} 個交易日加權指數漲越多」，再往平均拉回一半避免過度配適。${wf?.ic?.length ? `逐年往前滾（只用之前的資料挑權重）的樣本外相關：最佳權重 ${num(avg(wf.ic), 2)}、平均權重 ${num(avg(wf.icEqual), 2)}（正值才代表有用）。${wf.method === 'equal' ? '最佳化沒有贏平均權重，所以目前<b>用平均權重</b>。' : ''}` : ''}跌破 ${t.buy} 之後 60 日加權指數平均 ${e['60'].avg == null ? '—' : pctTxt(e['60'].avg!)}（隨便哪一天 ${pctTxt(e['60'].allAvg)}）。${h.missing.length ? `還沒有資料：${h.missing.map(esc).join('、')}。` : ''}</p>
    </details>
  </section>`;
}

function marketHtml(m: PredictData['market'], h: number, f?: PredictData['forward']): string {
  const b = m.backtest;
  const p = m.probUp;
  const tone = p >= 0.6 ? 'up' : p <= 0.4 ? 'down' : '';
  const drivers = m.drivers
    .filter((d) => d.contrib != null && Math.abs(d.contrib) >= 0.02)
    .slice(0, 6)
    .map((d) => `<li><span class="${cls(d.contrib)}">${d.contrib! > 0 ? '▲ 偏多' : '▼ 偏空'}</span>${esc(d.name)}<small class="muted">（比平常${(d.z ?? 0) > 0 ? '高' : '低'} ${num(Math.abs(d.z ?? 0), 1)} 個標準差）</small></li>`)
    .join('');
  return `<section class="pd-card glass" id="pd-market">
    <header class="pd-head"><div><p class="eyebrow">Market · ${h} 日</p><h2>大盤展望</h2></div>${badge(m.verdict)}</header>
    <div class="pd-kpis">
      <div><dt>未來 ${h} 個交易日上漲機率</dt><dd class="num ${tone}">${num(p * 100, 0)}%</dd></div>
      <div><dt>預期報酬</dt><dd class="num ${cls(m.expReturn)}">${pctTxt(m.expReturn)}</dd></div>
      <div><dt>資料到</dt><dd class="num">${md(m.asOf)}</dd></div>
    </div>
    ${drivers ? `<h3 class="pd-sub">目前影響最大的因素</h3><ul class="pd-drivers">${drivers}</ul>` : ''}
    <h3 class="pd-sub">回測（${b.from.slice(0, 7)} 起，樣本外）</h3>
    <dl class="pd-stats">
      <div><dt>方向準確率</dt><dd class="num">${pctTxt(b.accuracy, 1, false)}</dd></div>
      <div><dt>一直猜漲的準確率</dt><dd class="num">${pctTxt(b.baseRate, 1, false)}</dd></div>
      <div><dt>機率誤差（Brier，越低越好）</dt><dd class="num">${num(b.brier, 3)} <small class="muted">vs ${num(b.brierBase, 3)}</small></dd></div>
    </dl>
    ${lineChart(b.curve, [{ name: '機率 > 50% 才持有大盤', cls: 's1' }, { name: '一直持有大盤', cls: 's3' }], { log: true })}
    <p class="pd-note ${m.verdict === 'none' ? 'is-warn' : ''}">${
      m.verdict === 'none'
        ? '這個模型回測時<b>沒有比「一直猜漲」更準</b>：近幾年大盤多半在漲，用目前的資料（台股自己的走勢、融資、法人、外資期貨）很難判斷一個月後的方向。機率只能當參考，不要拿來決定進出場。'
        : '這個模型回測時比「一直猜漲」更準，但樣本只有幾年、獨立的 20 日區間不到 100 段，仍可能是運氣。'
    }</p>
    ${fwMarket(f)}
  </section>`;
}

const ACT: Record<string, [string, string]> = { buy: ['買進', 'up'], watch: ['觀察', ''], skip: ['不買', 'down'] };
/** 今天的決定（前 30 名）、每日決策紀錄與之後的實際表現、歷史驗證。 */
function decisionsHtml(r: RevStocks): string {
  const ds = r.decisions ?? [];
  const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : pctTxt(v, d));
  const today = ds.length
    ? `<details class="pd-more" open><summary>今天收盤後的決定（前 ${ds.length} 名，每一檔都記錄下來，之後追蹤結果）</summary>
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>#</th><th>股票</th><th>決定</th><th>原因</th></tr></thead><tbody>${ds
        .map((d) => `<tr data-code="${esc(d.code)}" tabindex="0"><td class="num muted">${d.rank}</td><td><b>${esc(d.code)}</b> ${esc(d.name)}</td><td class="${ACT[d.action][1]}"><b>${ACT[d.action][0]}</b></td><td class="muted">${esc(d.reason)}${d.notes.length ? `<br><small>注意：${esc(d.notes.join('、'))}</small>` : ''}</td></tr>`)
        .join('')}</tbody></table></div></details>`
    : '';
  const lg = r.log;
  const sumRow = (k: 'buy' | 'watch' | 'skip') => {
    const x = lg?.summary[k];
    return `<tr><td class="${ACT[k][1]}"><b>${ACT[k][0]}</b></td><td class="num">${num(x?.n ?? 0)}</td><td class="num ${cls(x?.avg)}">${pct(x?.avg)}</td><td class="num">${x?.beat == null ? '—' : num(x.beat * 100, 0) + '%'}</td></tr>`;
  };
  const log = `<details class="pd-more"><summary>決策紀錄與實際結果（事前存檔，${num(lg?.days ?? 0)} 天）</summary>
    ${
      lg && lg.rows.length
        ? `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>決定</th><th class="num">已滿一個月的筆數</th><th class="num">之後一個月平均</th><th class="num">贏加權指數</th></tr></thead><tbody>${sumRow('buy')}${sumRow('watch')}${sumRow('skip')}</tbody></table></div>
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>決定日</th><th>股票</th><th>決定</th><th class="num">之後報酬</th><th class="num">加權指數</th><th>原因</th></tr></thead><tbody>${lg.rows
        .slice()
        .reverse()
        .slice(0, 90)
        .map((x) => `<tr data-code="${esc(x.code)}" tabindex="0"><td class="num">${esc(x.asOf.slice(5))}</td><td><b>${esc(x.code)}</b> ${esc(x.name)}</td><td class="${ACT[x.action]?.[1] ?? ''}">${ACT[x.action]?.[0] ?? esc(x.action)}</td><td class="num ${cls(x.ret)}">${pct(x.ret)}${x.done ? '' : '<small class="muted">（進行中）</small>'}</td><td class="num ${cls(x.market)}">${pct(x.market)}</td><td class="muted">${esc(x.reason)}</td></tr>`)
        .join('')}</tbody></table></div>`
        : '<p class="muted">從今天開始記錄：每天收盤後把前 30 名每一檔「買／觀察／不買」和原因存進事前存檔（只新增、不覆蓋），之後自動算出每個決定後來的實際報酬。</p>'
    }</details>`;
  const st = r.decisionStats;
  const row = (k: string, name: string) => (st?.[k] ? `<tr><td>${name}</td><td class="num">${num(st[k].n)}</td><td class="num ${cls(st[k].avg)}">${pct(st[k].avg)}</td><td class="num">${st[k].win == null ? '—' : num(st[k].win! * 100, 0) + '%'}</td></tr>` : '');
  const hist = st
    ? `<details class="pd-more"><summary>歷史驗證：這些判斷過去對不對（2021 年起每次換股的前 30 名）</summary>
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>當時的判斷</th><th class="num">筆數</th><th class="num">之後一個月平均</th><th class="num">贏加權指數</th></tr></thead><tbody>
      ${row('buyClean', '買進')}${row('buyLowBase', '買進，但只是回到兩年前水準')}${row('buyLoss', '買進，但本業虧損')}${row('oneOff', '不買：營收是一次性的')}${row('rank', '不買：排在 20 名之後')}
      </tbody></table></div><p class="muted pd-small">單一一檔贏加權指數的比例都不到一半：賺錢主要靠少數大漲的股票把平均拉高，所以要分散買 20 檔、不要只買一兩檔。</p></details>`
    : '';
  return today + log + hist;
}

function revStocksHtml(r: RevStocks): string {
  const b = r.backtest;
  const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : pctTxt(v, d));
  const status = !r.trendOk
    ? `<b class="down">下一次換股（約 ${esc(md(r.nextRebalance))}）如果加權指數仍在 200 日均線之下，就全部持有現金</b>；名單照樣每天更新給你參考。`
    : r.rebalanceTomorrow
      ? `<b class="up">明天（${esc(md(r.tradeDate))}）是換股日</b>，開盤照下面名單換股。`
      : `下一次換股約 <b>${esc(md(r.nextRebalance))}</b>（每月 12 日後第一個交易日），名單到時候以前一天收盤後的為準。`;
  const v = (x: number | null | undefined, d = 0) => (x == null ? '—' : pctTxt(x, d));
  return `<section class="pd-card glass" id="pd-rev">
    <header class="pd-head"><div><p class="eyebrow">Revenue picks · 每月換股</p><h2>營收選股</h2></div>${badge((b.total ?? 0) > (b.market ?? 0) ? 'signal' : 'none')}</header>
    <p class="pd-lead">從根本原因選股：股價長期跟著<b>公司賺多少錢</b>走，而<b>每月營收</b>是台股最早公布的獲利資料（次月 10 日前，比季報早 1～2 個月）。每月替 ${num(r.universe)} 檔（近 20 日平均成交額 0.5 億以上）打分數，分數是下面四項在全部股票裡的排名平均，買最高的 ${r.n} 檔、等權持有一個月：</p>
    <ul class="pd-rules"><li><b>營收成長加速</b>：近 3 個月年增率 − 近 12 個月年增率（生意正在變好，而不只是一直很好）</li>
      <li><b>營收創新高</b>：近 3 個月營收 ÷ 過去 3 年最好的 3 個月</li>
      <li><b>毛利率改善</b>：最新一季毛利率 − 去年同季（產品漲價、缺貨的證據）</li>
      <li><b>法人買超</b>：近 20 日法人買超 ÷ 成交量（拿到研究資料的人在買）</li></ul>
    <p class="muted pd-small">再檢查營收增加的<b>根本原因</b>：近 3 個月裡單一個月就佔 60% 以上的（一次性出貨、認列）不買，由下一名遞補；回測過去這種股票之後一個月平均 ${pctTxt(r.decisionStats?.oneOff?.avg ?? 0, 1)}，買進的平均 ${pctTxt(r.decisionStats?.buyClean?.avg ?? 0, 1)}。「只是回到兩年前水準」「本業虧損」只註記不排除（回測排除反而沒有比較好）。</p>
    <p class="pd-advice">${status}<br><span class="muted">用到的營收：${esc(r.revMonth ?? '—')}；資料到 ${esc(md(r.asOf))}。</span></p>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>#</th><th>股票</th><th class="num">收盤</th><th class="num">分數</th><th class="num">近 3 月營收年增</th><th class="num">成長加速</th><th class="num">營收 ÷ 3 年最高</th><th class="num">毛利率變化</th></tr></thead>
    <tbody>${r.top.map((x, i) => `<tr data-code="${esc(x.code)}" tabindex="0" title="看 ${esc(x.code)} 個股分析"><td class="num muted">${i + 1}</td><td><b>${esc(x.code)}</b> ${esc(x.name)}</td><td class="num">${x.close == null ? '—' : num(x.close, x.close < 100 ? 2 : 1)}</td><td class="num">${num(x.score)}</td><td class="num ${cls(x.vals.revYoy3)}">${v(x.vals.revYoy3)}</td><td class="num ${cls(x.vals.revAccel)}">${v(x.vals.revAccel)}</td><td class="num">${x.vals.revHigh == null ? '—' : num(x.vals.revHigh, 2) + ' 倍'}</td><td class="num ${cls(x.vals.gmChg)}">${v(x.vals.gmChg, 1)}</td></tr>`).join('')}</tbody></table></div>
    ${decisionsHtml(r)}
    <h3 class="pd-sub">回測（${esc(b.from ?? '')} ～ ${esc(b.to)}，${num(b.periods)} 次換股，逐段往前滾、扣交易成本）</h3>
    <dl class="pd-stats">
      <div><dt>選股總報酬</dt><dd class="num ${cls(b.total)}">${pct(b.total)}</dd></div>
      <div><dt>同期間加權指數</dt><dd class="num ${cls(b.market)}">${pct(b.market)}</dd></div>
      <div><dt>每月贏大盤的比例</dt><dd class="num">${b.win == null ? '—' : num(b.win * 100, 0) + '%'}</dd></div>
    </dl>
    ${b.curve.length >= 2 ? lineChart(b.curve, [{ name: '營收選股（含跌破 200 日均線持有現金）', cls: 's1' }, { name: '加權指數', cls: 's3' }], { log: true }) : ''}
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>年度</th><th class="num">營收選股</th><th class="num">加權指數</th><th class="num">差距</th></tr></thead><tbody>${b.years.map((y) => `<tr><td>${esc(y.year)}</td><td class="num ${cls(y.ret)}">${pct(y.ret)}</td><td class="num ${cls(y.market)}">${pct(y.market)}</td><td class="num ${cls((y.ret ?? 0) - (y.market ?? 0))}">${pct((y.ret ?? 0) - (y.market ?? 0))}</td></tr>`).join('')}</tbody></table></div>
    <p class="pd-note">怎麼確定沒看答案：每一次換股只用當時已經公布的資料（M 月營收從次月 11 日起才算知道、季報過了申報期限才算）；四項訊號、20 檔、每月 12 日換股都是看結果之前就定好的，換成 10、30、50 檔也都贏大盤。要誠實說的是：單看「營收創新高」那一項成績更好，但它是看過結果才知道的，所以沒有改用它。2024 年（台積電一枝獨秀）輸大盤；大盤在 200 日均線之下時持有現金，所以 2022 年空頭沒有大虧。真正的考驗是模擬帳戶的實盤。</p>
  </section>`;
}

function dayTradeHtml(d: NonNullable<PredictData['dayTrade']>, f?: PredictData['forward']): string {
  const b = d.backtest;
  const bands = dayTradeBands(d);
  const act = (a: number) => (a > 0 ? '<span class="up">做多</span>' : a < 0 ? '<span class="down">做空</span>' : '<span class="muted">觀望</span>');
  const drivers = d.drivers
    .filter((x) => x.contrib != null)
    .sort((a, c) => Math.abs(c.contrib!) - Math.abs(a.contrib!))
    .slice(0, 4)
    .map((x) => `<li><span class="${cls(x.contrib)}">${x.contrib! > 0 ? '▲' : '▼'}</span>${esc(x.name)}</li>`)
    .join('');
  return `<section class="pd-card glass" id="pd-day">
    <header class="pd-head"><div><p class="eyebrow">Day trade · ${esc(d.code)}</p><h2>${esc(d.name)} 當沖</h2></div>${badge(d.verdict)}</header>
    <p class="pd-lead">開盤時看「開盤跳空」加上前一天的資料，預測<b>開盤到收盤</b>的漲跌：預期報酬超過交易成本（${pctTxt(d.cost, 2, false)}）才建議做多或做空，否則觀望。
      昨收 <b class="num">${num(d.lastClose, 2)}</b>（${md(d.lastDate)}）。</p>
    <form class="pd-day-form" id="pd-day-form" autocomplete="off">
      <label>今天開盤價<input type="number" step="0.01" min="0" inputmode="decimal" id="pd-open" value="${d.lastClose}" /></label>
      <output id="pd-day-out" class="pd-day-out"></output>
    </form>
    <p class="pd-bands">依目前的模型：開盤價 ${bands.long ? `<b class="up">${esc(bands.long === 'any' ? '任何價格' : bands.long)}</b> 做多` : '<span class="muted">不會出現做多訊號</span>'}；
      ${bands.short ? `<b class="down">${esc(bands.short === 'any' ? '任何價格' : bands.short)}</b> 做空` : '<span class="muted">不會出現做空訊號</span>'}；其他價格觀望。</p>
    ${drivers ? `<h3 class="pd-sub">昨天收盤後影響最大的因素</h3><ul class="pd-drivers is-inline">${drivers}</ul>` : ''}
    <h3 class="pd-sub">回測（${(b.from ?? '').slice(0, 7)} 起，樣本外，開盤進場、收盤出場）</h3>
    <dl class="pd-stats">
      <div><dt>出手次數</dt><dd class="num">${num(b.trades)} <small class="muted">／${num(b.days)} 天（多 ${b.longs}、空 ${b.shorts}）</small></dd></div>
      <div><dt>勝率</dt><dd class="num">${pctTxt(b.winRate, 1, false)}</dd></div>
      <div><dt>每次平均（扣成本）</dt><dd class="num ${cls(b.avgNet)}">${pctTxt(b.avgNet, 2)}</dd></div>
      <div><dt>累計（扣成本）</dt><dd class="num ${cls(b.total)}">${pctTxt(b.total)}</dd></div>
      <div><dt>每天都開盤買收盤賣</dt><dd class="num ${cls(b.alwaysLong)}">${pctTxt(b.alwaysLong)}</dd></div>
      <div><dt>最大回落</dt><dd class="num down">${pctTxt(b.maxDD)}</dd></div>
    </dl>
    ${lineChart(b.curve, [{ name: '依模型當沖', cls: 's1' }, { name: '每天開盤買收盤賣', cls: 's3' }])}
    <details class="pd-more"><summary>最近 30 個交易日的訊號與結果</summary>
      <div class="pd-table-wrap"><table class="pd-table">
        <thead><tr><th>日期</th><th class="num">跳空</th><th class="num">預測</th><th>動作</th><th class="num">開→收</th><th class="num">損益</th></tr></thead>
        <tbody>${b.recent.map((r) => `<tr><td class="num">${md(r[0])}</td><td class="num ${cls(r[1])}">${pctTxt(r[1], 2)}</td><td class="num ${cls(r[2])}">${pctTxt(r[2], 2)}</td><td>${act(r[4])}</td><td class="num ${cls(r[3])}">${pctTxt(r[3], 2)}</td><td class="num ${cls(r[5])}">${r[4] ? pctTxt(r[5], 2) : '—'}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>
    <p class="pd-note ${d.verdict === 'none' ? 'is-warn' : ''}">${
      d.verdict === 'none'
        ? '回測扣掉成本後<b>是虧錢的</b>：日內漲跌大多是雜訊，現有資料（台股收盤後的資料＋開盤跳空）不足以穩定勝過交易成本。<b>不建議照這個訊號當沖</b>；影響台股開盤後走勢最大的美股、台積電 ADR 夜盤資料目前還沒有收集。'
        : '回測扣掉成本後有賺，但當沖風險高、滑價與手續費差異都會吃掉優勢，請小量驗證。'
    }</p>
    ${fwDayTrade(f)}
  </section>`;
}

let data: PredictData | null | undefined;
let intra: IntradayData | null | undefined;
let loading = false;
const intraState: IntradayState = { mode: '', k: -1, tf: 5, asset: 'L', showActual: true, showAnalogs: true, knockout: false, showCandles: false, showBand: false, showLevels: true };
let analogLib: AnalogDay[] | null = null;
let paper: PaperData | null = null;
let paperBt: PaperData | null = null;
let paperAlt: PaperData | null = null;
/** 即時的加權指數（只有富果／證交所即時行情才有；收盤回放是模擬走勢，不能用）。 */
export type LiveIndex = () => IndexPoint[] | null;
let liveIndex: LiveIndex = () => null;
/** 最新收盤資料的日期（close.json）：檢查預測檔是不是最新的。 */
let lastTradeDate: string | null = null;
let heat: HeatIndex | null = null;
let liveTimer: ReturnType<typeof setInterval> | undefined;

export function renderPredictPage(root: HTMLElement, onStock: (code: string) => void, getLive?: LiveIndex): void {
  if (getLive) liveIndex = getLive;
  if (!loading) {
    loading = true;
    void Promise.all([loadPredict(), loadPredictIntraday(), loadAnalogs(), loadPaper(), loadPaperBacktest(), loadPaperBacktest('paper-backtest-novt.json'), loadCloseFile(), loadHeatIndex()]).then(([d, i, a, pp, pb, pa, cf, hx]) => {
      heat = hx;
      lastTradeDate = cf?.date ?? null;
      data = d;
      intra = i;
      analogLib = a;
      paper = pp;
      paperBt = pb;
      paperAlt = pa;
      loading = false;
      draw(root, onStock);
    });
  }
  draw(root, onStock);
  // 看「今天（即時）」時每 30 秒更新一次
  liveTimer ??= setInterval(() => {
    if (intraState.mode === 'live' && root.offsetParent && document.visibilityState === 'visible') drawIntra(root);
  }, 30_000);
}

function liveState(): { open: number | null; bars: ReturnType<typeof liveBars>['bars']; ok: boolean; why: string } {
  const none = { open: null, bars: [] };
  const series = liveIndex();
  if (!series) return { ...none, ok: false, why: '需要富果或證交所即時行情' };
  if (!intra?.ready || taipeiDate(Date.now()) <= intra.next.after) return { ...none, ok: false, why: '今天的模型資料還沒準備好' };
  // 預測檔比最新的收盤資料舊（例如手機存著前幾天的檔案）：昨收會是錯的，不畫
  if (lastTradeDate && intra.next.after < lastTradeDate) return { ...none, ok: false, why: `預測資料停在 ${intra.next.after}（最新收盤是 ${lastTradeDate}），請重新整理` };
  // 開盤前也能看（開盤前的預測）；週末、收盤後沒有今天的資料時就是休市
  const r = liveBars(series, sessionOpenMs(new Date()));
  if (!r.open && sessionAt(Date.now()) === 'closed') return { ...none, ok: false, why: '今天休市' };
  return { ...r, ok: true, why: '' };
}

/** 只重畫 5 分 K 預測那一塊。 */
function drawIntra(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>('#pd-intra');
  if (!el) return;
  const live = liveState();
  // 收盤後：今天的資料已經進回放清單的話，改成回放今天（才能拉預測時間復盤），不要卡在即時
  const today = taipeiDate(Date.now());
  const closed = sessionAt(Date.now()) === 'closed';
  const hasToday = !!intra?.recent?.some((r) => r.date === today);
  if (closed && hasToday && (intraState.mode === 'live' || !intraState.mode)) intraState.mode = today;
  if (!intraState.mode) intraState.mode = live.ok ? 'live' : '';
  el.outerHTML = intradayHtml(intra, intraState, live, analogLib);
  bindIntra(root);
}

function bindIntra(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('[data-intra-daily]')?.addEventListener('click', () => {
    intraState.daily = true;
    drawIntra(root);
  });
  if (intraState.daily) {
    const el = root.querySelector<HTMLElement>('#pd-intra-daily');
    // 台指期日 K 放在 5 分 K 的預測檔裡
    if (el) void loadPredictIntraday(5).then((d5) => fillDaily(el, intraState.asset ?? 'L', (d5 as unknown as { txd?: Array<[string, number, number, number, number]> } | null)?.txd));
  }
  root.querySelectorAll<HTMLButtonElement>('[data-intra-asset]').forEach((b) =>
    b.addEventListener('click', () => {
      intraState.asset = b.dataset.intraAsset as IntradayState['asset'];
      drawIntra(root);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-intra-tf]').forEach((b) =>
    b.addEventListener('click', () => {
      const tf = Number(b.dataset.intraTf) as 1 | 3 | 5;
      if (intraState.daily) {
        intraState.daily = false;
        if (tf === intraState.tf) return drawIntra(root);
      }
      if (tf === intraState.tf) return;
      intraState.tf = tf;
      intraState.k = -1;
      setTimeframe(tf);
      intra = undefined;
      analogLib = null;
      const el = root.querySelector<HTMLElement>('#pd-intra');
      el?.querySelector('.pd-intra-tf')?.querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
      void Promise.all([loadPredictIntraday(tf), loadAnalogs(tf)]).then(([i, a]) => {
        if (intraState.tf !== tf) return;
        intra = i;
        analogLib = a;
        drawIntra(root);
      });
    }),
  );
  root.querySelector<HTMLSelectElement>('#pd-intra-day')?.addEventListener('change', (e) => {
    intraState.mode = (e.target as HTMLSelectElement).value;
    drawIntra(root);
  });
  root.querySelectorAll<HTMLInputElement>('#pd-intra [data-opt]').forEach((el) =>
    el.addEventListener('change', () => {
      (intraState as unknown as Record<string, boolean>)[el.dataset.opt!] = el.checked;
      drawIntra(root);
    }),
  );
  root.querySelector<HTMLInputElement>('#pd-intra-actual')?.addEventListener('change', (e) => {
    intraState.showActual = (e.target as HTMLInputElement).checked;
    drawIntra(root);
  });
  const k = root.querySelector<HTMLInputElement>('#pd-intra-k');
  k?.addEventListener('input', () => {
    intraState.k = Number(k.value);
    // 拖曳時只換數字與圖，保留滑桿（不然拖到一半會斷）
    const el = root.querySelector<HTMLElement>('#pd-intra');
    if (!el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = intradayHtml(intra, intraState, liveState(), analogLib);
    const next = tmp.firstElementChild as HTMLElement;
    for (const sel of ['.pd-intra-stats', '.pd-intra-scroll', '.pd-intra-legend', '#pd-intra-clock', '.pd-day-err', '.pd-line-err', '.pd-range']) {
      const a = el.querySelector(sel);
      const b = next.querySelector(sel);
      if (a && b) a.replaceWith(b);
    }
  });
}

function draw(root: HTMLElement, onStock: (code: string) => void): void {
  const head = `<div class="pd-hero glass"><p class="eyebrow">L.P.L.C. Predict</p><h2>預測</h2>
    <p>拉普拉斯預測核心：用 2020 年以來的日 K、法人、融資、估值、財報與外資期貨，每天收盤後重新計算。
      所有模型都是<b>逐段往前滾</b>訓練（每個時間點只用當時看得到的資料），下面的回測成績都是<b>樣本外</b>的；沒有預測能力的會直接標出來。</p>
    <p class="pd-honest">⚖️ 公正性：模型的設計（用哪些因子、參數）是看著回測成績調整的，回測成績可能<b>偏樂觀</b>。最公正的是每個模型的<b>「實盤成績（事前存檔）」</b>：每天收盤後先把預測存起來（只能新增、不能修改），結果出來後才打分數，完全不可能看答案。</p></div>`;
  if (data === undefined) {
    root.innerHTML = `<div class="pd-main">${head}<p class="muted">載入中⋯⋯</p></div>`;
    return;
  }
  if (!data) {
    root.innerHTML = `<div class="pd-main">${head}<p class="muted">還沒有預測資料（每天資料更新、網站部署時產生）。</p></div>`;
    return;
  }
  const d = data;
  // 跳到區塊（黏在畫面上方）：最重要的放前面；舊的個股排名、當沖只是觀察用，放後面
  const jumps: Array<[string, string]> = [
    ...(heat?.series?.length ? [['#pd-heat', '融資熱度'] as [string, string]] : []),
    ...(paper ? [['#pd-paper', '模擬帳戶'] as [string, string]] : []),
    ...(d.revStocks ? [['#pd-rev', '營收選股'] as [string, string]] : []),
    ['#pd-stock', '個股預測'],
    ['#pd-market', '大盤展望'],
    ['#pd-intra', '盤中（00631L）'],
    ...(d.dayTrade ? [['#pd-day', '當沖・觀察'] as [string, string]] : []),
  ];
  const summary = `<nav class="pd-jump glass" aria-label="跳到預測頁的區塊">${jumps.map(([h, t]) => `<a href="${h}" class="pd-sum">${t}</a>`).join('')}</nav>`;
  root.innerHTML = `<div class="pd-main">${heatHtml(heat)}${head}${summary}
    ${paperHtml(paper, paperBt, paperAlt)}
    ${d.revStocks ? revStocksHtml(d.revStocks) : ''}
    ${stockForecastShell()}
    ${marketHtml(d.market, d.horizon, d.forward)}
    ${d.dayTrade ? dayTradeHtml(d.dayTrade, d.forward) : ''}
    <section id="pd-intra"></section>
    <p class="muted pd-foot">預測是依歷史資料統計的結果，<b>不構成投資建議</b>；過去的回測成績不代表未來。更新時間 ${esc(new Date(d.generatedAt).toLocaleString('zh-TW', { hour12: false }))}。</p>
  </div>`;

  bindStockForecast(root, d.revStocks);
  // 點股票跳到個股分析
  root.querySelectorAll<HTMLElement>('tr[data-code]').forEach((tr) => {
    const go = () => onStock(tr.dataset.code!);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => (e.key === 'Enter' ? go() : undefined));
  });
  // 摘要卡：捲到對應區塊（不改網址的 #）
  root.querySelectorAll<HTMLAnchorElement>('.pd-sum').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      root.querySelector(a.getAttribute('href')!)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
  );
  drawIntra(root);
  // 當沖：輸入開盤價即時算
  const dt = d.dayTrade;
  const input = root.querySelector<HTMLInputElement>('#pd-open');
  const out = root.querySelector<HTMLOutputElement>('#pd-day-out');
  if (dt && input && out) {
    const update = () => {
      const open = Number(input.value);
      if (!(open > 0)) {
        out.innerHTML = '<span class="muted">輸入開盤價</span>';
        return;
      }
      const r = dayTradeCall(dt, open);
      const label = r.action > 0 ? '<b class="up">做多</b>' : r.action < 0 ? '<b class="down">做空</b>' : '<b class="muted">觀望</b>';
      out.innerHTML = `跳空 <span class="num ${cls(r.gap)}">${pctTxt(r.gap, 2)}</span> → 預測開盤到收盤 <span class="num ${cls(r.pred)}">${pctTxt(r.pred, 2)}</span>：${label}`;
    };
    input.addEventListener('input', update);
    root.querySelector('#pd-day-form')?.addEventListener('submit', (e) => e.preventDefault());
    update();
  }
}
