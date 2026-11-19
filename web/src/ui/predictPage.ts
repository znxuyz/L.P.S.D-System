/**
 * 「預測」頁：L.P.L.C. 的三個預測模型（個股 20 日排名、大盤 20 日方向、00631L 當沖）。
 *
 * - 每個模型都附上樣本外回測成績，並自動判斷「有沒有比隨便猜更好」；沒有的就直接說沒有。
 * - 點個股可以跳到個股分析頁。
 */
import { dayTradeBands, dayTradeCall, loadAnalogs, loadPredict, loadPredictIntraday, type PredictData, type StockPick, type Verdict } from '../data/predict';
import { sessionAt, taipeiDate } from '../data/liveProvider';
import { sessionOpenMs } from '../data/twse';
import type { IndexPoint } from '../data/types';
import type { AnalogDay } from '../domain/intradayModel';
import { intradayHtml, liveBars, type IntradayData, type IntradayState } from './predictIntraday';
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

function pickTable(rows: StockPick[], kind: 'top' | 'bottom'): string {
  const lv = kind === 'top';
  const px = (v: number | null | undefined) => (v == null ? '—' : num(v, v < 100 ? 2 : 1));
  return `<div class="pd-table-wrap"><table class="pd-table">
    <thead><tr><th>#</th><th>股票</th><th class="num">收盤</th><th class="num">分數</th>${lv ? '<th class="num">進場</th><th class="num">出場</th><th class="num">參考停損</th>' : ''}<th>主要原因</th></tr></thead>
    <tbody>${rows
      .map(
        (r, i) => `<tr data-code="${esc(r.code)}" tabindex="0" title="看 ${esc(r.code)} 個股分析">
        <td class="num muted">${i + 1}</td>
        <td><b>${esc(r.code)}</b> ${esc(r.name)}</td>
        <td class="num">${r.close == null ? '—' : num(r.close, r.close < 100 ? 2 : 1)}</td>
        <td class="num"><span class="pd-score ${kind === 'top' ? 'up' : 'down'}">${r.score}</span></td>
        ${lv ? `<td class="num">${r.levels?.entry != null ? `限價 ${px(r.levels.entry)}` : '明天開盤'}</td><td class="num">${r.levels?.target != null ? `停利 ${px(r.levels.target)}<br>` : ''}20 交易日後${r.levels?.stop != null ? `<br><small>停損 ${px(r.levels.stop)}</small>` : ''}</td><td class="num muted">${px(r.levels?.refStop)}</td>` : ''}
        <td class="pd-reasons">${r.reasons.map(([t]) => `<span>${esc(t)}</span>`).join('')}</td>
      </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

/** 實盤成績（事前存檔）的小區塊。 */
const FW_INTRO = '每天收盤後就把預測存進 forecasts 分支（只會新增、不會修改，git 時間證明是事前做的），結果出來後只拿存檔的數字打分數，完全不可能看答案。';
function fwBlock(title: string, n: number, body: string, wait: string): string {
  return `<div class="pd-fw"><h3 class="pd-sub">實盤成績（事前存檔）</h3><p class="muted pd-small">${FW_INTRO}</p>${n ? `<p class="pd-fw-sum">${title}</p>${body}` : `<p class="muted">${wait}</p>`}</div>`;
}
function fwStocks(f: PredictData['forward']): string {
  const x = f?.stocks;
  if (!x) return '';
  const rows = x.rows.map((r) => `<tr><td class="num">${esc(r.asOf)}</td><td class="num">${num(r.ic, 3)}</td><td class="num ${cls(r.top - r.all)}">${pctTxt(r.top - r.all)}</td><td class="num ${cls(r.bottom - r.all)}">${pctTxt(r.bottom - r.all)}</td><td class="num ${cls(r.market)}">${pctTxt(r.market)}</td></tr>`).join('');
  return fwBlock(
    `${x.n} 期：平均 IC <b>${num(x.icMean ?? 0, 3)}</b>・最看好 30 檔比全部平均 <b class="${cls(x.topExcess)}">${pctTxt(x.topExcess)}</b>・最該避開 15 檔比全部平均 <b class="${cls(x.bottomExcess)}">${pctTxt(x.bottomExcess)}</b>`,
    x.n,
    `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>預測日</th><th class="num">IC</th><th class="num">最看好 vs 平均</th><th class="num">最該避開 vs 平均</th><th class="num">大盤</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    '從今天開始存檔；個股看 20 個交易日，所以約一個月後出現第一筆。',
  );
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

function entryExitHtml(e: PredictData['stocks']['entryExit']): string {
  if (!e) return '';
  const b = e.backtest;
  const row = (name: string, x: { perSignal: number; fill: number; win: number; days: number; worst: number; p10: number }, hl = false) =>
    `<tr${hl ? ' class="pd-sum-row"' : ''}><td>${esc(name)}</td><td class="num ${cls(x.perSignal)}">${pctTxt(x.perSignal, 2)}</td><td class="num">${num(x.fill * 100, 0)}%</td><td class="num">${num(x.win * 100, 0)}%</td><td class="num">${num(x.days, 1)}</td><td class="num down">${pctTxt(x.worst)}</td><td class="num down">${pctTxt(x.p10)}</td></tr>`;
  return `<h3 class="pd-sub">進場與出場</h3>
    <p class="pd-advice"><b>目前的方式：${esc(e.plan.name)}，最晚 20 個交易日後出場。</b>
      進出場方式（等拉回再買、停利、停損，依各股近 14 天平均振幅 ATR 設定，共 64 種）每一期只用「已經結束的期間」挑最賺的；回測顯示單純持有最好，所以模型選了它。
      想控制風險可以用表格裡的<b>參考停損</b>（收盤 − 2.5×ATR）：代價是平均報酬變低，好處是最慘的虧損變小（見下表）。</p>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>方式（樣本外 ${num(b.periods)} 期、每期最看好 30 檔）</th><th class="num">每個訊號平均</th><th class="num">買得到</th><th class="num">勝率</th><th class="num">平均持有天數</th><th class="num">最慘一筆</th><th class="num">最差 10%</th></tr></thead>
    <tbody>${row('逐段往前滾自動挑的方式', b.strategy, true)}${row('隔天開盤買、20 天後賣', b.baseline)}${b.reference.map((r) => row(r.name, r)).join('')}</tbody></table></div>
    <p class="muted pd-small">全部扣成本（手續費 6 折來回＋證交稅）。「每個訊號平均」把沒買到的算 0（錢沒在賺）。模擬保守：跳空直接用開盤價成交；同一天碰到停利與停損當作先停損。</p>`;
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

function stocksHtml(s: PredictData['stocks'], h: number, f?: PredictData['forward']): string {
  const b = s.backtest;
  return `<section class="pd-card glass" id="pd-stocks">
    <header class="pd-head"><div><p class="eyebrow">Stocks · ${h} 日</p><h2>個股排名</h2></div>${badge(s.verdict)}</header>
    <p class="pd-lead">每天收盤後替 ${num(s.universe)} 檔（近 20 日平均成交額 0.3 億以上）打分數：預測未來 ${h} 個交易日<b>相對其他股票</b>的強弱。分數是全市場排名百分位（100＝最看好）。資料到 ${md(s.asOf)}。</p>
    <div class="pd-cols">
      <div><h3 class="pd-sub">最看好 <small class="muted">前 30 名</small></h3>${pickTable(s.top, 'top')}</div>
      <div><h3 class="pd-sub">最該避開 <small class="muted">後 15 名</small></h3>${pickTable(s.bottom, 'bottom')}</div>
    </div>
    <h3 class="pd-sub">回測（${b.from.slice(0, 7)} ～ ${b.to.slice(0, 7)}，樣本外，每 ${h} 天換一次）</h3>
    <dl class="pd-stats">
      <div><dt>排名相關係數（IC）</dt><dd class="num">${num(b.icMean, 3)} <small class="muted">t ${num(b.icT, 1)}</small></dd></div>
      <div><dt>IC 為正的比例</dt><dd class="num">${pctTxt(b.icPositive, 0, false)}</dd></div>
      <div><dt>前 10% 年化（扣成本）</dt><dd class="num ${cls(b.cagrTop)}">${pctTxt(b.cagrTop)}</dd></div>
      <div><dt>同期大盤年化</dt><dd class="num ${cls(b.cagrMarket)}">${pctTxt(b.cagrMarket)}</dd></div>
      <div><dt>贏過大盤的期數</dt><dd class="num">${pctTxt(b.hitRate, 0, false)}</dd></div>
      <div><dt>最大回落</dt><dd class="num down">${pctTxt(b.maxDD)}</dd></div>
    </dl>
    ${lineChart(b.curve, [{ name: '前 10%（扣成本）', cls: 's1' }, { name: '全部股票平均', cls: 's2' }, { name: '加權指數', cls: 's3' }], { log: true })}
    <p class="pd-note">IC（預測排名和實際排名的相關係數）長期為正，代表<b>排序有統計上的意義</b>，主要是能挑出<b>表現較差、該避開</b>的股票；
      前段班平均只略好於全體。近幾年大盤主要由權值股（台積電等）拉動，多數股票跑輸指數，所以「前 10%」等權組合也沒贏過加權指數。
      成本以手續費 6 折來回＋證交稅 ${pctTxt(b.cost, 2, false)} 計算。</p>
    <details class="pd-more"><summary>模型權重（每個因子排名每高一級，預測排名的變化）</summary>
      <ul class="pd-weights">${[...s.weights]
        .sort((a, c) => Math.abs(c.w) - Math.abs(a.w))
        .map((w) => `<li><span>${esc(w.name)}</span><b class="num ${cls(w.w)}">${w.w > 0 ? '+' : ''}${num(w.w, 3)}</b></li>`)
        .join('')}</ul>
      <p class="muted">只列線性部分；模型另外有每個因子的平方項，抓「太極端反而不好」的關係（例如漲太多、波動太大）。</p>
    </details>
    ${entryExitHtml(s.entryExit)}
    ${fwStocks(f)}
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
const intraState: IntradayState = { mode: '', k: -1, showActual: true, showAnalogs: true, showCandles: false, showBand: false, showLevels: true };
let analogLib: AnalogDay[] | null = null;
/** 即時的加權指數（只有富果／證交所即時行情才有；收盤回放是模擬走勢，不能用）。 */
export type LiveIndex = () => IndexPoint[] | null;
let liveIndex: LiveIndex = () => null;
let liveTimer: ReturnType<typeof setInterval> | undefined;

export function renderPredictPage(root: HTMLElement, onStock: (code: string) => void, getLive?: LiveIndex): void {
  if (getLive) liveIndex = getLive;
  if (!loading) {
    loading = true;
    void Promise.all([loadPredict(), loadPredictIntraday(), loadAnalogs()]).then(([d, i, a]) => {
      data = d;
      intra = i;
      analogLib = a;
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
  if (!intraState.mode) intraState.mode = live.ok ? 'live' : '';
  el.outerHTML = intradayHtml(intra, intraState, live, analogLib);
  bindIntra(root);
}

function bindIntra(root: HTMLElement): void {
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
  const summary = `<div class="pd-summary">
    <a href="#pd-stocks" class="pd-sum glass"><span>個股排名</span>${badge(d.stocks.verdict)}</a>
    <a href="#pd-market" class="pd-sum glass"><span>大盤展望</span>${badge(d.market.verdict)}</a>
    ${d.dayTrade ? `<a href="#pd-day" class="pd-sum glass"><span>${esc(d.dayTrade.code)} 當沖（開盤→收盤）</span>${badge(d.dayTrade.verdict)}</a>` : ''}
    ${intra?.ready ? `<a href="#pd-intra" class="pd-sum glass"><span>00631L 整天 5 分 K</span>${badge(intra.rangeVerdict ?? intra.verdict)}</a>` : ''}
  </div>`;
  root.innerHTML = `<div class="pd-main">${head}${summary}
    ${stocksHtml(d.stocks, d.horizon, d.forward)}
    ${marketHtml(d.market, d.horizon, d.forward)}
    ${d.dayTrade ? dayTradeHtml(d.dayTrade, d.forward) : ''}
    <section id="pd-intra"></section>
    <p class="muted pd-foot">預測是依歷史資料統計的結果，<b>不構成投資建議</b>；過去的回測成績不代表未來。更新時間 ${esc(new Date(d.generatedAt).toLocaleString('zh-TW', { hour12: false }))}。</p>
  </div>`;

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
