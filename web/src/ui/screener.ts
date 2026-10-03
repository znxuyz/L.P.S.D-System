import type { Universe } from '../data/types';
import { STRATEGIES, runScreen, strategyById, type ScreenRow, type StrategyId } from '../domain/screens';
import type { MarketMetrics } from '../domain/metrics';
import { direction, escapeHtml as esc, pct, price } from './format';

const STATUS_LABEL = { match: '符合', near: '接近', miss: '' } as const;

/** 左側：五個策略與目前符合的檔數。 */
export function renderStrategyList(el: HTMLElement, metrics: MarketMetrics, universe: Universe, active: StrategyId): void {
  el.innerHTML =
    `<h2 class="panel-title">五大核心選股</h2>` +
    `<div class="strat-list">${STRATEGIES.map((s) => {
      const n = runScreen(s, metrics, universe).filter((r) => r.status === 'match').length;
      return `<button type="button" class="strat${s.id === active ? ' is-active' : ''}" data-strategy="${s.id}" aria-pressed="${s.id === active}">
        <span class="strat-en">${s.en}</span>
        <span class="strat-name">${esc(s.name)}</span>
        <span class="strat-idea">${esc(s.idea)}</span>
        <span class="strat-count"><b class="num">${n}</b> 檔符合</span>
      </button>`;
    }).join('')}</div>`;
}

function statusCell(r: ScreenRow): string {
  return r.status === 'miss' ? '<span class="st st-miss">—</span>' : `<span class="st st-${r.status}">${STATUS_LABEL[r.status]}</span>`;
}

/** 中間：策略說明、條件與篩選結果。 */
export function renderScreen(el: HTMLElement, metrics: MarketMetrics, universe: Universe, id: StrategyId, selected: string | null): void {
  const s = strategyById(id);
  const rows = runScreen(s, metrics, universe);
  const matched = rows.filter((r) => r.status === 'match');
  const near = rows.filter((r) => r.status === 'near');
  const shown = [...matched, ...near].slice(0, 40);
  const passCount = s.criteria.map((_, i) => rows.filter((r) => r.checks[i].pass).length);
  const total = universe.stocks.length;

  el.innerHTML = `
    <header class="scr-head">
      <div>
        <p class="eyebrow">${s.en}</p>
        <h2 class="scr-title">${esc(s.name)}</h2>
        <p class="scr-idea"><b>${esc(s.idea)}</b>　${esc(s.ideaDetail)}</p>
      </div>
      <button type="button" class="btn btn-accent" data-highlight="${s.id}">在熱力圖上標示 ${matched.length} 檔</button>
    </header>
    <div class="scr-facts">
      <div class="fact"><span>優點</span><p>${esc(s.pros)}</p></div>
      <div class="fact"><span>缺點 / 風險</span><p>${esc(s.cons)}</p></div>
      <div class="fact"><span>適合投資人</span><p>${esc(s.fit)}</p></div>
    </div>
    <h3 class="d-sub">篩選條件${s.match === 'any' ? '（任一成立即符合）' : '（全部成立才符合）'}</h3>
    <ol class="crit-list">${s.criteria
      .map((c, i) => `<li><span class="crit-i num">${i + 1}</span><span class="crit-label">${esc(c.label)}</span>
        <span class="crit-bar"><i style="width:${((passCount[i] / total) * 100).toFixed(1)}%"></i></span>
        <span class="crit-n num">${passCount[i]} / ${total}</span></li>`)
      .join('')}</ol>
    <h3 class="d-sub">篩選結果 <small>符合 ${matched.length} 檔${s.match === 'all' ? `・接近 ${near.length} 檔（只差一個條件）` : ''}</small></h3>
    <div class="scr-table-wrap">
      <table class="scr-table">
        <thead><tr><th>股票</th><th>現價</th><th>漲跌</th>${s.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}
          <th>條件</th><th>狀態</th></tr></thead>
        <tbody>${
          shown.length
            ? shown
                .map((r) => {
                  const st = r.view.stock;
                  const d = direction(st.changePct);
                  const ind = metrics.industryById.get(st.industryId);
                  return `<tr data-stock="${st.code}" tabindex="0" class="${selected === st.code ? 'is-selected' : ''}">
                  <td><b>${esc(st.name)}</b><small>${st.code}・${esc(ind?.name ?? '')}</small></td>
                  <td class="num">${price(st.price)}</td>
                  <td class="num ${d}">${pct(st.changePct)}</td>
                  ${s.columns.map((c) => `<td class="num">${esc(c.value(r.view))}</td>`).join('')}
                  <td><span class="dots">${r.checks
                    .map((c, i) => `<i class="${c.pass ? 'on' : ''}" title="${esc(s.criteria[i].label)}：${esc(c.value)}"></i>`)
                    .join('')}</span></td>
                  <td>${statusCell(r)}</td></tr>`;
                })
                .join('')
            : `<tr><td colspan="${5 + s.columns.length}" class="muted">目前沒有符合的股票。</td></tr>`
        }</tbody>
      </table>
    </div>
    <p class="muted small">基本面、籌碼與事件資料為模擬資料；本益比、殖利率、股價位階會隨即時股價重新計算。</p>`;
}
