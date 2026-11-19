/**
 * 預測頁的「00631L 整天 5 分 K 預測」：
 * - 以 5 分鐘為單位，把整天（09:00～13:30，54 根）的 K 棒預測出來：已經走完的畫實心、預測的畫空心，
 *   收盤價約 80% 區間畫陰影，預估的今日最高、最低畫虛線。
 * - 預測時間可以選開盤前、開盤或盤中任何一根之後；每走完一根就用最新走勢重新預測剩下的。
 * - 有即時行情（富果／證交所）時預測今天；否則回放最近 10 天，可以疊上實際走勢比對誤差。
 * - 00631L 的價格由加權指數換算（β 倍），不是 00631L 真實的 5 分 K。
 */
import type { IndexPoint } from '../data/types';
import { BARS, barRange, forecastDay, toLeveraged, type Bar, type DailyCtx, type DayForecast, type DayModel, type IntradayModel } from '../domain/intradayModel';
import { escapeHtml as esc, num } from './format';

type Verdict = 'signal' | 'none';
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

function chart(d: IntradayData, v: View, f: DayForecast, showActual: boolean): string {
  const W = 760;
  const H = 300;
  const pad = { l: 54, r: 12, t: 12, b: 24 };
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const known = v.ix.slice(0, f.from);
  const future = showActual && !v.live ? v.ix.slice(f.from) : [];
  const vals = [
    ...known.flatMap((b) => [b[1], b[2]]),
    ...future.flatMap((b) => [b[1], b[2]]),
    // 縱軸只看 K 棒與高低點（區間很寬，超出的部分裁掉，預測的 K 棒才看得清楚）
    ...f.bars.flatMap((b) => [b.h, b.l]),
    f.dayHigh,
    f.dayLow,
    v.P0,
  ].map(L);
  const span = Math.max(...vals) - Math.min(...vals) || 1;
  const lo = Math.min(...vals) - span * 0.04;
  const hi = Math.max(...vals) + span * 0.04;
  const bw = (W - pad.l - pad.r) / BARS;
  const cx = (bar: number) => pad.l + (bar + 0.5) * bw;
  const sy = (x: number) => pad.t + (1 - (L(x) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const candle = (bar: number, [o, h, l, c]: Bar, kind: string) => {
    const x = cx(bar);
    const top = sy(Math.max(o, c));
    const bot = sy(Math.min(o, c));
    return `<g class="${c >= o ? 'k-up' : 'k-down'} ${kind}"><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${sy(h).toFixed(1)}" y2="${sy(l).toFixed(1)}"/><rect x="${(x - bw * 0.34).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
  };
  // 收盤價的 80% 區間（從預測起點開始）
  const startX = pad.l + f.from * bw;
  const startY = sy(f.from === 0 ? f.open : v.ix[f.from - 1][3]);
  const band = f.bars.length
    ? `M${startX.toFixed(1)},${startY.toFixed(1)}${f.bars.map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.hi).toFixed(1)}`).join('')}${[...f.bars].reverse().map((b) => `L${cx(b.bar).toFixed(1)},${sy(b.lo).toFixed(1)}`).join('')}Z`
    : '';
  const hline = (y: number, label: string, c: string) =>
    `<line class="pd-hl ${c}" x1="${startX.toFixed(1)}" x2="${W - pad.r}" y1="${sy(y).toFixed(1)}" y2="${sy(y).toFixed(1)}"/><text class="pd-tick ${c}" x="${W - pad.r - 2}" y="${(sy(y) + (c === 'is-hi' ? -4 : 12)).toFixed(1)}" text-anchor="end">${label} ${num(L(y), 2)}</text>`;
  const ticks = [lo, (lo + hi) / 2, hi];
  return `<div class="pd-intra-scroll"><svg class="pd-chart pd-intra-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="整天 5 分 K 預測">
    <defs><clipPath id="pd-clip"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath></defs>
    <line class="pd-base" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v.P0).toFixed(1)}" y2="${sy(v.P0).toFixed(1)}"/>
    <text class="pd-tick" x="${pad.l + 4}" y="${(sy(v.P0) - 4).toFixed(1)}">昨收 ${num(L(v.P0), 2)}</text>
    ${band ? `<path class="pd-band" clip-path="url(#pd-clip)" d="${band}"/>` : ''}
    ${hline(f.dayHigh, '預估最高', 'is-hi')}${hline(f.dayLow, '預估最低', 'is-lo')}
    ${known.map((b, i) => candle(i, b, 'is-real')).join('')}
    ${future.map((b, i) => candle(f.from + i, b, 'is-actual')).join('')}
    ${f.bars.map((b) => candle(b.bar, [b.o, b.h, b.l, b.c], 'is-pred')).join('')}
    ${f.from > 0 ? `<line class="pd-now" x1="${startX.toFixed(1)}" x2="${startX.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>` : ''}
    ${ticks.map((t) => `<text class="pd-tick" x="${pad.l - 6}" y="${(pad.t + (1 - (t - lo) / (hi - lo || 1)) * (H - pad.t - pad.b) + 4).toFixed(1)}" text-anchor="end">${num(t, 2)}</text>`).join('')}
    ${[0, 12, 24, 36, 48].map((b) => `<text class="pd-tick" x="${(pad.l + b * bw).toFixed(1)}" y="${H - 6}" text-anchor="${b === 0 ? 'start' : 'middle'}">${clock(b)}</text>`).join('')}
    <text class="pd-tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end">13:30</text>
  </svg></div>
  <p class="pd-legend"><span class="pd-key-real"><i></i>已走完</span><span class="pd-key-pred"><i></i>預測的 5 分 K</span>${future.length ? '<span class="pd-key-actual"><i></i>實際走勢（當時還不知道）</span>' : ''}<span class="pd-band-key"><i></i>收盤價約 80% 區間</span><span class="pd-key-hl"><i></i>預估今日最高／最低</span></p>`;
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

export interface IntradayState {
  /** 'live' 或回放日期。 */
  mode: string;
  /** -1 開盤前、0 開盤、1～53。 */
  k: number;
  showActual: boolean;
}

export function intradayHtml(d: IntradayData | null | undefined, st: IntradayState, live: { open: number | null; bars: Bar[]; ok: boolean; why: string }): string {
  const head = (badge: string) => `<header class="pd-head"><div><p class="eyebrow">Intraday · 5 分 K</p><h2>00631L 整天 5 分 K 預測</h2></div>${badge}</header>`;
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
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const lev = v.L0 ? d.beta : 1;
  const last = f.bars[f.bars.length - 1];
  const now = v.k < 0 ? null : f.from === 0 ? f.open : v.ix[f.from - 1][3];
  const err = dayErrors(d, v, f);
  const actualClose = !v.live && v.ix.length === BARS ? v.ix[BARS - 1][3] : null;
  const opts = [
    `<option value="live" ${st.mode === 'live' ? 'selected' : ''} ${live.ok ? '' : 'disabled'}>今天（即時）${live.ok ? '' : `－${esc(live.why)}`}</option>`,
    ...[...d.recent].reverse().map((r) => `<option value="${r.date}" ${st.mode === r.date ? 'selected' : ''}>回放 ${r.date}</option>`),
  ].join('');
  const b = d.backtest;
  const pct2 = (x: number) => `${num(x * lev * 100, 2)}%`;
  return `<section class="pd-card glass" id="pd-intra">${head(badges)}
    <p class="pd-lead">以 5 分鐘為單位，把整天 54 根 K 棒（09:00～13:30）的開、高、低、收都預測出來：開盤前先預測跳空，盤中每走完一根就用最新走勢重新預測剩下的。
      00631L 的價格用「加權指數 × ${num(d.beta, 2)} 倍」換算（近一年日報酬估計）。</p>
    <div class="pd-intra-ctrl">
      <label>看哪一天<select id="pd-intra-day">${opts}</select></label>
      ${v.live ? `<span class="muted">每 30 秒更新</span>` : `<label class="pd-intra-k">預測時間 <b class="num" id="pd-intra-clock">${kLabel(v.k)}</b><input type="range" id="pd-intra-k" min="-1" max="${BARS - 1}" step="1" value="${v.k}" /></label>
      <label class="pd-check"><input type="checkbox" id="pd-intra-actual" ${st.showActual ? 'checked' : ''} />疊上實際走勢</label>`}
    </div>
    <dl class="pd-stats pd-intra-stats">
      <div><dt>預測時間</dt><dd class="num">${kLabel(v.k)}</dd></div>
      <div><dt>${now == null ? '預測開盤' : '現在'}</dt><dd class="num">${num(L(now ?? f.open), 2)}${now == null ? ` <small class="${cls(f.open - v.P0)}">${pctTxt(Math.log(f.open / v.P0) * lev)}</small>` : ''}</dd></div>
      <div><dt>預測收盤</dt><dd class="num ${cls((last?.c ?? 0) - v.P0)}">${last ? num(L(last.c), 2) : '—'} <small>${last ? pctTxt(Math.log(last.c / v.P0) * lev) : ''}</small></dd></div>
      <div><dt>收盤約 80% 區間</dt><dd class="num">${last ? `${num(L(last.lo), 2)}～${num(L(last.hi), 2)}` : '—'}</dd></div>
      <div><dt>預估今日最高／最低</dt><dd class="num"><span class="up">${num(L(f.dayHigh), 2)}</span>／<span class="down">${num(L(f.dayLow), 2)}</span></dd></div>
      ${actualClose != null ? `<div><dt>實際收盤／最高／最低</dt><dd class="num">${num(L(actualClose), 2)} <small>${num(L(Math.max(...v.ix.map((x) => x[1]))), 2)}／${num(L(Math.min(...v.ix.map((x) => x[2]))), 2)}</small></dd></div>` : ''}
    </dl>
    ${chart(d, v, f, st.showActual)}
    ${
      err
        ? `<p class="pd-day-err">這一次預測的誤差：每根收盤價 <b>${pctTxt(err.path, 2).replace('+', '')}</b>（假設不會動是 ${pctTxt(err.naive, 2).replace('+', '')}）・每根振幅 <b>${pctTxt(err.range, 2).replace('+', '')}</b>・
          區間涵蓋 <b>${num(err.inBand * 100, 0)}%</b>・最高點差 <b class="${cls(err.hiErr)}">${pctTxt(err.hiErr)}</b>・最低點差 <b class="${cls(err.loErr)}">${pctTxt(err.loErr)}</b></p>`
        : ''
    }
    <h3 class="pd-sub">回測（${b.from} ～ ${b.to}，${num(b.days)} 天，樣本外；誤差換算成 00631L）</h3>
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
