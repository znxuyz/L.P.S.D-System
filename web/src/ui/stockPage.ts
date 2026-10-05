import { bisector, pointer, scaleBand, scaleLinear, select } from 'd3';
import type { DailySeries } from '../data/candles';
import type { Fundamentals, Universe } from '../data/types';
import { buildSummary, peerRating, peerStars, peerStats, strategyScores, type StrategyScore, type Summary } from '../domain/analysis';
import type { MarketMetrics, StockMetrics } from '../domain/metrics';
import { mockNews, newsLinks } from '../domain/news';
import { industryPeMedians, stockView, type StockView } from '../domain/screens';
import { MA_PERIODS, analyzeTechnicals, type Candle, type MaPeriod, type TechReport, type Tilt } from '../domain/technicals';
import type { Palette } from './colors';
import { direction, escapeHtml as esc, num, pct, price, signedYi, yi } from './format';

/**
 * 個股分析頁：K 線、五大策略評分、技術指標、資金與籌碼、同業比較、新聞與綜合摘要。
 */

export interface StockPageContext {
  metrics: MarketMetrics;
  universe: Universe;
  fundamentals: Map<string, Fundamentals>;
  pal: Palette;
  /** 今天盤中的股價紀錄（推算今天的開盤價）。 */
  history: Map<string, number[]>;
  /** 日 K；undefined = 載入中。 */
  daily: DailySeries | undefined;
  /** 是否為真實行情。 */
  live: boolean;
  today: string;
}

/**
 * 均線顏色（已通過深色背景的色盲與對比檢查）。同一週期的 MA 與 EMA 同色，
 * 用線型區分：MA 虛線、EMA 實線。
 */
const MA_COLORS: Record<MaPeriod, string> = { 20: '#3987e5', 60: '#c98500', 120: '#9d73e6' };
const MA_NAME: Record<MaPeriod, string> = { 20: '月線', 60: '季線', 120: '半年線' };

/** 圖例用的小圖示：上虛線（MA）、下實線（EMA）。 */
function lineIcon(color: string): string {
  return `<svg class="ma-icon" width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
    <line x1="0" x2="18" y1="2.5" y2="2.5" stroke="${color}" stroke-width="1.6" stroke-dasharray="3 2"></line>
    <line x1="0" x2="18" y1="7.5" y2="7.5" stroke="${color}" stroke-width="1.8"></line></svg>`;
}
const TILT_LABEL: Record<Tilt, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };
const TILT_ICON: Record<Tilt, string> = { bull: '▲', bear: '▼', neutral: '●' };

const dirCls = (v: number) => direction(v);

/** 內容沒變就不重畫，避免每秒更新時打斷使用者的操作（例如展開的項目被收起）。 */
function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

/** 使用者展開過的策略（跨更新與換股都保留）。 */
const openStrategies = new Set<string>();

/** 星等（1–5，可有半顆）。 */
function starsHtml(stars: number, cls = ''): string {
  const icons = [1, 2, 3, 4, 5].map((i) => {
    const kind = stars >= i ? 'full' : stars >= i - 0.5 ? 'half' : 'empty';
    return `<i class="s-${kind}">★</i>`;
  });
  return `<span class="stars ${cls}" role="img" aria-label="${stars} 顆星（滿分 5 顆）">${icons.join('')}</span>`;
}

function kv(label: string, value: string, cls = ''): string {
  return `<div class="d-kv"><dt>${label}</dt><dd class="num ${cls}">${value}</dd></div>`;
}

function tiltTag(t: Tilt): string {
  return `<span class="tilt tilt-${t}"><i aria-hidden="true">${TILT_ICON[t]}</i>${TILT_LABEL[t]}</span>`;
}

/** 把今天的即時報價補成最後一根 K 棒。 */
function withToday(candles: Candle[], s: StockMetrics, history: number[] | undefined, today: string, session: string): Candle[] {
  if (session === 'pre' || !candles.length || candles[candles.length - 1].date >= today) return candles;
  if (s.volume <= 0 && session !== 'open') return candles;
  const open = history?.[0] ?? s.prevClose;
  return [
    ...candles,
    { date: today, open, high: Math.max(s.high, open, s.price), low: Math.min(s.low, open, s.price), close: s.price, volume: s.volume },
  ];
}

export function renderStockPage(root: HTMLElement, code: string, ctx: StockPageContext): void {
  const s = ctx.metrics.stockByCode.get(code);
  const f = ctx.fundamentals.get(code);
  if (!root.dataset.ready) {
    root.innerHTML = `
      <header class="sa-head glass" id="sa-head"></header>
      <section class="sa-chart glass" aria-label="K 線圖"><div class="sa-chart-head" id="sa-chart-head"></div><div class="kchart" id="sa-kchart"></div></section>
      <section class="sa-summary glass" id="sa-summary" aria-label="綜合摘要"></section>
      <section class="sa-score glass" id="sa-score" aria-label="五大策略評分"></section>
      <section class="sa-tech glass" id="sa-tech" aria-label="技術指標"></section>
      <section class="sa-fund glass" id="sa-fund" aria-label="基本面與同業比較"></section>
      <section class="sa-news glass" id="sa-news" aria-label="新聞"></section>`;
    root.dataset.ready = '1';
  }
  const $ = (id: string) => root.querySelector<HTMLElement>(id)!;
  renderHead($('#sa-head'), code, s, ctx);
  if (!s || !f) {
    for (const id of ['#sa-chart-head', '#sa-kchart', '#sa-summary', '#sa-score', '#sa-tech', '#sa-fund', '#sa-news']) $(id).innerHTML = '';
    $('#sa-summary').innerHTML = '<p class="muted">找不到這檔股票。請用上方的搜尋輸入代號或名稱。</p>';
    return;
  }
  const candles = ctx.daily ? withToday(ctx.daily.candles, s, ctx.history.get(code), ctx.today, ctx.metrics.session) : [];
  const tech = analyzeTechnicals(candles);
  const view = stockView(s, f, industryPeMedians(ctx.metrics, ctx.universe).get(s.industryId) ?? null);
  const scores = strategyScores(view);
  const summary = buildSummary(view, scores, tech, ctx.metrics, ctx.universe);

  renderChartHead($('#sa-chart-head'), ctx, tech);
  renderKChart($('#sa-kchart'), candles, tech, ctx);
  renderSummary($('#sa-summary'), summary);
  renderScores($('#sa-score'), scores);
  renderTech($('#sa-tech'), tech, ctx.daily === undefined);
  renderFund($('#sa-fund'), view, ctx);
  renderNews($('#sa-news'), s, f, ctx);
}

// ---------------------------------------------------------------- 標頭與搜尋

function renderHead(el: HTMLElement, code: string, s: StockMetrics | undefined, ctx: StockPageContext): void {
  // 正在輸入時不要重畫，避免搜尋框被洗掉
  if (el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) {
    const p = el.querySelector('.sa-quote');
    if (p && s) p.innerHTML = quoteHtml(s);
    return;
  }
  const ind = s ? ctx.metrics.industryById.get(s.industryId) : undefined;
  el.innerHTML = `
    <div class="sa-id">
      <p class="eyebrow">個股分析 · ${esc(code)}${ind ? ` · ${esc(ind.name)}` : ''}</p>
      <h2 class="sa-name">${esc(s?.name ?? code)}</h2>
    </div>
    <div class="sa-quote">${s ? quoteHtml(s) : ''}</div>
    <form class="sa-search" id="sa-search" role="search">
      <input type="search" id="sa-q" list="sa-stocks" placeholder="輸入代號或名稱，例如 2330、鴻海" aria-label="搜尋股票" autocomplete="off" />
      <datalist id="sa-stocks">${ctx.universe.stocks.map((x) => `<option value="${x.code} ${esc(x.name)}"></option>`).join('')}</datalist>
      <button type="submit" class="btn btn-accent">分析</button>
    </form>`;
}

function quoteHtml(s: StockMetrics): string {
  const d = dirCls(s.change);
  return `<b class="num">${price(s.price)}</b>
    <span class="num ${d}">${s.change >= 0 ? '▲' : '▼'} ${price(Math.abs(s.change))}（${pct(s.changePct)}）</span>
    <span class="sa-meta num">成交 ${yi(s.turnover, 1)}・資金流 <em class="${dirCls(s.flow)}">${signedYi(s.flow, 1)}</em></span>`;
}

// ---------------------------------------------------------------- K 線圖

function renderChartHead(el: HTMLElement, ctx: StockPageContext, tech: TechReport | null): void {
  const lastOf = (arr: (number | null)[] | undefined) => {
    const v = arr?.[arr.length - 1];
    return v == null ? '—' : price(v);
  };
  const src = ctx.daily === undefined ? '載入中…' : ctx.daily.source === 'fugle' ? '富果日 K' : ctx.live ? '示意資料（選單填富果金鑰可看真實日 K）' : '示意資料';
  el.innerHTML = `<h2 class="panel-title">日 K 線 <small>${src}</small></h2>
    <ul class="ma-legend" aria-label="均線：虛線為 MA，實線為 EMA">
      ${MA_PERIODS.map(
        (n) => `<li>${lineIcon(MA_COLORS[n])}<span>${n}（${MA_NAME[n]}）</span>
          <span class="ma-vals num">MA <b>${lastOf(tech?.series.ma[n])}</b> · EMA <b>${lastOf(tech?.series.ema[n])}</b></span></li>`,
      ).join('')}
      <li class="ma-key">虛線 MA・實線 EMA</li>
    </ul>`;
}

function renderKChart(el: HTMLElement, all: Candle[], tech: TechReport | null, ctx: StockPageContext): void {
  if (el.dataset.hover) return;
  if (all.length < 2) {
    el.innerHTML = `<p class="muted kchart-empty">${ctx.daily === undefined ? '日 K 載入中…' : '沒有日 K 資料'}</p>`;
    return;
  }
  const N = Math.min(120, all.length);
  const off = all.length - N;
  const candles = all.slice(off);
  const w = Math.max(320, el.clientWidth);
  const h = Math.max(260, el.clientHeight);
  const pad = { l: 8, r: 56, t: 10, b: 22 };
  const volH = Math.round((h - pad.t - pad.b) * 0.2);
  const gap = 10;
  const priceBottom = h - pad.b - volH - gap;

  const x = scaleBand<number>().domain(candles.map((_, i) => i)).range([pad.l, w - pad.r]).padding(0.28);
  const ma = tech?.series;
  const maVals = ma
    ? MA_PERIODS.flatMap((n) => [ma.ma[n], ma.ema[n]]).flatMap((arr) => arr.slice(off).filter((v): v is number => v != null))
    : [];
  const lo = Math.min(...candles.map((c) => c.low), ...maVals);
  const hi = Math.max(...candles.map((c) => c.high), ...maVals);
  const y = scaleLinear().domain([lo, hi]).nice(5).range([priceBottom, pad.t]);
  const vMax = Math.max(...candles.map((c) => c.volume), 1);
  const yv = scaleLinear().domain([0, vMax]).range([h - pad.b, h - pad.b - volH]);
  const bw = x.bandwidth();
  const cx = (i: number) => x(i)! + bw / 2;
  const up = ctx.pal.up.strong;
  const down = ctx.pal.down.strong;
  const colorOf = (c: Candle) => (c.close >= c.open ? up : down);

  const maPath = (arr: (number | null)[] | undefined) => {
    if (!arr) return '';
    let d = '';
    arr.slice(off).forEach((v, i) => {
      if (v == null) return;
      d += `${d ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };

  // 月份標籤：每個月第一根 K 棒
  const months: Array<{ i: number; label: string }> = [];
  candles.forEach((c, i) => {
    const m = c.date.slice(5, 7);
    if (i !== 0 && candles[i - 1].date.slice(5, 7) === m) return;
    // 太擠時（例如手機）略過離前一個標籤太近的月份
    const prev = months[months.length - 1];
    if (prev && cx(i) - cx(prev.i) < 30) months.pop();
    months.push({ i, label: `${Number(m)}月` });
  });

  const ticks = y.ticks(5);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const tickFmt = (t: number) => (step >= 1 ? num(t, 0) : step >= 0.1 ? num(t, 1) : num(t, 2));
  const last = candles[candles.length - 1];
  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 ${N} 日 K 線、均線與成交量">
    ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"></line><text class="axis" x="${w - pad.r + 6}" y="${y(t) + 4}">${tickFmt(t)}</text>`).join('')}
    ${candles
      .map((c, i) => {
        const col = colorOf(c);
        const top = y(Math.max(c.open, c.close));
        const bh = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        return `<line x1="${cx(i)}" x2="${cx(i)}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"></line>
          <rect x="${x(i)}" y="${top}" width="${bw}" height="${bh}" rx="${Math.min(2, bw / 3)}" fill="${col}"></rect>
          <rect x="${x(i)}" y="${yv(c.volume)}" width="${bw}" height="${Math.max(0, h - pad.b - yv(c.volume))}" rx="${Math.min(2, bw / 3)}" fill="${col}" opacity="0.45"></rect>`;
      })
      .join('')}
    ${[...MA_PERIODS]
      .reverse()
      .map(
        (n) => `<path d="${maPath(ma?.ma[n])}" fill="none" stroke="${MA_COLORS[n]}" stroke-width="1.4" stroke-dasharray="5 4"></path>
          <path d="${maPath(ma?.ema[n])}" fill="none" stroke="${MA_COLORS[n]}" stroke-width="1.8"></path>`,
      )
      .join('')}
    ${tech ? levelLine(tech.resistance, '壓力') + levelLine(tech.support, '支撐') : ''}
    <text class="axis strong" x="${w - pad.r + 6}" y="${y(last.close) + 4}">${price(last.close)}</text>
    <text class="axis" x="${pad.l}" y="${h - pad.b - volH - 2}">成交量</text>
    ${months.map((m) => `<text class="axis" x="${cx(m.i)}" y="${h - 6}" text-anchor="middle">${m.label}</text>`).join('')}
    <line class="cross" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"></line>
    <rect class="hit" x="${pad.l}" y="0" width="${w - pad.l - pad.r}" height="${h}" fill="transparent"></rect>
  </svg><div class="k-tip glass" hidden></div>`;

  function levelLine(v: number, label: string): string {
    if (v < y.domain()[0] || v > y.domain()[1]) return '';
    return `<line class="level" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"></line>
      <text class="axis level-label" x="${pad.l + 4}" y="${y(v) - 4}">${label} ${price(v)}</text>`;
  }

  const svg = select(el).select('svg');
  const tip = el.querySelector<HTMLDivElement>('.k-tip')!;
  const centers = candles.map((_, i) => cx(i));
  const find = bisector<number, number>((v) => v).center;
  svg
    .select('rect.hit')
    .on('mousemove', (e: MouseEvent) => {
      const [mx] = pointer(e);
      const i = find(centers, mx);
      const c = candles[i];
      if (!c) return;
      el.dataset.hover = '1';
      svg.select('line.cross').attr('x1', cx(i)).attr('x2', cx(i)).attr('visibility', 'visible');
      const prev = i > 0 ? candles[i - 1].close : all[off - 1]?.close;
      const chg = prev ? ((c.close - prev) / prev) * 100 : 0;
      const mv = (arr: (number | null)[] | undefined) => {
        const v = arr?.[off + i];
        return v == null ? '—' : price(v);
      };
      tip.hidden = false;
      tip.innerHTML = `<b>${c.date}</b>
        <dl><dt>開</dt><dd>${price(c.open)}</dd><dt>高</dt><dd>${price(c.high)}</dd><dt>低</dt><dd>${price(c.low)}</dd>
        <dt>收</dt><dd class="${dirCls(chg)}">${price(c.close)}（${pct(chg)}）</dd><dt>量</dt><dd>${num(c.volume)} 張</dd>
        ${MA_PERIODS.map((n) => `<dt><i style="background:${MA_COLORS[n]}"></i>${n} 日</dt><dd>${mv(ma?.ma[n])} / ${mv(ma?.ema[n])}</dd>`).join('')}
        <dt></dt><dd class="muted">MA / EMA</dd></dl>`;
      const left = cx(i) + 14 + tip.offsetWidth > w - pad.r ? cx(i) - 14 - tip.offsetWidth : cx(i) + 14;
      tip.style.transform = `translate(${Math.max(4, left)}px, ${pad.t + 6}px)`;
    })
    .on('mouseleave', () => {
      delete el.dataset.hover;
      svg.select('line.cross').attr('visibility', 'hidden');
      tip.hidden = true;
    });
}

// ---------------------------------------------------------------- 綜合摘要

function renderSummary(el: HTMLElement, sum: Summary): void {
  const pos = ((sum.score + 100) / 200) * 100;
  el.innerHTML = `<h2 class="panel-title">綜合摘要</h2>
    <div class="gauge" role="img" aria-label="綜合評分 ${sum.score}，${sum.label}">
      <div class="gauge-head"><b class="gauge-label tilt-text-${sum.tilt}">${sum.label}</b><span class="num">${sum.score > 0 ? '+' : ''}${sum.score}</span></div>
      <div class="gauge-track"><i style="left:${pos.toFixed(1)}%"></i></div>
      <div class="gauge-scale"><span>偏空 −100</span><span>0</span><span>+100 偏多</span></div>
    </div>
    <ul class="sum-points">${sum.points.map((p) => `<li class="pt-${p.tilt}"><i aria-hidden="true">${TILT_ICON[p.tilt]}</i><span>${esc(p.text)}</span></li>`).join('')}</ul>
    <p class="disclaimer">依指標規則自動整理，不構成投資建議。</p>`;
}

// ---------------------------------------------------------------- 五大策略

function radar(scores: StrategyScore[]): string {
  const size = 220;
  const c = size / 2;
  const R = 74;
  const n = scores.length;
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r];
  };
  const ring = (k: number) => scores.map((_, i) => pt(i, R * k).map((v) => v.toFixed(1)).join(',')).join(' ');
  const poly = scores.map((s, i) => pt(i, R * Math.max(0.04, s.score)).map((v) => v.toFixed(1)).join(',')).join(' ');
  return `<svg class="radar" viewBox="-44 -4 ${size + 88} ${size + 8}" role="img" aria-label="五大策略符合度">
    ${[0.25, 0.5, 0.75, 1].map((k) => `<polygon class="radar-ring" points="${ring(k)}"></polygon>`).join('')}
    ${scores.map((_, i) => { const [x, y] = pt(i, R); return `<line class="radar-axis" x1="${c}" y1="${c}" x2="${x}" y2="${y}"></line>`; }).join('')}
    <polygon class="radar-area" points="${poly}"></polygon>
    ${scores.map((s, i) => { const [x, y] = pt(i, R * Math.max(0.04, s.score)); return `<circle class="radar-dot" cx="${x}" cy="${y}" r="4"></circle>`; }).join('')}
    ${scores
      .map((s, i) => {
        const [x, y] = pt(i, R + 22);
        const anchor = Math.abs(x - c) < 8 ? 'middle' : x > c ? 'start' : 'end';
        return `<text class="radar-label" x="${x}" y="${y + 4}" text-anchor="${anchor}">${esc(s.strategy.name)}</text>`;
      })
      .join('')}
  </svg>`;
}

function renderScores(el: HTMLElement, scores: StrategyScore[]): void {
  if (!el.dataset.bound) {
    // toggle 事件不會冒泡，用捕獲階段記住哪些項目是展開的
    el.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        const id = d.dataset.strategy;
        if (!id) return;
        if (d.open) openStrategies.add(id);
        else openStrategies.delete(id);
      },
      true,
    );
    el.dataset.bound = '1';
  }
  const best = [...scores].sort((a, b) => b.score - a.score)[0];
  setHtml(el, `<h2 class="panel-title">五大策略評分 <small>最接近：${esc(best.strategy.name)}</small></h2>
    <div class="score-wrap">${radar(scores)}</div>
    <div class="score-list">${scores
      .map(
        (s) => `<details class="score-item${s.matched ? ' is-match' : ''}" data-strategy="${s.strategy.id}"${openStrategies.has(s.strategy.id) ? ' open' : ''}>
          <summary><span class="si-name">${esc(s.strategy.name)}</span>
            <span class="si-bar"><i style="width:${(s.score * 100).toFixed(0)}%"></i></span>
            <span class="si-n num">${s.strategy.match === 'any' ? (s.passed ? '符合' : '—') : `${s.passed} / ${s.checks.length}`}</span></summary>
          <ul>${s.strategy.criteria
            .map((c, i) => `<li class="${s.checks[i].pass ? 'pass' : 'fail'}"><i aria-hidden="true">${s.checks[i].pass ? '✓' : '✗'}</i><span>${esc(c.label)}</span><em class="num">${esc(s.checks[i].value)}</em></li>`)
            .join('')}</ul>
          <button type="button" class="btn btn-sm" data-goto-strategy="${s.strategy.id}">看同策略的其他股票</button>
        </details>`,
      )
      .join('')}</div>`);
}

// ---------------------------------------------------------------- 技術指標

function renderTech(el: HTMLElement, tech: TechReport | null, loading: boolean): void {
  if (!tech) {
    el.innerHTML = `<h2 class="panel-title">技術指標</h2><p class="muted">${loading ? '日 K 載入中…' : '日 K 資料不足，無法計算。'}</p>`;
    return;
  }
  el.innerHTML = `<h2 class="panel-title">技術指標</h2>
    <table class="tech-table"><tbody>${tech.signals
      .map((s) => `<tr><th>${esc(s.name)}</th><td class="num">${esc(s.value)}</td><td>${tiltTag(s.tilt)}</td><td class="muted">${esc(s.note)}</td></tr>`)
      .join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- 基本面、籌碼、同業

/** 區間條：最低到最高，標出目前位置（和可選的參考線）。 */
function rangeBar(o: {
  title: string;
  lo: number;
  hi: number;
  current: number;
  fmt: (v: number) => string;
  verdict: string;
  verdictTilt: Tilt;
  note: string;
  zones?: [number, number];
  ref?: { value: number; label: string };
}): string {
  const at = (v: number) => Math.max(0, Math.min(100, ((v - o.lo) / Math.max(1e-9, o.hi - o.lo)) * 100));
  const zones = o.zones
    ? `<i class="rb-zone rb-cheap" style="left:0;width:${at(o.zones[0])}%"></i>
       <i class="rb-zone rb-fair" style="left:${at(o.zones[0])}%;width:${at(o.zones[1]) - at(o.zones[0])}%"></i>
       <i class="rb-zone rb-rich" style="left:${at(o.zones[1])}%;width:${100 - at(o.zones[1])}%"></i>`
    : '<i class="rb-zone rb-fair" style="left:0;width:100%"></i>';
  return `<div class="rb">
    <div class="rb-head"><span>${o.title}</span><b class="tilt-text-${o.verdictTilt}">${o.verdict}</b></div>
    <div class="rb-track">${zones}
      ${o.ref ? `<i class="rb-ref" style="left:${at(o.ref.value)}%" title="${o.ref.label} ${o.fmt(o.ref.value)}"></i>` : ''}
      <i class="rb-now" style="left:${at(o.current)}%"></i>
    </div>
    <div class="rb-scale num"><span>${o.fmt(o.lo)}</span><span>${o.fmt(o.hi)}</span></div>
    <p class="rb-note">${o.note}</p>
  </div>`;
}

function valuationBlock(v: StockView): string {
  const f = v.f;
  const parts: string[] = [];
  const band = f.pe5y;
  if (band && v.pe > 0 && Number.isFinite(v.pe) && v.pePct !== null) {
    const pctile = Math.round(v.pePct * 100);
    const verdict = v.pePct <= 0.3 ? '偏便宜' : v.pePct >= 0.7 ? '偏貴' : '合理';
    parts.push(
      rangeBar({
        title: '本益比位置（和自己近 5 年比）',
        lo: Math.min(band[0], v.pe),
        hi: Math.max(band[4], v.pe),
        current: v.pe,
        fmt: (x) => `${x.toFixed(1)} 倍`,
        verdict,
        verdictTilt: v.pePct <= 0.3 ? 'bull' : v.pePct >= 0.7 ? 'bear' : 'neutral',
        zones: [band[1], band[3]],
        ref: v.industryPe ? { value: v.industryPe, label: '產業中位數' } : undefined,
        note: `目前 <b>${v.pe.toFixed(1)} 倍</b>，過去 5 年有 ${pctile}% 的時間比現在便宜。5 年中位數 ${band[2].toFixed(1)} 倍${v.industryPe ? `，產業中位數 ${v.industryPe.toFixed(1)} 倍（灰線）` : ''}。`,
      }),
    );
  }
  const pos = Math.round(v.pos3y * 100);
  parts.push(
    rangeBar({
      title: '股價位階（和自己近 3 年比）',
      lo: Math.min(f.low3y, v.stock.price),
      hi: Math.max(f.high3y, v.stock.price),
      current: v.stock.price,
      fmt: (x) => price(x),
      verdict: v.pos3y <= 0.3 ? '低檔' : v.pos3y >= 0.7 ? '高檔' : '中間',
      verdictTilt: v.pos3y <= 0.3 ? 'bull' : v.pos3y >= 0.7 ? 'bear' : 'neutral',
      zones: [f.low3y + (f.high3y - f.low3y) * 0.3, f.low3y + (f.high3y - f.low3y) * 0.7],
      note: `目前 <b>${price(v.stock.price)}</b>，位在近 3 年最低到最高之間的 ${pos}% 位置。`,
    }),
  );
  return `<h3 class="d-sub">評價位置 <small>用這檔股票自己的歷史判斷，不用統一標準</small></h3>${parts.join('')}`;
}

function renderFund(el: HTMLElement, v: StockView, ctx: StockPageContext): void {
  const s = v.stock;
  const f = v.f;
  const peers = peerStats(s, ctx.metrics, ctx.fundamentals);
  const rating = peerRating(peers);
  setHtml(el, `<h2 class="panel-title">基本面與籌碼 <small>模擬資料</small></h2>
    <dl class="d-grid d-grid-4">
      ${kv('本益比', Number.isFinite(v.pe) && v.pe > 0 ? `${v.pe.toFixed(1)} 倍` : '—')}
      ${kv('殖利率', `${v.yieldPct.toFixed(2)}%`)}
      ${kv('EPS（近四季）', `${f.eps4q.toFixed(2)} 元`)}
      ${kv('EPS 年增', pct(f.epsYoY, 1), dirCls(f.epsYoY))}
      ${kv('毛利率變化', `${f.grossMarginChg >= 0 ? '+' : '−'}${Math.abs(f.grossMarginChg).toFixed(1)} 百分點`, dirCls(f.grossMarginChg))}
      ${kv('連續配息', `${f.dividendYears} 年`)}
      ${kv('法人', f.instBuyDays >= 0 ? `連買 ${f.instBuyDays} 天` : `連賣 ${-f.instBuyDays} 天`, dirCls(f.instBuyDays))}
      ${kv('千張大戶（4 週）', `${f.bigHolderChg >= 0 ? '+' : '−'}${Math.abs(f.bigHolderChg).toFixed(1)} 百分點`, dirCls(f.bigHolderChg))}
    </dl>
    ${valuationBlock(v)}
    <h3 class="d-sub">同業比較 <small>${esc(ctx.metrics.industryById.get(s.industryId)?.name ?? '')}・${peers[0]?.count ?? 0} 檔</small></h3>
    ${
      rating
        ? `<div class="peer-rating">
            <div><span class="pr-title">同業推薦度</span><b class="pr-label">${rating.label}</b></div>
            ${starsHtml(rating.stars)}<b class="pr-num num">${rating.stars.toFixed(1)}</b>
            <p class="pr-note">${esc(rating.note)}。只代表和同產業相比的相對位置，不是買賣建議。</p>
          </div>`
        : ''
    }
    <table class="peer-table">
      <thead><tr><th>指標</th><th>本股</th><th>同業中間值</th><th>同業評等</th></tr></thead>
      <tbody>${peers
        .map((p) => {
          const st = peerStars(p);
          const word = st >= 4 ? '優於同業' : st === 3 ? '和同業差不多' : '落後同業';
          return `<tr><td>${p.label}<small class="peer-hint">${p.hint}</small></td><td class="num">${p.format(p.value)}</td><td class="num muted">${p.format(p.median)}</td>
            <td>${starsHtml(st, 'stars-sm')}<span class="peer-word w-${st >= 4 ? 'good' : st === 3 ? 'mid' : 'weak'}">${word}</span>
            <small class="peer-hint num">第 ${p.rank} 名 / ${p.count} 檔</small></td></tr>`;
        })
        .join('')}</tbody>
    </table>`);
}

// ---------------------------------------------------------------- 新聞

function renderNews(el: HTMLElement, s: StockMetrics, f: Fundamentals, ctx: StockPageContext): void {
  const items = ctx.live ? [] : mockNews(s.code, s.name, f, ctx.today);
  const links = newsLinks(s.code);
  el.innerHTML = `<h2 class="panel-title">新聞 <small>${ctx.live ? '外部連結' : '示意新聞・關鍵字判斷利多利空'}</small></h2>
    ${
      items.length
        ? `<ul class="news-list">${items
            .map((n) => `<li><span class="news-date num">${n.date.slice(5)}</span><span class="news-title">${esc(n.title)}</span>${tiltTag(n.tilt)}</li>`)
            .join('')}</ul>`
        : '<p class="muted">即時新聞需要轉接服務，目前先提供外部連結。</p>'
    }
    <div class="news-links">${links.map((l) => `<a class="chip-btn" href="${l.href}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>`;
}
