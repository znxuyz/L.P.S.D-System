import { ETF_CATEGORY_LABEL } from '../data/mockEtfs';
import type { EtfCategory } from '../data/types';
import { summarizeEtfs, type EtfView } from '../domain/etf';
import { direction, escapeHtml as esc, num, pct, price, signed, signedYi, yi } from './format';
import { sparkArea, sparkPath } from './spark';

export type EtfFilter = EtfCategory | 'all';

/** 左側：類別篩選與各類平均漲跌。 */
export function renderEtfCategories(el: HTMLElement, etfs: EtfView[], active: EtfFilter): void {
  const sums = summarizeEtfs(etfs);
  const allAvg = etfs.length ? etfs.reduce((s, e) => s + e.changePct, 0) / etfs.length : 0;
  const item = (id: EtfFilter, label: string, count: number, avg: number, turnover: number) =>
    `<button type="button" class="etf-cat${id === active ? ' is-active' : ''}" data-etf-cat="${id}" aria-pressed="${id === active}">
      <span class="etf-cat-name">${label}</span><span class="num ${direction(avg)}">${pct(avg)}</span>
      <span class="etf-cat-meta">${count} 檔・成交 ${yi(turnover, 0)}</span></button>`;
  el.innerHTML =
    `<h2 class="panel-title">ETF 類別</h2><div class="etf-cats">` +
    item('all', '全部', etfs.length, allAvg, etfs.reduce((s, e) => s + e.turnover, 0)) +
    sums.map((s) => item(s.category, ETF_CATEGORY_LABEL[s.category], s.count, s.avgChangePct, s.turnover)).join('') +
    `</div><p class="muted small etf-note">ETF 的成交額不計入熱力圖的資金流，避免和成分股重複計算；右邊的「成分股資金流」是成分股今天的資金方向。</p>`;
}

/** 中間：ETF 列表。 */
export function renderEtfTable(el: HTMLElement, etfs: EtfView[], filter: EtfFilter, selected: string | null): void {
  const list = etfs.filter((e) => filter === 'all' || e.meta.category === filter).sort((a, b) => b.turnover - a.turnover);
  const title = filter === 'all' ? '全部 ETF' : `${ETF_CATEGORY_LABEL[filter]} ETF`;
  el.innerHTML = `
    <header class="scr-head">
      <div><p class="eyebrow">Exchange-Traded Funds</p><h2 class="scr-title">${title}</h2>
        <p class="scr-idea">依今日成交額排序。殖利率與折溢價隨即時股價計算。</p></div>
    </header>
    <div class="scr-table-wrap">
      <table class="scr-table etf-table">
        <thead><tr><th>ETF</th><th>現價</th><th>漲跌</th><th>成交額</th><th>殖利率</th><th>配息</th><th>折溢價</th><th>規模</th><th>內扣</th><th>成分股資金流</th></tr></thead>
        <tbody>${list
          .map((e) => {
            const d = direction(e.changePct);
            return `<tr data-etf="${e.meta.code}" tabindex="0" class="${selected === e.meta.code ? 'is-selected' : ''}">
              <td><b>${esc(e.meta.name)}</b><small>${e.meta.code}・<span class="etf-tag tag-${e.meta.category}">${ETF_CATEGORY_LABEL[e.meta.category]}</span></small></td>
              <td class="num">${price(e.price)}</td>
              <td class="num ${d}">${pct(e.changePct)}</td>
              <td class="num">${yi(e.turnover)}</td>
              <td class="num">${e.yieldPct.toFixed(2)}%</td>
              <td>${e.meta.frequency}配</td>
              <td class="num ${e.premiumPct > 0.3 ? 'warn' : ''}">${signed(e.premiumPct, 2)}%</td>
              <td class="num">${yi(e.meta.aum, 0)}</td>
              <td class="num">${e.meta.expenseRatio.toFixed(2)}%</td>
              <td class="num ${e.holdings.length ? direction(e.holdingsFlow) : ''}">${e.holdings.length ? signedYi(e.holdingsFlow) : '—'}</td></tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>
    <p class="muted small">ETF 的股價、規模、配息、費用率與成分股權重為模擬資料，不代表實際數字。</p>`;
}

function kv(label: string, value: string, cls = ''): string {
  return `<div class="d-kv"><dt>${label}</dt><dd class="num ${cls}">${value}</dd></div>`;
}

/** 右側：ETF 細節。 */
export function renderEtfDetail(el: HTMLElement, e: EtfView | undefined, history: number[] | undefined): void {
  if (!e) {
    el.innerHTML = `<h2 class="panel-title">ETF 細節</h2><p class="d-lead">點左邊列表裡的 ETF，查看配息、規模、折溢價與成分股。</p>`;
    return;
  }
  const d = direction(e.change);
  const spark =
    history && history.length > 2
      ? `<svg class="d-spark ${d}" viewBox="0 0 280 56" preserveAspectRatio="none" aria-hidden="true">
          <path class="c-spark-area" d="${sparkArea(history, 280, 56)}"></path><path class="c-spark-line" d="${sparkPath(history, 280, 56)}"></path></svg>`
      : '';
  const maxW = Math.max(1, ...e.holdings.map((h) => h.weight));
  const holdings = e.holdings.length
    ? `<h3 class="d-sub">前幾大成分股 <small>佔 ${num(e.coveredWeight, 1)}%・加權漲跌 <span class="${direction(e.holdingsChangePct)}">${pct(e.holdingsChangePct)}</span></small></h3>
      <ul class="hold-list">${e.holdings
        .map(
          (h) => `<li><span class="hold-name">${esc(h.stock.name)}<small>${h.stock.code}</small></span>
            <span class="hold-bar"><i style="width:${((h.weight / maxW) * 100).toFixed(1)}%"></i></span>
            <span class="num hold-w">${h.weight.toFixed(1)}%</span>
            <span class="num ${direction(h.stock.changePct)}">${pct(h.stock.changePct)}</span>
            <span class="num ${direction(h.stock.flow)}">${signed(h.stock.flow, 1)}</span></li>`,
        )
        .join('')}</ul>
      <button type="button" class="btn btn-accent btn-block" data-etf-highlight="${e.meta.code}">在熱力圖上標示成分股</button>`
    : `<h3 class="d-sub">投資標的</h3><p class="d-lead">${esc(e.meta.underlying)}。債券型 ETF 不持有台股，沒有成分股可以對照熱力圖。</p>`;
  el.innerHTML = `
    <p class="eyebrow">${ETF_CATEGORY_LABEL[e.meta.category]} ETF · ${e.meta.code}</p>
    <h2 class="d-title">${esc(e.meta.name)}</h2>
    <div class="d-price"><b class="num">${price(e.price)}</b>
      <span class="num ${d}">${e.change >= 0 ? '▲' : '▼'} ${price(Math.abs(e.change))} (${pct(e.changePct)})</span></div>
    ${spark}
    <dl class="d-grid">
      ${kv('預估淨值', price(e.nav))}
      ${kv('折溢價', `${signed(e.premiumPct, 2)}%`, e.premiumPct > 0.3 ? 'warn' : '')}
      ${kv('殖利率', `${e.yieldPct.toFixed(2)}%`)}
      ${kv('配息', `${e.meta.frequency}配・${e.meta.dividendPerYear.toFixed(2)} 元／年`)}
      ${kv('連續配息', `${e.meta.dividendYears} 年`)}
      ${kv('近一年填息率', `${e.meta.fillRate}%`)}
      ${kv('規模', yi(e.meta.aum, 0))}
      ${kv('內扣費用', `${e.meta.expenseRatio.toFixed(2)}%／年`)}
      ${kv('受益人數', `${e.meta.holders} 萬人`)}
      ${kv('今日成交額', yi(e.turnover))}
    </dl>
    <p class="muted small etf-under">追蹤：${esc(e.meta.underlying)}</p>
    ${holdings}`;
}
