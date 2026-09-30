import { area as d3area, bisector, line as d3line, pointer, scaleLinear, select } from 'd3';
import { SESSION_MINUTES } from '../data/twse';
import { TIER_LABEL, defenceOf, statusText, type CastleState } from '../domain/castles';
import type { IndustryMetrics, MarketMetrics, StockMetrics } from '../domain/metrics';
import type { SelectionRef } from './battlefieldView';
import { CONTESTANT_COLORS, type Palette } from './colors';
import { clock, direction, escapeHtml as esc, hm, num, pct, price, sharePct, signed, signedYi, yi } from './format';

export interface PanelContext {
  metrics: MarketMetrics;
  castles: CastleState[];
  selection: SelectionRef;
  pal: Palette;
  playing: boolean;
}

const dirCls = (v: number) => direction(v);

// ---------------------------------------------------------------- 頂部

export function renderTicker(el: HTMLElement, ctx: PanelContext): void {
  const { metrics: m, playing } = ctx;
  const idx = m.index;
  const d = dirCls(idx.change);
  const live =
    m.session === 'closed'
      ? '<span class="live is-closed">收盤</span>'
      : playing
        ? '<span class="live"><i></i>LIVE</span>'
        : '<span class="live is-paused">暫停</span>';
  el.innerHTML = `
    <div class="kv kv-index"><dt>${esc(idx.name)}</dt><dd><b class="num">${num(idx.value, 2)}</b>
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
  el.innerHTML = `<h2 class="panel-title">產業領地</h2><ul class="sector-list">${rows
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

function strengthOf(ind: IndustryMetrics, m: MarketMetrics): string {
  if (ind.flow <= 0) return '撤退中';
  return `${Math.round((ind.flow / m.maxAbsFlow) * 100)} / 100`;
}

function castleChip(c: CastleState): string {
  return `<button class="chip-btn" data-castle="${c.site.id}">${c.site.label} · ${esc(statusText(c))}</button>`;
}

function renderOverview(ctx: PanelContext): string {
  const { metrics: m, castles, pal } = ctx;
  const byFlow = [...m.industries].sort((a, b) => b.flow - a.flow);
  const count = (s: CastleState['status']) => castles.filter((c) => c.status === s).length;
  const gradient = [-3, -2, -1, 0, 1, 2, 3].map((v) => pal.heat(v)).join(',');
  return `
    <h2 class="panel-title">戰況總覽</h2>
    <p class="d-lead">點選產業、股票或城池，查看資料與攻防狀態。滾輪或雙指可以縮放地圖。</p>
    <dl class="d-grid">
      ${kv('最強攻勢', `${esc(byFlow[0].name)} ${signedYi(byFlow[0].flow)}`, 'up-flow')}
      ${kv('最大撤退', `${esc(byFlow[byFlow.length - 1].name)} ${signedYi(byFlow[byFlow.length - 1].flow)}`, 'down-flow')}
      ${kv('占領中城池', `${count('occupied')} 座`)}
      ${kv('爭奪中城池', `${count('contested')} 座`)}
      ${kv('推進中城池', `${count('advancing')} 座`)}
      ${kv('中立城池', `${count('neutral')} 座`)}
    </dl>
    <h3 class="d-sub">圖例</h3>
    <div class="legend">
      <div class="legend-row"><span class="legend-heat" style="background:linear-gradient(90deg,${gradient})"></span></div>
      <div class="legend-scale num"><span>−3%</span><span>0</span><span>+3%</span></div>
      <div class="legend-row"><i class="swatch" style="background:${pal.up.bright}"></i>資金流入：向城池推進的兵力流</div>
      <div class="legend-row"><i class="swatch" style="background:${pal.down.bright}"></i>資金流出：撤回領地的兵力流</div>
      <div class="legend-row">${CONTESTANT_COLORS.map((c) => `<i class="swatch" style="background:${c}"></i>`).join('')}城池陣營色（依相鄰產業排序）</div>
      <div class="legend-row">方塊面積 = 市值　方塊顏色 = 漲跌幅</div>
    </div>
    <h3 class="d-sub">計算方式</h3>
    <div class="formula">
      <p><b>資金流</b> =（今日成交佔比 − 20 日平均成交佔比）× 今日總成交額</p>
      <p><b>占領度</b> = 攻城資金 ÷（各方攻城資金 + 守城兵力）</p>
      <p class="muted">所有產業的資金流加總為 0，代表資金在產業之間的轉移。守城兵力 = 總成交額 × 1% × 城池規模。</p>
    </div>`;
}

function renderIndustry(ind: IndustryMetrics, ctx: PanelContext): string {
  const { metrics: m, castles } = ctx;
  const involved = castles.filter((c) => c.site.contestants.includes(ind.id));
  const top = ind.stocks.slice(0, 8);
  return `
    <p class="eyebrow">產業領地</p>
    <h2 class="d-title">${esc(ind.name)} <span class="num ${dirCls(ind.changePct)}">${pct(ind.changePct)}</span></h2>
    <dl class="d-grid">
      ${kv(ind.flow >= 0 ? '資金流入' : '資金流出', signedYi(ind.flow), ind.flow >= 0 ? 'up-flow' : 'down-flow')}
      ${kv('攻城強度', strengthOf(ind, m))}
      ${kv('成交額', yi(ind.turnover))}
      ${kv('市值', yi(ind.marketCap, 0))}
      ${kv('產業權重', sharePct(ind.weight))}
      ${kv('上漲 / 下跌', `${ind.advancers} / ${ind.decliners}`)}
      ${kv('今日成交佔比', sharePct(ind.share))}
      ${kv('20 日平均佔比', sharePct(ind.baseShare))}
    </dl>
    <h3 class="d-sub">參與的城池</h3>
    <div class="chips">${involved.length ? involved.map(castleChip).join('') : '<span class="muted">沒有相鄰的城池</span>'}</div>
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

function renderStock(s: StockMetrics, ctx: PanelContext): string {
  const ind = ctx.metrics.industryById.get(s.industryId);
  return `
    <p class="eyebrow">個股據點 · ${s.code}</p>
    <h2 class="d-title">${esc(s.name)}</h2>
    <div class="d-price"><b class="num">${price(s.price)}</b>
      <span class="num ${dirCls(s.change)}">${s.change >= 0 ? '▲' : '▼'} ${price(Math.abs(s.change))} (${pct(s.changePct)})</span></div>
    <dl class="d-grid">
      ${kv('成交量', `${num(s.volume)} 張`)}
      ${kv('成交額', yi(s.turnover, 2))}
      ${kv('市值', yi(s.marketCap, 0))}
      ${kv('今日資金流', signedYi(s.flow, 2), s.flow >= 0 ? 'up-flow' : 'down-flow')}
      ${kv('最高', price(s.high))}
      ${kv('最低', price(s.low))}
      ${kv('昨收', price(s.prevClose))}
      ${kv('產業內權重', ind ? sharePct(s.marketCap / ind.marketCap) : '—')}
    </dl>
    <h3 class="d-sub">所屬產業</h3>
    <div class="chips">${ind ? `<button class="chip-btn" data-industry="${ind.id}">${esc(ind.name)} · ${pct(ind.changePct)}</button>` : ''}</div>`;
}

function renderCastle(c: CastleState, ctx: PanelContext): string {
  const { metrics: m } = ctx;
  const defence = defenceOf(c.site, m.totalTurnover);
  const bars = c.contestants
    .map((x) => {
      const occ = Math.round(x.occupancy * 1000) / 10;
      return `<div class="siege-row">
        <div class="siege-head"><span><i class="swatch" style="background:${CONTESTANT_COLORS[x.slot]}"></i>
          <button class="link-btn" data-industry="${x.industryId}">${esc(x.name)}</button>${x.retreating ? '<em class="tag down">撤退</em>' : ''}</span>
          <span class="num">${num(occ, 1)}%</span></div>
        <div class="siege-bar"><i style="width:${occ}%;background:${CONTESTANT_COLORS[x.slot]}"></i></div>
        <div class="siege-foot num ${dirCls(x.flow)}">資金流 ${signedYi(x.flow)}</div>
      </div>`;
    })
    .join('');
  return `
    <p class="eyebrow">${TIER_LABEL[c.site.tier]}</p>
    <h2 class="d-title">【資金城池 ${c.site.label}】</h2>
    <p class="status-pill status-${c.status}">${esc(statusText(c))}</p>
    <div class="siege">${bars}
      <div class="siege-row"><div class="siege-head"><span><i class="swatch neutral"></i>中立</span><span class="num">${num(c.neutral * 100, 1)}%</span></div>
      <div class="siege-bar"><i class="neutral" style="width:${c.neutral * 100}%"></i></div></div>
    </div>
    <dl class="d-grid">
      ${kv('今日攻城資金', signedYi(c.siegeFunds), 'up-flow')}
      ${kv('守城兵力', yi(defence))}
      ${kv('最後更新', clock(m.time))}
    </dl>
    <p class="muted small">這座城池位在 ${c.contestants.map((x) => esc(x.name)).join('、')} 的交界。資金流入的產業向城池推進，流入越多，推進越深、占領度越高。</p>`;
}

export function renderDetail(el: HTMLElement, ctx: PanelContext): void {
  const { selection: sel, metrics: m, castles } = ctx;
  let html = '';
  if (sel?.kind === 'industry') {
    const ind = m.industryById.get(sel.id);
    if (ind) html = renderIndustry(ind, ctx);
  } else if (sel?.kind === 'stock') {
    const s = m.stockByCode.get(sel.id);
    if (s) html = renderStock(s, ctx);
  } else if (sel?.kind === 'castle') {
    const c = castles.find((x) => x.site.id === sel.id);
    if (c) html = renderCastle(c, ctx);
  }
  if (!html) html = renderOverview(ctx);
  if (sel) html = `<button class="back-btn" data-clear>← 戰況總覽</button>${html}`;
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
  const lineGen = d3line<{ t: number; v: number }>().x((p) => x(p.t)).y((p) => y(p.v));
  const areaGen = d3area<{ t: number; v: number }>().x((p) => x(p.t)).y0(y(m.index.prevClose)).y1((p) => y(p.v));
  const last = series[series.length - 1];
  const ticks = [0, 90, 180, 270].map((min) => t0 + min * 60_000);

  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="加權指數盤中走勢">
    <line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(m.index.prevClose)}" y2="${y(m.index.prevClose)}"></line>
    <text class="axis" x="${w - pad.r + 4}" y="${y(m.index.prevClose) + 3}">昨收</text>
    <path class="area ${d}" d="${areaGen(series) ?? ''}"></path>
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

function renderExtremes(m: MarketMetrics): string {
  const sorted = [...m.industries].sort((a, b) => b.flow - a.flow);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const block = (label: string, ind: IndustryMetrics) => `<button class="extreme" data-industry="${ind.id}">
      <span class="x-label">${label}</span><span class="x-name">${esc(ind.name)}</span>
      <span class="x-val num ${dirCls(ind.flow)}">${signedYi(ind.flow)}</span>
      <span class="x-sub num">佔比 ${sharePct(ind.baseShare)} → ${sharePct(ind.share)}</span></button>`;
  return block('最大資金流入', best) + block('最大資金流出', worst);
}

function castleRow(c: CastleState, value: string): string {
  const segs = c.contestants
    .filter((x) => x.occupancy > 0)
    .map((x) => `<i style="width:${x.occupancy * 100}%;background:${CONTESTANT_COLORS[x.slot]}"></i>`)
    .join('');
  return `<button class="castle-row" data-castle="${c.site.id}"><span class="c-id num">${c.site.label}</span>
    <span class="c-body"><span class="c-text">${value}</span><span class="c-bar">${segs}<i class="neutral" style="width:${c.neutral * 100}%"></i></span></span></button>`;
}

function renderContested(castles: CastleState[]): string {
  const list = castles
    .filter((c) => c.intensity > 0)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5);
  if (!list.length) return '<p class="muted small">目前沒有兩方同時進攻的城池。</p>';
  return list
    .map((c) => {
      const [a, b] = [...c.contestants].sort((p, q) => q.occupancy - p.occupancy);
      return castleRow(c, `${esc(a.short)} ${Math.round(a.occupancy * 100)}% vs ${esc(b.short)} ${Math.round(b.occupancy * 100)}%`);
    })
    .join('');
}

function renderOccupation(castles: CastleState[]): string {
  const list = castles
    .filter((c) => c.leader)
    .sort((a, b) => b.leader!.occupancy - a.leader!.occupancy)
    .slice(0, 5);
  if (!list.length) return '<p class="muted small">所有城池都維持中立。</p>';
  return list.map((c) => castleRow(c, `${esc(c.leader!.name)} ${Math.round(c.leader!.occupancy * 100)}%`)).join('');
}

export function renderDock(el: HTMLElement, ctx: PanelContext): void {
  const { metrics: m, castles } = ctx;
  if (!el.dataset.ready) {
    el.innerHTML = `
      <section class="card card-index"><h2 class="panel-title">大盤走勢</h2><div class="chart" id="index-chart"></div></section>
      <section class="card card-flow"><h2 class="panel-title">資金流排行 <small>億元</small></h2><div class="flow-rank" id="flow-rank"></div></section>
      <section class="card card-extreme"><h2 class="panel-title">資金動向</h2><div class="extremes" id="extremes"></div></section>
      <section class="card card-contest"><h2 class="panel-title">正在爭奪的城池</h2><div class="castle-list" id="contested"></div></section>
      <section class="card card-occupy"><h2 class="panel-title">城池占領排行</h2><div class="castle-list" id="occupation"></div></section>`;
    el.dataset.ready = '1';
  }
  renderIndexChart(el.querySelector('#index-chart')!, m);
  el.querySelector('#flow-rank')!.innerHTML = renderFlowRank(m);
  el.querySelector('#extremes')!.innerHTML = renderExtremes(m);
  el.querySelector('#contested')!.innerHTML = renderContested(castles);
  el.querySelector('#occupation')!.innerHTML = renderOccupation(castles);
}
