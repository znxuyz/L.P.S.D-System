/**
 * 預測頁的「00631L 整天 5 分 K 預測」：
 * - 以 5 分鐘為單位，把整天（09:00～13:30，54 根）的 K 棒預測出來：已經走完的畫實心、預測的畫空心，
 *   收盤價約 80% 區間畫陰影，預估的今日最高、最低畫虛線。
 * - 預測時間可以選開盤前、開盤或盤中任何一根之後；每走完一根就用最新走勢重新預測剩下的。
 * - 有即時行情（富果／證交所）時預測今天；否則回放最近 10 天，可以疊上實際走勢比對誤差。
 * - 00631L 的價格由加權指數換算（β 倍），不是 00631L 真實的 5 分 K。
 */
import type { IndexPoint } from '../data/types';
import { BARS, analogLines, avgOf, barRange, blendLine, forecastDay, toLeveraged, type AnalogDay, type Bar, type DailyCtx, type DayForecast, type DayModel, type IntradayModel } from '../domain/intradayModel';
import { escapeHtml as esc, num } from './format';

type Verdict = 'signal' | 'none';
export type LineId = 'blend' | 'model' | 'avg' | 'a1' | 'a2' | 'a3';
const LINE_NAME: Record<LineId, string> = { blend: '綜合預測', model: '模型主線', avg: '相似日平均', a1: '相似日 1', a2: '相似日 2', a3: '相似日 3' };
const LINE_IDS: LineId[] = ['blend', 'model', 'avg', 'a1', 'a2', 'a3'];

export interface IntradayData {
  generatedAt: string;
  ready: boolean;
  days?: number;
  beta: number;
  model: IntradayModel;
  day: DayModel;
  verdict: Verdict;
  rangeVerdict: Verdict;
  backtest: {
    from: string;
    to: string;
    days: number;
    byOrigin: Array<{ origin: number; label: string; pathRmse: number; pathNaive: number; coverage: number; rangeMae: number; rangeNaive: number; rangeR2: number; hlMae: number; hlNaive: number }>;
  };
  /** 各種預測線的樣本外成績：每根收盤誤差（RMSE）、收盤方向命中率、最接近實際的比例。 */
  lines?: Array<{ origin: number; label: string } & Record<LineId, { rmse: number; hit: number; best: number }>>;
  /** 最近的預測紀錄（開盤前與 10:00）：預測收盤 vs 實際。 */
  record?: Array<{ date: string; origin: number; ref: number; blend?: number; model: number; avg: number; actual: number }>;
  /** 各預測時間點自動挑的設定：相似日平均用幾天（n）、綜合預測給模型的權重（w）。 */
  choice?: Array<{ origin: number; n: number; w: number }>;
  next: { after: string; P0: number; L0: number | null; ctx: Record<keyof DailyCtx, number | null> };
  recent: Array<{ date: string; P0: number; L0: number | null; ix: Bar[]; ctx: Record<keyof DailyCtx, number | null> }>;
}

const ctxOf = (c: Record<keyof DailyCtx, number | null>): DailyCtx => ({
  prevDay: c.prevDay ?? NaN,
  prev5: c.prev5 ?? NaN,
  prevIntra: c.prevIntra ?? NaN,
  futChg: c.futChg ?? NaN,
  prevRange: c.prevRange ?? NaN,
});
/** 第 bar 根的開始時間。 */
const clock = (bar: number) => {
  const m = 9 * 60 + bar * 5;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const kLabel = (k: number) => (k < 0 ? '開盤前' : k === 0 ? '09:00 開盤' : `${clock(k)}`);
const pctTxt = (v: number, d = 2) => `${v > 0 ? '+' : ''}${num(v * 100, d)}%`;
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** 即時的加權指數（每分鐘或更密）→ 今天已經走完的 5 分 K 與開盤價。 */
export function liveBars(series: IndexPoint[], openMs: number): { open: number | null; bars: Bar[] } {
  const pts = series.filter((p) => p.t >= openMs && p.t <= openMs + BARS * 300_000 && p.v > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return { open: null, bars: [] };
  const bars: Bar[] = [];
  const last = pts[pts.length - 1].t;
  let i = 0;
  for (let b = 0; b < BARS; b++) {
    const end = openMs + (b + 1) * 300_000;
    if (last < end - 30_000) break; // 這根還沒走完
    const inBar: number[] = [];
    while (i < pts.length && pts[i].t <= end) inBar.push(pts[i++].v);
    const prevClose = bars.length ? bars[bars.length - 1][3] : pts[0].v;
    const vals = inBar.length ? inBar : [prevClose];
    bars.push([prevClose, Math.max(prevClose, ...vals), Math.min(prevClose, ...vals), vals[vals.length - 1]]);
  }
  return { open: pts[0].v, bars };
}

interface View {
  live: boolean;
  P0: number;
  L0: number | null;
  ctx: DailyCtx;
  /** 已經知道的 K 棒（回放是整天）。 */
  ix: Bar[];
  open: number | null;
  /** 預測時間：-1 開盤前、0 開盤、k 第 k 根收盤後。 */
  k: number;
}

type Analogs = ReturnType<typeof analogLines> | null;

/** 各條預測線：c 的索引（0＝開盤、b＝第 b 根收盤）→ 價格，含起點。 */
/** 預測時間 k 對應的自動設定（用最接近的回測時間點）。 */
function choiceFor(d: IntradayData, k: number): { n: number; w: number } {
  const cs = d.choice ?? [];
  if (!cs.length) return { n: 5, w: 1 };
  return cs.reduce((best, c) => (Math.abs(c.origin - k) < Math.abs(best.origin - k) ? c : best), cs[0]);
}

function lineSeries(v: View, f: DayForecast, an: Analogs, ch: { n: number; w: number } = { n: 5, w: 1 }): Partial<Record<LineId, Array<[number, number]>>> {
  const out: Partial<Record<LineId, Array<[number, number]>>> = {};
  const pre = v.k < 0;
  const start: [number, number] = pre ? [0, f.open] : [f.from, f.from === 0 ? f.open : v.ix[f.from - 1][3]];
  out.model = [start, ...f.bars.map((b) => [b.bar + 1, b.c] as [number, number])];
  if (an && an.lines.length) {
    // 相似日：開盤前從各自的開盤畫起；盤中從現在的價格接下去
    const conv = (closes: number[]): Array<[number, number]> => (pre ? closes.map((c, i) => [an.from + i, c]) : [[f.from, start[1]], ...closes.map((c, i) => [an.from + i, c] as [number, number])]);
    const avgN = avgOf(an.lines, ch.n);
    out.avg = conv(avgN);
    const modelCloses = pre ? [f.open, ...f.bars.map((b) => b.c)] : f.bars.map((b) => b.c);
    out.blend = conv(blendLine(modelCloses, avgN, ch.w));
    an.lines.slice(0, 3).forEach((l, i) => (out[`a${i + 1}` as LineId] = conv(l.closes)));
  }
  return out;
}

function chart(d: IntradayData, v: View, f: DayForecast, st: IntradayState, an: Analogs): string {
  const W = 760;
  const H = 320;
  const pad = { l: 54, r: 12, t: 12, b: 24 };
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const known = v.ix.slice(0, f.from);
  const future = st.showActual && !v.live ? v.ix.slice(f.from) : [];
  const series = lineSeries(v, f, an, choiceFor(d, v.k));
  const shown = LINE_IDS.filter((id) => series[id] && (id === 'blend' || id === 'model' || st.showAnalogs));
  const vals = [
    ...known.flatMap((b) => [b[1], b[2]]),
    ...future.flatMap((b) => [b[1], b[2]]),
    ...shown.flatMap((id) => series[id]!.map((p) => p[1])),
    ...(st.showCandles ? f.bars.flatMap((b) => [b.h, b.l]) : []),
    f.dayHigh,
    f.dayLow,
    v.P0,
  ].map(L);
  const span = Math.max(...vals) - Math.min(...vals) || 1;
  const lo = Math.min(...vals) - span * 0.04;
  const hi = Math.max(...vals) + span * 0.04;
  const bw = (W - pad.l - pad.r) / BARS;
  const cx = (bar: number) => pad.l + (bar + 0.5) * bw;
  /** c 的索引 → x（第 b 根收盤畫在那根 K 棒的右緣附近）。 */
  const xi = (i: number) => (i === 0 ? pad.l + bw * 0.15 : cx(i - 1) + bw * 0.35);
  const sy = (x: number) => pad.t + (1 - (L(x) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const candle = (bar: number, [o, h, l, c]: Bar, kind: string) => {
    const x = cx(bar);
    const top = sy(Math.max(o, c));
    const bot = sy(Math.min(o, c));
    return `<g class="${c >= o ? 'k-up' : 'k-down'} ${kind}"><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${sy(h).toFixed(1)}" y2="${sy(l).toFixed(1)}"/><rect x="${(x - bw * 0.34).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
  };
  const startX = pad.l + f.from * bw;
  const startY = sy(f.from === 0 ? f.open : v.ix[f.from - 1][3]);
  const band =
    st.showBand && f.bars.length
      ? `M${startX.toFixed(1)},${startY.toFixed(1)}${f.bars.map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.hi).toFixed(1)}`).join('')}${[...f.bars].reverse().map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.lo).toFixed(1)}`).join('')}Z`
      : '';
  const hline = (y: number, label: string, c: string) =>
    `<line class="pd-hl ${c}" x1="${startX.toFixed(1)}" x2="${W - pad.r}" y1="${sy(y).toFixed(1)}" y2="${sy(y).toFixed(1)}"/><text class="pd-tick ${c}" x="${W - pad.r - 2}" y="${(sy(y) + (c === 'is-hi' ? -4 : 12)).toFixed(1)}" text-anchor="end">${label} ${num(L(y), 2)}</text>`;
  // 先畫相似日（細線），模型主線最後畫（最上層）
  const order = [...shown].reverse();
  const path = (id: LineId) => `<path class="pd-ln ln-${id}" d="${series[id]!.map(([i, p], n) => `${n ? 'L' : 'M'}${xi(i).toFixed(1)},${sy(p).toFixed(1)}`).join('')}"/>`;
  const endLabel = (id: LineId) => {
    const pts = series[id]!;
    const [i, p] = pts[pts.length - 1];
    return `<circle class="pd-end ln-${id}" cx="${xi(i).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="3"/>`;
  };
  const ticks = [lo, (lo + hi) / 2, hi];
  const dates = an?.lines.slice(0, 3).map((l) => l.date) ?? [];
  return `<div class="pd-intra-scroll"><svg class="pd-chart pd-intra-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="整天 5 分 K 預測線">
    <defs><clipPath id="pd-clip"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath></defs>
    <line class="pd-base" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v.P0).toFixed(1)}" y2="${sy(v.P0).toFixed(1)}"/>
    <text class="pd-tick" x="${pad.l + 4}" y="${(sy(v.P0) - 4).toFixed(1)}">昨收 ${num(L(v.P0), 2)}</text>
    ${band ? `<path class="pd-band" clip-path="url(#pd-clip)" d="${band}"/>` : ''}
    ${hline(f.dayHigh, '預估最高', 'is-hi')}${hline(f.dayLow, '預估最低', 'is-lo')}
    ${known.map((b, i) => candle(i, b, 'is-real')).join('')}
    ${future.map((b, i) => candle(f.from + i, b, 'is-actual')).join('')}
    ${st.showCandles ? f.bars.map((b) => candle(b.bar, [b.o, b.h, b.l, b.c], 'is-pred')).join('') : ''}
    <g clip-path="url(#pd-clip)">${order.map(path).join('')}${order.map(endLabel).join('')}</g>
    ${f.from > 0 ? `<line class="pd-now" x1="${startX.toFixed(1)}" x2="${startX.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>` : ''}
    ${ticks.map((t) => `<text class="pd-tick" x="${pad.l - 6}" y="${(pad.t + (1 - (t - lo) / (hi - lo || 1)) * (H - pad.t - pad.b) + 4).toFixed(1)}" text-anchor="end">${num(t, 2)}</text>`).join('')}
    ${[0, 12, 24, 36, 48].map((b) => `<text class="pd-tick" x="${(pad.l + b * bw).toFixed(1)}" y="${H - 6}" text-anchor="${b === 0 ? 'start' : 'middle'}">${clock(b)}</text>`).join('')}
    <text class="pd-tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end">13:30</text>
  </svg></div>
  <p class="pd-legend pd-intra-legend">
    ${series.blend ? '<span class="lg-blend"><i></i>綜合預測（主要預測線）</span>' : ''}<span class="lg-model"><i></i>模型主線</span>
    ${st.showAnalogs && series.avg ? `<span class="lg-avg"><i></i>相似日平均（前 ${choiceFor(d, v.k).n} 名）</span>${dates.map((dt, i) => `<span class="lg-a${i + 1}"><i></i>相似日 ${i + 1}：${esc(dt)}</span>`).join('')}` : ''}
    <span class="pd-key-real"><i></i>已走完</span>${future.length ? '<span class="pd-key-actual"><i></i>實際走勢（當時還不知道）</span>' : ''}
    <span class="pd-key-hl"><i></i>預估今日最高／最低</span>${band ? '<span class="pd-band-key"><i></i>收盤約 80% 區間</span>' : ''}
  </p>`;
}

/** 回放：這一天每條線的誤差與收盤方向對不對。 */
function lineErrors(d: IntradayData, v: View, f: DayForecast, an: Analogs, lev: number): Array<{ id: LineId; rmse: number; dirOk: boolean }> | null {
  if (v.live || v.ix.length < BARS) return null;
  const series = lineSeries(v, f, an, choiceFor(d, v.k));
  const ref = v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  const act = (i: number) => (i === 0 ? v.ix[0][0] : v.ix[i - 1][3]);
  const actClose = v.ix[BARS - 1][3];
  return LINE_IDS.filter((id) => series[id]).map((id) => {
    // 起點不算（開盤前的模型與相似日起點都是預測的開盤，要算）
    const pts = series[id]!.filter((_, n) => v.k < 0 || n > 0);
    const se = pts.reduce((s, [i, p]) => s + Math.log(p / act(i)) ** 2, 0);
    const lastP = pts[pts.length - 1][1];
    return { id, rmse: Math.sqrt(se / (pts.length || 1)) * lev, dirOk: Math.sign(lastP - ref) === Math.sign(actClose - ref) };
  });
}

/** 這一天（回放）預測的誤差：跟實際比。 */
function dayErrors(d: IntradayData, v: View, f: DayForecast) {
  const lev = v.L0 ? d.beta : 1;
  if (v.live || v.ix.length < BARS || !f.bars.length) return null;
  const ref = v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  let pe = 0;
  let pn = 0;
  let re = 0;
  let inBand = 0;
  for (const b of f.bars) {
    const a = v.ix[b.bar];
    pe += Math.log(b.c / a[3]) ** 2;
    pn += Math.log(ref / a[3]) ** 2;
    re += Math.abs(Math.log(b.h / b.l) - barRange(a));
    if (a[3] >= b.lo && a[3] <= b.hi) inBand++;
  }
  const n = f.bars.length;
  const hiA = Math.max(...v.ix.map((b) => b[1]));
  const loA = Math.min(...v.ix.map((b) => b[2]));
  return {
    path: Math.sqrt(pe / n) * lev,
    naive: Math.sqrt(pn / n) * lev,
    range: (re / n) * lev,
    inBand: inBand / n,
    hiErr: Math.log(f.dayHigh / hiA) * lev,
    loErr: Math.log(f.dayLow / loA) * lev,
  };
}

/** 預測邏輯（白話）。 */
function logicHtml(d: IntradayData): string {
  const ch = (d.choice ?? []).map((c) => `${c.origin < 0 ? '開盤前' : c.origin === 0 ? '開盤' : clock(c.origin)}：相似日 ${c.n} 天、模型 ${Math.round(c.w * 100)}%`).join('；');
  return `<details class="pd-more pd-logic"><summary>預測邏輯（怎麼算出這些線）</summary>
    <ol class="pd-logic-list">
      <li><b>資料</b>：2020 年以來每天的加權指數 5 分 K（證交所每 5 秒指數統計），加上日 K、外資台指期淨未平倉。00631L 沒有公開的歷史盤中資料，用「β × 加權指數報酬」換算（β ≈ ${num(d.beta, 2)}，近一年日報酬估計）。</li>
      <li><b>開盤前</b>：用昨天的漲跌、近 5 日、昨天開盤到收盤、昨天振幅、外資期貨增減，預測開盤跳空。</li>
      <li><b>模型主線</b>：每 5 分鐘看「現在的狀態」——時間、跳空、開盤到現在、最近 1／3／6 根的漲跌、今天的波動、在今天高低區間的位置、前一天的資料——用嶺迴歸分別預測接下來 1、2、3、6、12 根與到收盤的報酬，再連成一條線。每次訓練把最後 20% 的資料留做驗證，從幾種強度裡挑誤差最小的；方向越難預測，模型會自動越保守（線越平）。</li>
      <li><b>相似日走勢</b>：把歷史上每一天都跟今天比——開盤前的資料、跳空、到目前為止的走勢形狀（最近 6 根加重）都先除以各自的波動——找出最像的 20 天。前 3 名各畫一條（依波動比例縮放、接在現在的價格後面），前 n 名平均成「相似日平均」。</li>
      <li><b>綜合預測</b>：模型主線與相似日平均依權重混合。相似日要取幾天（5／10／20）、模型佔多少（0～100%），每個預測時間點分開挑：用「到前一天為止」所有回測日的實際誤差，選誤差最小的組合。目前：${esc(ch)}。</li>
      <li><b>振幅與高低點</b>：每根 K 棒的振幅＝這個時段平常的振幅 × 今天／昨天的波動延續；今天剩下時間的最高最低另外預測。80% 區間依時段與當天波動放大縮小，回測校準過。</li>
      <li><b>持續修正</b>：每天資料更新、網站部署時，用最新的全部資料重新訓練、重新挑設定、重新計算所有回測成績；回測一律「逐段往前滾」——每一天只用那天以前的資料預測，跟實際使用時一樣。</li>
    </ol>
  </details>`;
}

/** 各條預測線的回測成績表。 */
function linesTable(d: IntradayData, lev: number): string {
  if (!d.lines?.length) return '';
  const head = d.lines.map((o) => `<th class="num">${esc(o.label)}</th>`).join('');
  const rows = LINE_IDS.map((id) => {
    const cells = d.lines!.map((o) => {
      const x = o[id];
      const best = Math.min(...LINE_IDS.map((j) => o[j].rmse));
      return `<td class="num"><b class="${x.rmse === best ? 'up' : ''}">${num(x.rmse * lev * 100, 2)}%</b><br><small>方向 ${num(x.hit * 100, 0)}%・最準 ${num(x.best * 100, 0)}%</small></td>`;
    });
    return `<tr><td><span class="lg-${id}"><i></i>${LINE_NAME[id]}</span></td>${cells.join('')}</tr>`;
  }).join('');
  return `<h3 class="pd-sub">每條線準不準（回測 ${esc(d.backtest.from)} ～ ${esc(d.backtest.to)}，${num(d.backtest.days)} 天，樣本外）</h3>
    <div class="pd-table-wrap"><table class="pd-table pd-lines-table"><thead><tr><th>預測線＼預測時間</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted pd-small">大字：每根 5 分 K 收盤價的平均誤差（換算成 00631L，越小越準，紅色是該時間點最準的線）。方向：預測的收盤比現在高或低，跟實際一致的比例（50% 等於擲硬幣）。最準：五條線裡這條最接近實際走勢的天數比例。</p>`;
}

/** 最近的預測紀錄（開盤前預測的收盤 vs 實際）。 */
function recordTable(d: IntradayData, lev: number): string {
  const rec = (d.record ?? []).filter((r) => r.origin === -1).slice(-20).reverse();
  if (!rec.length) return '';
  const p = (x: number, ref: number) => Math.log(x / ref) * lev;
  const mark = (x: number, r: (typeof rec)[number]) => (Math.sign(x - r.ref) === Math.sign(r.actual - r.ref) ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>');
  const ok = (key: 'blend' | 'model' | 'avg') => rec.filter((r) => Math.sign((r[key] ?? r.model) - r.ref) === Math.sign(r.actual - r.ref)).length;
  return `<details class="pd-more" open><summary>最近 ${rec.length} 天的預測紀錄（開盤前預測的收盤漲跌 vs 實際）</summary>
    <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>日期</th><th class="num">綜合預測</th><th class="num">模型主線</th><th class="num">相似日平均</th><th class="num">實際</th></tr></thead>
    <tbody>${rec
      .map((r) => `<tr><td class="num">${esc(r.date)}</td><td class="num ${cls((r.blend ?? r.model) - r.ref)}">${pctTxt(p(r.blend ?? r.model, r.ref))} ${mark(r.blend ?? r.model, r)}</td><td class="num ${cls(r.model - r.ref)}">${pctTxt(p(r.model, r.ref))} ${mark(r.model, r)}</td><td class="num ${cls(r.avg - r.ref)}">${pctTxt(p(r.avg, r.ref))} ${mark(r.avg, r)}</td><td class="num ${cls(r.actual - r.ref)}">${pctTxt(p(r.actual, r.ref))}</td></tr>`)
      .join('')}
      <tr class="pd-sum-row"><td>方向猜對</td><td class="num">${ok('blend')}／${rec.length}</td><td class="num">${ok('model')}／${rec.length}</td><td class="num">${ok('avg')}／${rec.length}</td><td></td></tr></tbody></table></div>
  </details>`;
}

export interface IntradayState {
  /** 'live' 或回放日期。 */
  mode: string;
  /** -1 開盤前、0 開盤、1～53。 */
  k: number;
  showActual: boolean;
  /** 相似日走勢線、預測 K 棒、80% 區間要不要畫。 */
  showAnalogs: boolean;
  showCandles: boolean;
  showBand: boolean;
}

export function intradayHtml(d: IntradayData | null | undefined, st: IntradayState, live: { open: number | null; bars: Bar[]; ok: boolean; why: string }, lib: AnalogDay[] | null): string {
  const head = (badge: string) => `<header class="pd-head"><div><p class="eyebrow">Intraday · 5 分 K</p><h2>00631L 整天 5 分 K 預測線</h2></div>${badge}</header>`;
  if (d === undefined) return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">載入中⋯⋯</p></section>`;
  if (!d || !d.ready || !d.day)
    return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">正在收集加權指數 5 分 K 的歷史資料（目前 ${d?.days ?? 0} 天，至少要 60 天才會開始訓練；每小時往回補一批）。</p></section>`;
  const vb = (v: Verdict, yes: string, no: string) => `<span class="pd-verdict ${v === 'signal' ? 'is-ok' : 'is-warn'}">${v === 'signal' ? `✅ ${yes}` : `⚠️ ${no}`}</span>`;
  const badges = `<div class="pd-badges">${vb(d.rangeVerdict, '振幅與高低點：盤中比簡單猜法準', '振幅與高低點沒有比簡單猜法準')}${vb(d.verdict, '漲跌方向有預測能力', '漲跌方向沒有預測能力')}</div>`;
  let v: View;
  if (st.mode === 'live' && live.ok) {
    const k = Math.min(BARS - 1, live.bars.length);
    v = { live: true, P0: d.next.P0, L0: d.next.L0, ctx: ctxOf(d.next.ctx), ix: live.bars, open: live.open, k: live.open == null ? -1 : k };
  } else {
    const day = d.recent.find((r) => r.date === st.mode) ?? d.recent[d.recent.length - 1];
    st.mode = day.date;
    v = { live: false, P0: day.P0, L0: day.L0, ctx: ctxOf(day.ctx), ix: day.ix, open: day.ix[0][0], k: Math.max(-1, Math.min(BARS - 1, st.k)) };
  }
  const f = forecastDay(d.model, d.day, v.ix, v.k, v.k < 0 ? null : v.open, v.P0, v.ctx);
  // 相似日：只從這一天以前的日子找（回放時不會用到之後的資料）
  const viewDate = v.live ? '9999' : st.mode;
  const an: Analogs = lib && lib.length
    ? analogLines(
        lib.filter((a) => a.date < viewDate),
        { k: v.k, gap: v.k < 0 ? NaN : Math.log(f.open / v.P0), r: [f.open, ...v.ix.slice(0, Math.max(0, v.k)).map((b) => b[3])].map((x) => Math.log(x / f.open)), ctx: v.ctx },
        v.k < 0 ? v.P0 : f.from === 0 ? f.open : v.ix[f.from - 1][3],
        20,
        20,
      )
    : null;
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const lev = v.L0 ? d.beta : 1;
  const last = f.bars[f.bars.length - 1];
  const now = v.k < 0 ? null : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  const err = dayErrors(d, v, f);
  const lerr = lineErrors(d, v, f, an, lev);
  // 上方的「預測收盤」用綜合預測（主要預測線）；沒有相似日資料時用模型主線
  const mainSeries = lineSeries(v, f, an, choiceFor(d, v.k)).blend;
  const mainClose = mainSeries?.length ? mainSeries[mainSeries.length - 1][1] : last?.c;
  const actualClose = !v.live && v.ix.length === BARS ? v.ix[BARS - 1][3] : null;
  const opts = [
    `<option value="live" ${st.mode === 'live' ? 'selected' : ''} ${live.ok ? '' : 'disabled'}>今天（即時）${live.ok ? '' : `－${esc(live.why)}`}</option>`,
    ...[...d.recent].reverse().map((r) => `<option value="${r.date}" ${st.mode === r.date ? 'selected' : ''}>回放 ${r.date}</option>`),
  ].join('');
  const b = d.backtest;
  const pct2 = (x: number) => `${num(x * lev * 100, 2)}%`;
  return `<section class="pd-card glass" id="pd-intra">${head(badges)}
    <p class="pd-lead">以 5 分鐘為單位畫出整天（09:00～13:30，54 根）的預測線：<b>模型主線</b>是統計上誤差最小的預測；<b>相似日走勢線</b>是從歷史裡找出到目前為止跟今天最像的幾天，把它們接下來的真實走勢（依波動比例縮放）接在現在的價格後面。
      開盤前先預測跳空，盤中每走完一根就重新預測。下面列出每條線過去的準確度。
      00631L 的價格用「加權指數 × ${num(d.beta, 2)} 倍」換算（近一年日報酬估計）。</p>
    <div class="pd-intra-ctrl">
      <label>看哪一天<select id="pd-intra-day">${opts}</select></label>
      ${v.live ? `<span class="muted">每 30 秒更新</span>` : `<label class="pd-intra-k">預測時間 <b class="num" id="pd-intra-clock">${kLabel(v.k)}</b><input type="range" id="pd-intra-k" min="-1" max="${BARS - 1}" step="1" value="${v.k}" /></label>
      <label class="pd-check"><input type="checkbox" id="pd-intra-actual" ${st.showActual ? 'checked' : ''} />疊上實際走勢</label>`}
    </div>
    <div class="pd-intra-ctrl pd-intra-opts">
      <label class="pd-check"><input type="checkbox" data-opt="showAnalogs" ${st.showAnalogs ? 'checked' : ''} />相似日走勢線</label>
      <label class="pd-check"><input type="checkbox" data-opt="showCandles" ${st.showCandles ? 'checked' : ''} />預測 K 棒</label>
      <label class="pd-check"><input type="checkbox" data-opt="showBand" ${st.showBand ? 'checked' : ''} />80% 區間</label>
    </div>
    <dl class="pd-stats pd-intra-stats">
      <div><dt>預測時間</dt><dd class="num">${kLabel(v.k)}</dd></div>
      <div><dt>${now == null ? '預測開盤' : '現在'}</dt><dd class="num">${num(L(now ?? f.open), 2)}${now == null ? ` <small class="${cls(f.open - v.P0)}">${pctTxt(Math.log(f.open / v.P0) * lev)}</small>` : ''}</dd></div>
      <div><dt>預測收盤（綜合）</dt><dd class="num ${cls((mainClose ?? v.P0) - v.P0)}">${mainClose ? num(L(mainClose), 2) : '—'} <small>${mainClose ? pctTxt(Math.log(mainClose / v.P0) * lev) : ''}</small></dd></div>
      <div><dt>收盤約 80% 區間</dt><dd class="num">${last ? `${num(L(last.lo), 2)}～${num(L(last.hi), 2)}` : '—'}</dd></div>
      <div><dt>預估今日最高／最低</dt><dd class="num"><span class="up">${num(L(f.dayHigh), 2)}</span>／<span class="down">${num(L(f.dayLow), 2)}</span></dd></div>
      ${actualClose != null ? `<div><dt>實際收盤／最高／最低</dt><dd class="num">${num(L(actualClose), 2)} <small>${num(L(Math.max(...v.ix.map((x) => x[1]))), 2)}／${num(L(Math.min(...v.ix.map((x) => x[2]))), 2)}</small></dd></div>` : ''}
    </dl>
    ${chart(d, v, f, st, an)}
    ${
      err
        ? `<p class="pd-day-err">這一次預測的誤差：每根收盤價 <b>${pctTxt(err.path, 2).replace('+', '')}</b>（假設不會動是 ${pctTxt(err.naive, 2).replace('+', '')}）・每根振幅 <b>${pctTxt(err.range, 2).replace('+', '')}</b>・
          區間涵蓋 <b>${num(err.inBand * 100, 0)}%</b>・最高點差 <b class="${cls(err.hiErr)}">${pctTxt(err.hiErr)}</b>・最低點差 <b class="${cls(err.loErr)}">${pctTxt(err.loErr)}</b></p>`
        : ''
    }
    ${
      lerr
        ? `<div class="pd-line-err">${lerr
            .sort((x, y) => x.rmse - y.rmse)
            .map((e, i) => `<span class="lg-${e.id}${i === 0 ? ' is-best' : ''}"><i></i>${LINE_NAME[e.id]}：每根誤差 <b>${num(e.rmse * 100, 2)}%</b>・收盤方向 ${e.dirOk ? '<b class="ok">✓ 對</b>' : '<b class="ng">✗ 錯</b>'}${i === 0 ? '・<b>這天最準</b>' : ''}</span>`)
            .join('')}</div>`
        : ''
    }
    ${logicHtml(d)}
    ${linesTable(d, lev)}
    ${recordTable(d, lev)}
    <h3 class="pd-sub">振幅、高低點與 80% 區間的回測（${b.from} ～ ${b.to}，${num(b.days)} 天，樣本外；誤差換算成 00631L）</h3>
    <div class="pd-table-wrap"><table class="pd-table">
      <thead><tr><th>預測時間</th><th class="num">每根收盤誤差<br><small>模型／不會動</small></th><th class="num">80% 區間<br><small>實際涵蓋</small></th><th class="num">每根振幅誤差<br><small>模型／時段平均</small></th><th class="num">今日高低點誤差<br><small>模型／平均幅度</small></th></tr></thead>
      <tbody>${b.byOrigin
        .map(
          (x) => `<tr><td>${esc(x.label)}</td>
          <td class="num"><b class="${x.pathRmse < x.pathNaive ? 'up' : ''}">${pct2(x.pathRmse)}</b>／${pct2(x.pathNaive)}</td>
          <td class="num">${num(x.coverage * 100, 0)}%</td>
          <td class="num"><b class="${x.rangeMae < x.rangeNaive ? 'up' : ''}">${pct2(x.rangeMae)}</b>／${pct2(x.rangeNaive)}</td>
          <td class="num"><b class="${x.hlMae < x.hlNaive ? 'up' : ''}">${pct2(x.hlMae)}</b>／${pct2(x.hlNaive)}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <p class="pd-note">誤差越小越好；粗體標紅的是比簡單猜法準的項目。<b>K 棒的振幅、今天的高低點</b>有時段特性（開盤與收盤前最大）跟波動延續，可以預測得比平均準；
      <b>漲跌方向</b>幾乎無法預測，所以誤差最小的預測線會很平滑、貼近現價，預測 K 棒的實體會很小、主要看影線（振幅）與區間。
      80% 區間的實際涵蓋接近 80% 代表區間畫得準。5 分 K 正在往前回補到 2020 年，資料越多模型越穩定；每天部署時都會用最新資料重新訓練。</p>
  </section>`;
}
