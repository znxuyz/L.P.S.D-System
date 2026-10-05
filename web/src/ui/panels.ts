import { area as d3area, bisector, curveMonotoneX, line as d3line, pointer, scaleLinear, select } from 'd3';
import { SESSION_MINUTES } from '../data/twse';
import type { Fundamentals } from '../data/types';
import type { EventLevel, MarketEvent } from '../domain/events';
import { stockView } from '../domain/screens';
import type { IndustryMetrics, MarketMetrics, StockMetrics } from '../domain/metrics';
import type { Focus } from './focus';
import type { Palette } from './colors';
import { sparkArea, sparkPath } from './spark';
import { clock, direction, escapeHtml as esc, hm, num, pct, price, sharePct, signed, signedYi, yi } from './format';

export interface PanelContext {
  metrics: MarketMetrics;
  selection: Focus;
  pal: Palette;
  playing: boolean;
  /** 各股票盤中股價紀錄，畫走勢線用。 */
  history: Map<string, number[]>;
  /** 各股票的選股資料。 */
  fundamentals: Map<string, Fundamentals>;
}

const dirCls = (v: number) => direction(v);

/** 面板標題。 */
function title(zh: string, extra = ''): string {
  return `<h2 class="panel-title">${zh}${extra}</h2>`;
}

let lastIndex: number | undefined;

// ---------------------------------------------------------------- 頂部

export function renderTicker(el: HTMLElement, ctx: PanelContext): void {
  const { metrics: m, playing } = ctx;
  const idx = m.index;
  const d = dirCls(idx.change);
  const flash = lastIndex === undefined || idx.value === lastIndex ? '' : idx.value > lastIndex ? ' flash-up' : ' flash-down';
  lastIndex = idx.value;
  const live =
    m.session === 'closed'
      ? '<span class="live is-closed">收盤</span>'
      : playing
        ? '<span class="live"><i></i>Live</span>'
        : '<span class="live is-paused">暫停</span>';
  el.innerHTML = `
    <div class="kv kv-index"><dt>${esc(idx.name)}</dt><dd><b class="num${flash}">${num(idx.value, 2)}</b>
      <span class="num ${d}">${idx.change >= 0 ? '▲' : '▼'} ${num(Math.abs(idx.change), 2)} (${pct(idx.changePct)})</span></dd></div>
    <div class="kv"><dt>成交額</dt><dd><b class="num">${yi(idx.turnover, 0)}</b></dd></div>
    <div class="kv"><dt>上漲 / 下跌</dt><dd><b class="num"><span class="up">${m.advancers}</span> / <span class="down">${m.decliners}</span></b></dd></div>
    <div class="kv"><dt>時間</dt><dd><b class="num">${clock(m.time)}</b></dd></div>
    <div class="kv kv-live">${live}</div>`;
}

// ---------------------------------------------------------------- 左側產業清單

export function renderSectors(el: HTMLElement, ctx: PanelContext): void {
  const { metrics: m, selection } = ctx;
  const sel = selection?.kind === 'industry' ? selection.id : undefined;
  const rows = [...m.industries].sort((a, b) => b.weight - a.weight);
  el.innerHTML = `${title('產業')}<ul class="sector-list">${rows
    .map((ind) => {
      const w = Math.min(100, (Math.abs(ind.flow) / m.maxAbsFlow) * 100);
      return `<li><button class="sector${sel === ind.id ? ' is-active' : ''}" data-industry="${ind.id}" aria-pressed="${sel === ind.id}">
        <span class="s-name">${esc(ind.name)}</span>
        <span class="s-pct num ${dirCls(ind.changePct)}">${pct(ind.changePct)}</span>
        <span class="s-bar"><i class="${dirCls(ind.flow)}" style="width:${w.toFixed(1)}%"></i></span>
        <span class="s-flow num ${dirCls(ind.flow)}">${signed(ind.flow, 0)}億</span>
      </button></li>`;
    })
    .join('')}</ul>`;
}

// ---------------------------------------------------------------- 右側詳情

function kv(label: string, value: string, cls = ''): string {
  return `<div class="d-kv"><dt>${label}</dt><dd class="num ${cls}">${value}</dd></div>`;
}

function renderOverview(ctx: PanelContext): string {
  const { metrics: m, pal } = ctx;
  const byFlow = [...m.industries].sort((a, b) => b.flow - a.flow);
  const best = byFlow[0];
  const worst = byFlow[byFlow.length - 1];
  const gradient = [-3, -2, -1, 0, 1, 2, 3].map((v) => pal.heat(v)).join(',');
  return `
    ${title('市場概況')}
    <p class="d-lead">方塊面積是今日成交額，顏色是漲跌幅。點產業或個股查看細節，Esc 取消選取。</p>
    <div class="d-hero">
      <button type="button" class="hero up-card" data-industry="${best.id}"><span>最大資金流入</span><b>${esc(best.name)}</b><em class="num up">${signedYi(best.flow)}</em></button>
      <button type="button" class="hero down-card" data-industry="${worst.id}"><span>最大資金流出</span><b>${esc(worst.name)}</b><em class="num down">${signedYi(worst.flow)}</em></button>
    </div>
    <h3 class="d-sub">圖例</h3>
    <div class="legend">
      <div class="legend-row"><span class="legend-heat" style="background:linear-gradient(90deg,${gradient})"></span></div>
      <div class="legend-scale num"><span>−3%</span><span>漲跌幅</span><span>+3%</span></div>
      <div class="legend-row"><span class="lg-box lg-glow" style="--fill:${pal.up.strong}"></span>內部發光：吸金最強的 6 檔</div>
      <div class="legend-row"><span class="lg-box lg-drain" style="--fill:${pal.up.strong}"></span>顏色變淡：成交低於常態，資金撤出</div>
      <div class="legend-row"><span class="lg-box lg-spark"></span>大方塊內的線：盤中股價走勢</div>
    </div>
    <h3 class="d-sub">計算方式</h3>
    <div class="formula">
      <p><b>成交佔比</b> = 個股今日成交額 ÷ 今日總成交額</p>
      <p><b>常態</b> = 近 20 日平均成交額的佔比</p>
      <p><b>資金流</b> =（成交佔比 − 常態）× 今日總成交額</p>
      <p class="muted">所有資金流加總為 0，代表資金在股票與產業之間的轉移。</p>
    </div>`;
}

function renderIndustry(ind: IndustryMetrics, ctx: PanelContext): string {
  const { metrics: m } = ctx;
  const top = ind.stocks.slice(0, 10);
  const strength = ind.flow > 0 ? `${Math.round((ind.flow / m.maxAbsFlow) * 100)} / 100` : '資金撤出';
  return `
    <p class="eyebrow">產業</p>
    <h2 class="d-title">${esc(ind.name)} <span class="num ${dirCls(ind.changePct)}">${pct(ind.changePct)}</span></h2>
    <dl class="d-grid">
      ${kv(ind.flow >= 0 ? '資金流入' : '資金流出', signedYi(ind.flow), ind.flow >= 0 ? 'up-flow' : 'down-flow')}
      ${kv('吸金強度', strength)}
      ${kv('成交額', yi(ind.turnover))}
      ${kv('市值', yi(ind.marketCap, 0))}
      ${kv('產業權重', sharePct(ind.weight))}
      ${kv('上漲 / 下跌', `${ind.advancers} / ${ind.decliners}`)}
      ${kv('今日成交佔比', sharePct(ind.share))}
      ${kv('20 日平均佔比', sharePct(ind.baseShare))}
    </dl>
    <h3 class="d-sub">核心股票</h3>
    <table class="d-table">
      <thead><tr><th>股票</th><th>現價</th><th>漲跌</th><th>資金流</th></tr></thead>
      <tbody>${top
        .map(
          (s) => `<tr data-stock="${s.code}" tabindex="0"><td>${esc(s.name)}<small>${s.code}</small></td><td class="num">${price(s.price)}</td>
            <td class="num ${dirCls(s.changePct)}">${pct(s.changePct)}</td><td class="num ${dirCls(s.flow)}">${signed(s.flow, 1)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`;
}

function spark(series: number[] | undefined, d: string): string {
  if (!series || series.length < 3) return '';
  return `<svg class="d-spark ${d}" viewBox="0 0 280 56" preserveAspectRatio="none" aria-hidden="true">
    <path class="c-spark-area" d="${sparkArea(series, 280, 56)}"></path><path class="c-spark-line" d="${sparkPath(series, 280, 56)}"></path></svg>`;
}

function fundamentalsBlock(s: StockMetrics, f: Fundamentals | undefined): string {
  if (!f) return '';
  const v = stockView(s, f);
  const inst = f.instBuyDays >= 0 ? `連買 ${f.instBuyDays} 天` : `連賣 ${-f.instBuyDays} 天`;
  return `<h3 class="d-sub">基本面與籌碼 <small>模擬</small></h3>
    <dl class="d-grid">
      ${kv('本益比', Number.isFinite(v.pe) ? `${v.pe.toFixed(1)} 倍` : '—')}
      ${kv('殖利率', `${v.yieldPct.toFixed(2)}%`)}
      ${kv('EPS 年增（近四季）', pct(f.epsYoY, 1), dirCls(f.epsYoY))}
      ${kv('連續配息', `${f.dividendYears} 年`)}
      ${kv('3 年股價位階', `${Math.round(v.pos3y * 100)}%`)}
      ${kv('距一年高點', `${((1 - v.toHigh52w) * 100).toFixed(1)}%`)}
      ${kv('法人', inst, dirCls(f.instBuyDays))}
      ${kv('千張大戶（4 週）', `${f.bigHolderChg >= 0 ? '+' : '−'}${Math.abs(f.bigHolderChg).toFixed(1)} 百分點`, dirCls(f.bigHolderChg))}
    </dl>`;
}

function renderStock(s: StockMetrics, ctx: PanelContext): string {
  const ind = ctx.metrics.industryById.get(s.industryId);
  return `
    <p class="eyebrow">個股 · ${s.code}</p>
    <h2 class="d-title">${esc(s.name)}</h2>
    <button type="button" class="btn btn-accent btn-sm d-analyze" data-analyze="${s.code}">個股分析 →</button>
    <div class="d-price"><b class="num">${price(s.price)}</b>
      <span class="num ${dirCls(s.change)}">${s.change >= 0 ? '▲' : '▼'} ${price(Math.abs(s.change))} (${pct(s.changePct)})</span></div>
    ${spark(ctx.history.get(s.code), dirCls(s.change))}
    <dl class="d-grid">
      ${kv('成交量', `${num(s.volume)} 張`)}
      ${kv('成交額', yi(s.turnover, 2))}
      ${kv('市值', yi(s.marketCap, 0))}
      ${kv('今日資金流', signedYi(s.flow, 2), s.flow >= 0 ? 'up-flow' : 'down-flow')}
      ${kv('最高', price(s.high))}
      ${kv('最低', price(s.low))}
      ${kv('昨收', price(s.prevClose))}
      ${kv('今日成交佔比', sharePct(s.share))}
      ${kv('20 日平均佔比', sharePct(s.baseShare))}
    </dl>
    ${fundamentalsBlock(s, ctx.fundamentals.get(s.code))}
    <h3 class="d-sub">所屬產業</h3>
    <div class="chips">${ind ? `<button class="chip-btn" data-industry="${ind.id}">${esc(ind.name)} · ${pct(ind.changePct)}</button>` : ''}</div>`;
}

export function renderDetail(el: HTMLElement, ctx: PanelContext): void {
  const { selection: sel, metrics: m } = ctx;
  let html = '';
  if (sel?.kind === 'industry') {
    const ind = m.industryById.get(sel.id);
    if (ind) html = renderIndustry(ind, ctx);
  } else if (sel?.kind === 'stock') {
    const s = m.stockByCode.get(sel.id);
    if (s) html = renderStock(s, ctx);
  }
  if (!html) html = renderOverview(ctx);
  if (sel) html = `<button class="back-btn" data-clear>✕ 取消選取</button>${html}`;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- 底部

function renderIndexChart(el: HTMLElement, m: MarketMetrics): void {
  // 滑鼠停在圖上時不重畫，避免十字線被更新洗掉
  if (el.dataset.hover) return;
  const series = m.index.series;
  const w = Math.max(160, el.clientWidth);
  const h = Math.max(90, el.clientHeight);
  const pad = { l: 18, r: 52, t: 8, b: 18 };
  const t0 = series[0]?.t ?? m.time;
  const x = scaleLinear().domain([t0, t0 + SESSION_MINUTES * 60_000]).range([pad.l, w - pad.r]);
  const vals = series.map((p) => p.v).concat(m.index.prevClose);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, m.index.prevClose * 0.004);
  const y = scaleLinear().domain([lo - span * 0.1, hi + span * 0.1]).range([h - pad.b, pad.t]);
  const d = dirCls(m.index.change);
  const lineGen = d3line<{ t: number; v: number }>().x((p) => x(p.t)).y((p) => y(p.v)).curve(curveMonotoneX);
  const areaGen = d3area<{ t: number; v: number }>().x((p) => x(p.t)).y0(h - pad.b).y1((p) => y(p.v)).curve(curveMonotoneX);
  const last = series[series.length - 1];
  const ticks = [0, 90, 180, 270].map((min) => t0 + min * 60_000);

  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="加權指數盤中走勢">
    <defs><linearGradient id="idx-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-a"></stop><stop offset="1" class="stop-b"></stop></linearGradient></defs>
    <line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(m.index.prevClose)}" y2="${y(m.index.prevClose)}"></line>
    <text class="axis" x="${w - pad.r + 4}" y="${y(m.index.prevClose) + 3}">昨收</text>
    <path class="area ${d}" d="${areaGen(series) ?? ''}" fill="url(#idx-fill)"></path>
    <path class="line ${d}" d="${lineGen(series) ?? ''}"></path>
    ${last ? `<circle class="dot ${d}" cx="${x(last.t)}" cy="${y(last.v)}" r="3.5"></circle>
    <text class="axis strong" x="${w - pad.r + 4}" y="${y(last.v) + 3}">${num(last.v, 0)}</text>` : ''}
    ${ticks.map((t) => `<text class="axis" x="${x(t)}" y="${h - 4}" text-anchor="middle">${hm(t)}</text>`).join('')}
    <line class="cross" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"></line>
    <rect class="hit" x="${pad.l}" y="0" width="${w - pad.l - pad.r}" height="${h}" fill="transparent"></rect>
  </svg><div class="mini-tip" hidden></div>`;

  const svg = select(el).select('svg');
  const tip = el.querySelector<HTMLDivElement>('.mini-tip')!;
  const find = bisector<{ t: number; v: number }, number>((p) => p.t).center;
  svg.select('rect.hit')
    .on('mousemove', (e: MouseEvent) => {
      const [mx] = pointer(e);
      const p = series[find(series, x.invert(mx))];
      if (!p) return;
      el.dataset.hover = '1';
      svg.select('line.cross').attr('x1', x(p.t)).attr('x2', x(p.t)).attr('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = `${hm(p.t)}　${num(p.v, 2)}（${pct((p.v / m.index.prevClose - 1) * 100)}）`;
      tip.style.left = `${Math.min(x(p.t) + 8, w - 170)}px`;
    })
    .on('mouseleave', () => {
      delete el.dataset.hover;
      svg.select('line.cross').attr('visibility', 'hidden');
      tip.hidden = true;
    });
}

function renderFlowRank(m: MarketMetrics): string {
  const rows = [...m.industries].sort((a, b) => b.flow - a.flow);
  return rows
    .map((ind) => {
      const w = (Math.abs(ind.flow) / m.maxAbsFlow) * 50;
      const d = dirCls(ind.flow);
      const bar = ind.flow >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      return `<button class="flow-row" data-industry="${ind.id}"><span class="f-name">${esc(ind.name)}</span>
        <span class="f-track"><i class="${d}" style="${bar}"></i></span><span class="f-val num ${d}">${signed(ind.flow, 1)}</span></button>`;
    })
    .join('');
}

function renderMovers(m: MarketMetrics): string {
  const stocks = [...m.stockByCode.values()].sort((a, b) => b.flow - a.flow);
  const row = (st: StockMetrics) => `<button class="mover" data-stock="${st.code}">
      <span class="mv-name">${esc(st.name)}</span>
      <span class="mv-pct num ${dirCls(st.changePct)}">${pct(st.changePct)}</span>
      <span class="mv-flow num ${dirCls(st.flow)}">${signed(st.flow, 1)}</span></button>`;
  return `<div class="movers-col"><h3>流入最多</h3>${stocks.slice(0, 5).map(row).join('')}</div>
    <div class="movers-col"><h3>流出最多</h3>${stocks.slice(-5).reverse().map(row).join('')}</div>`;
}

export function renderDock(el: HTMLElement, ctx: PanelContext, renderRotationInto: (el: HTMLElement) => void): void {
  const { metrics: m } = ctx;
  if (!el.dataset.ready) {
    el.innerHTML = `
      <section class="card glass card-index">${title('加權指數')}<div class="chart" id="index-chart"></div></section>
      <section class="card glass card-rotation">${title('資金輪動', ' <small>每格 5 分鐘・成交佔比偏離常態的百分點</small>')}<div class="rotation" id="rotation"></div></section>
      <section class="card glass card-flow">${title('產業資金流', ' <small>億元</small>')}<div class="flow-rank" id="flow-rank"></div></section>
      <section class="card glass card-movers">${title('個股資金流', ' <small>億元</small>')}<div class="movers" id="movers"></div></section>`;
    el.dataset.ready = '1';
  }
  renderIndexChart(el.querySelector('#index-chart')!, m);
  renderRotationInto(el.querySelector('#rotation')!);
  el.querySelector('#flow-rank')!.innerHTML = renderFlowRank(m);
  el.querySelector('#movers')!.innerHTML = renderMovers(m);
}

// ---------------------------------------------------------------- 事件紀錄

const LEVEL_MARK: Record<EventLevel, string> = { info: '', alert: '', critical: '' };

export function renderLog(el: HTMLElement, events: MarketEvent[], freshIds: Set<number>): void {
  if (!events.length) {
    el.innerHTML = '<li class="log-empty">尚無盤中事件。</li>';
    return;
  }
  el.innerHTML = events
    .map((e) => {
      const ref = e.code ? `data-stock="${e.code}"` : e.industryId ? `data-industry="${e.industryId}"` : '';
      const tag = ref ? 'button' : 'span';
      return `<li class="log-item lv-${e.level}${freshIds.has(e.id) ? ' is-new' : ''}">
        <span class="log-t num">${clock(e.t)}</span><span class="log-mark" aria-hidden="true">${LEVEL_MARK[e.level]}</span>
        <${tag} class="log-text" ${ref}>${esc(e.text)}</${tag}></li>`;
    })
    .join('');
}
