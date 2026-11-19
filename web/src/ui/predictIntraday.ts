/**
 * 預測頁的「00631L 5 分 K 走勢預測」：
 * - 有即時行情（富果／證交所）而且是交易日：用今天到現在的加權指數走勢預測到收盤。
 * - 回放：最近 10 個交易日，拉時間滑桿看「當時」的預測跟實際走勢比較。
 * 00631L 的價格由加權指數換算（β 倍），K 棒是換算出來的，不是 00631L 真實的 5 分 K。
 */
import type { IndexPoint } from '../data/types';
import { BARS, HORIZONS, forecastPath, predictAt, toLeveraged, type DailyCtx, type IntradayModel } from '../domain/intradayModel';
import { escapeHtml as esc, num } from './format';

export interface IntradayData {
  generatedAt: string;
  ready: boolean;
  days?: number;
  beta: number;
  model: IntradayModel;
  verdict: 'signal' | 'none';
  backtest: {
    from: string;
    to: string;
    days: number;
    byH: Array<{ h: number; n: number; r2: number; acc: number; corr: number }>;
    closeByTime: Array<{ label: string; n: number; r2: number; acc: number }>;
  };
  next: { after: string; P0: number; L0: number | null; ctx: Record<keyof DailyCtx, number | null> };
  recent: Array<{ date: string; P0: number; L0: number | null; ix: Array<[number, number, number, number]>; ctx: Record<keyof DailyCtx, number | null> }>;
}

const ctxOf = (c: Record<keyof DailyCtx, number | null>): DailyCtx => ({
  prevDay: c.prevDay ?? NaN,
  prev5: c.prev5 ?? NaN,
  prevIntra: c.prevIntra ?? NaN,
  futChg: c.futChg ?? NaN,
});
const clock = (bar: number) => {
  const m = 9 * 60 + bar * 5;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const pctTxt = (v: number, d = 2) => `${v > 0 ? '+' : ''}${num(v * 100, d)}%`;
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** 即時的加權指數（每分鐘）→ 今天的 5 分 K 收盤序列 c[0..k]。 */
export function liveCloses(series: IndexPoint[], openMs: number): number[] {
  const pts = series.filter((p) => p.t >= openMs && p.t <= openMs + BARS * 300_000 && p.v > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return [];
  const c = [pts[0].v];
  let j = 0;
  for (let k = 1; k <= BARS; k++) {
    const end = openMs + k * 300_000;
    if (pts[pts.length - 1].t < end - 60_000) break; // 這根還沒走完
    while (j + 1 < pts.length && pts[j + 1].t <= end) j++;
    c.push(pts[j].v);
  }
  return c;
}

interface View {
  title: string;
  P0: number;
  L0: number | null;
  ctx: DailyCtx;
  /** 已知的 5 分 K（指數）：回放是整天，即時是到現在。 */
  ix: Array<[number, number, number, number]>;
  /** 預測時間點。 */
  k: number;
  live: boolean;
}

function chart(d: IntradayData, v: View): string {
  const W = 720;
  const H = 260;
  const pad = { l: 52, r: 10, t: 10, b: 24 };
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const c = [v.ix[0][0], ...v.ix.map((b) => b[3])];
  const fc = forecastPath(d.model, c, v.k, v.P0, v.ctx);
  const vals = [...v.ix.flatMap((b) => [b[1], b[2]]), ...fc.flatMap((p) => [p.lo, p.hi]), v.P0].map(L);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const bw = (W - pad.l - pad.r) / BARS;
  const sx = (bar: number) => pad.l + bar * bw; // bar 的左緣
  const sy = (x: number) => pad.t + (1 - (L(x) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const candles = v.ix
    .map(([o, h, l, cl], b) => {
      const future = b >= v.k;
      const x = sx(b) + bw / 2;
      const up = cl >= o;
      const top = sy(Math.max(o, cl));
      const bot = sy(Math.min(o, cl));
      return `<g class="${up ? 'k-up' : 'k-down'}${future ? ' is-future' : ''}"><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${sy(h).toFixed(1)}" y2="${sy(l).toFixed(1)}"/><rect x="${(x - bw * 0.35).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
    })
    .join('');
  const x0 = sx(v.k);
  const pts = [[x0, sy(c[v.k])], ...fc.map((p) => [sx(p.bar), sy(p.mid)])];
  const band = `${[[x0, sy(c[v.k])], ...fc.map((p) => [sx(p.bar), sy(p.hi)])].map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}${[...fc].reverse().map((p) => `L${sx(p.bar).toFixed(1)},${sy(p.lo).toFixed(1)}`).join('')}L${x0.toFixed(1)},${sy(c[v.k]).toFixed(1)}Z`;
  const ticks = [lo, (lo + hi) / 2, hi];
  return `<svg class="pd-chart pd-intra-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="5 分 K 與預測走勢">
    <line class="pd-base" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v.P0).toFixed(1)}" y2="${sy(v.P0).toFixed(1)}"/>
    <text class="pd-tick" x="${W - pad.r}" y="${(sy(v.P0) - 4).toFixed(1)}" text-anchor="end">昨收</text>
    ${candles}
    <path class="pd-band" d="${band}"/>
    <path class="pd-line s1 pd-fc" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}"/>
    <line class="pd-now" x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>
    ${ticks.map((t) => `<text class="pd-tick" x="${pad.l - 6}" y="${(pad.t + (1 - (t - lo) / (hi - lo || 1)) * (H - pad.t - pad.b) + 4).toFixed(1)}" text-anchor="end">${num(t, 2)}</text>`).join('')}
    ${[0, 12, 24, 36, 48, 54].map((b) => `<text class="pd-tick" x="${sx(b).toFixed(1)}" y="${H - 6}" text-anchor="${b === 0 ? 'start' : b === 54 ? 'end' : 'middle'}">${clock(b)}</text>`).join('')}
  </svg>
  <p class="pd-legend"><span class="s1"><i></i>預測走勢</span><span class="pd-band-key"><i></i>約 80% 區間</span><span class="muted">${v.live ? '' : '虛線後的淡色 K 棒是「當時還不知道」的實際走勢'}</span></p>`;
}

function summary(d: IntradayData, v: View): string {
  const c = [v.ix[0][0], ...v.ix.map((b) => b[3])];
  const p = predictAt(d.model, c, v.k, v.P0, v.ctx);
  const fc = forecastPath(d.model, c, v.k, v.P0, v.ctx);
  const end = fc[fc.length - 1];
  const L = (x: number) => (v.L0 ? toLeveraged(x, v.P0, v.L0, d.beta) : x);
  const lev = v.L0 ? d.beta : 1;
  const next = p[0] * lev;
  const toClose = p[HORIZONS.length - 1] * lev;
  const actualClose = !v.live && v.ix.length === BARS ? v.ix[BARS - 1][3] : null;
  return `<dl class="pd-stats">
    <div><dt>預測時間</dt><dd class="num">${v.k === 0 ? '開盤' : clock(v.k)}</dd></div>
    <div><dt>現在</dt><dd class="num">${num(L(c[v.k]), 2)}</dd></div>
    <div><dt>下一根 5 分 K</dt><dd class="num ${cls(next)}">${next > 0 ? '↑' : '↓'} ${pctTxt(next)}</dd></div>
    <div><dt>預測收盤</dt><dd class="num ${cls(toClose)}">${end ? num(L(end.mid), 2) : '—'} <small>${pctTxt(toClose)}</small></dd></div>
    <div><dt>收盤約 80% 區間</dt><dd class="num">${end ? `${num(L(end.lo), 2)}～${num(L(end.hi), 2)}` : '—'}</dd></div>
    ${actualClose != null ? `<div><dt>實際收盤</dt><dd class="num ${cls(actualClose - c[v.k])}">${num(L(actualClose), 2)} <small>${pctTxt(Math.log(actualClose / c[v.k]) * lev)}</small></dd></div>` : ''}
  </dl>`;
}

export interface IntradayState {
  /** 'live' 或回放日期。 */
  mode: string;
  k: number;
}

export function intradayHtml(d: IntradayData | null | undefined, st: IntradayState, live: { closes: number[]; ok: boolean; why: string }): string {
  const head = (badge: string) => `<header class="pd-head"><div><p class="eyebrow">Intraday · 5 分 K</p><h2>00631L 5 分 K 走勢預測</h2></div>${badge}</header>`;
  if (d === undefined) return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">載入中⋯⋯</p></section>`;
  if (!d || !d.ready)
    return `<section class="pd-card glass" id="pd-intra">${head('')}<p class="muted">正在收集加權指數 5 分 K 的歷史資料（目前 ${d?.days ?? 0} 天，至少要 60 天才會開始訓練；每小時往回補一批，幾個小時內會補到 2020 年）。</p></section>`;
  const badge = `<span class="pd-verdict ${d.verdict === 'signal' ? 'is-ok' : 'is-warn'}">${d.verdict === 'signal' ? '✅ 回測有預測能力' : '⚠️ 回測沒有預測能力'}</span>`;
  // 選擇要看的那一天
  let v: View | null = null;
  if (st.mode === 'live' && live.ok) {
    const n = live.closes.length;
    const ix = live.closes.slice(1).map((c, i) => [live.closes[i], Math.max(c, live.closes[i]), Math.min(c, live.closes[i]), c] as [number, number, number, number]);
    v = { title: '今天', P0: d.next.P0, L0: d.next.L0, ctx: ctxOf(d.next.ctx), ix, k: Math.min(BARS - 1, n - 1), live: true };
  } else {
    const day = d.recent.find((r) => r.date === st.mode) ?? d.recent[d.recent.length - 1];
    st.mode = day.date;
    v = { title: day.date, P0: day.P0, L0: day.L0, ctx: ctxOf(day.ctx), ix: day.ix, k: Math.max(0, Math.min(BARS - 1, st.k)), live: false };
  }
  const opts = [
    `<option value="live" ${st.mode === 'live' ? 'selected' : ''} ${live.ok ? '' : 'disabled'}>今天（即時）${live.ok ? '' : `－${esc(live.why)}`}</option>`,
    ...[...d.recent].reverse().map((r) => `<option value="${r.date}" ${st.mode === r.date ? 'selected' : ''}>回放 ${r.date}</option>`),
  ].join('');
  const b = d.backtest;
  const hName = (h: number) => (h === 54 ? '到收盤' : `${h} 根（${h * 5} 分鐘）`);
  return `<section class="pd-card glass" id="pd-intra">${head(badge)}
    <p class="pd-lead">開盤後每 5 分鐘，用今天到現在的走勢（跳空、漲跌、波動、在高低區間的位置）加上前一天的資料，預測接下來 1～12 根 5 分 K 與到收盤的走勢。
      00631L 的價格用「加權指數 × ${num(d.beta, 2)} 倍」換算（近一年的日報酬估計），K 棒是換算出來的。</p>
    <div class="pd-intra-ctrl">
      <label>看哪一天<select id="pd-intra-day">${opts}</select></label>
      ${v.live ? '' : `<label class="pd-intra-k">預測時間 <b class="num" id="pd-intra-clock">${v.k === 0 ? '開盤' : clock(v.k)}</b><input type="range" id="pd-intra-k" min="0" max="${BARS - 1}" step="1" value="${v.k}" /></label>`}
    </div>
    ${summary(d, v)}
    ${chart(d, v)}
    <h3 class="pd-sub">回測（${b.from} ～ ${b.to}，${num(b.days)} 天，樣本外）</h3>
    <div class="pd-table-wrap"><table class="pd-table">
      <thead><tr><th>預測多遠</th><th class="num">方向準確率</th><th class="num">R²（比猜 0 好多少）</th><th class="num">相關係數</th><th class="num">筆數</th></tr></thead>
      <tbody>${b.byH.map((x) => `<tr><td>${hName(x.h)}</td><td class="num">${num(x.acc * 100, 1)}%</td><td class="num ${cls(x.r2)}">${num(x.r2 * 100, 2)}%</td><td class="num">${num(x.corr, 3)}</td><td class="num muted">${num(x.n)}</td></tr>`).join('')}</tbody>
    </table></div>
    <details class="pd-more"><summary>「到收盤」的預測，依預測時間分開看</summary>
      <div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>預測時間</th><th class="num">方向準確率</th><th class="num">R²</th></tr></thead>
      <tbody>${b.closeByTime.map((x) => `<tr><td>${x.label}</td><td class="num">${num(x.acc * 100, 1)}%</td><td class="num ${cls(x.r2)}">${num(x.r2 * 100, 2)}%</td></tr>`).join('')}</tbody></table></div>
    </details>
    <p class="pd-note ${d.verdict === 'none' ? 'is-warn' : ''}">方向準確率 50% 等於擲硬幣；R² 大於 0 代表比「預測不會動」更接近實際。${
      d.verdict === 'none'
        ? '目前的回測<b>沒有</b>穩定的預測能力，走勢線與區間只能當參考。'
        : '有些長度的預測比隨便猜好，但優勢很小，<b>扣掉當沖成本（約 0.27%）後不一定有利潤</b>；區間代表不確定性，實際走勢常常會跑出區間。'
    }</p>
  </section>`;
}
