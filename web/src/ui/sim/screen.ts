/** 模擬盤的「五大選股」分頁：前一個交易日收盤後的篩選結果（只用到當時看得到的資料）。 */
import type { SimScreenMonth } from '../../data/simData';
import { STRATEGIES, type StrategyId } from '../../domain/screens';
import { escapeHtml as esc, pct, price } from '../format';
import type { RankRow } from './rank';
import { cls } from './util';

export function screenHtml(opts: {
  strategy: StrategyId;
  /** 篩選的那一天（前一個交易日）；沒有時 null。 */
  day: string | null;
  month: SimScreenMonth | null | undefined;
  /** 今天全市場的盤中路徑（現價與漲跌用）。 */
  today: RankRow[] | null;
  minute: number;
  pre: boolean;
  watch: string;
  nameOf: (code: string) => string;
}): string {
  const st = STRATEGIES.find((s) => s.id === opts.strategy) ?? STRATEGIES[0];
  const tabs = STRATEGIES.map((s) => `<button type="button" data-sim="screen-${s.id}" aria-pressed="${s.id === st.id}">${esc(s.name)}</button>`).join('');
  const head = `<h2 class="panel-title">五大選股 <small>前一個交易日收盤後篩選，只用到當時看得到的資料</small></h2>
    <div class="seg sim-screen-tabs" role="group" aria-label="選股策略">${tabs}</div>
    <p class="sim-screen-idea"><b>${esc(st.idea)}</b>：${esc(st.ideaDetail)}。<span class="muted">${esc(st.fit)}</span></p>
    <ul class="sim-screen-rules">${st.criteria.map((c) => `<li>${esc(c.label)}</li>`).join('')}</ul>`;
  if (opts.month === undefined) return `${head}<p class="muted">載入篩選結果⋯⋯</p>`;
  const list = opts.day ? opts.month?.days[opts.day]?.[st.id] : undefined;
  if (!list) return `${head}<p class="muted">這一天沒有篩選結果（資料還不夠，或那一天沒有全市場資料）。</p>`;
  if (!list.length) return `${head}<p class="muted">前一個交易日收盤後，沒有股票同時符合這些條件。</p>`;
  const now = new Map((opts.today ?? []).map((r) => [r.code, r]));
  const t = Math.max(0, Math.floor(opts.minute));
  const rows = list
    .map(([code, cols], i) => {
      const r = now.get(code);
      const p = r ? (opts.pre ? r.pc : r.path.price[Math.min(t, r.path.price.length - 1)]) : null;
      const chg = r && p != null && r.pc ? p / r.pc - 1 : null;
      return `<tr data-sim="watch" data-code="${esc(code)}" class="${code === opts.watch ? 'is-watch' : ''}">
        <td class="num muted">${i + 1}</td><td><b>${esc(code)}</b> ${esc(opts.nameOf(code))}</td>
        ${cols.map((c) => `<td class="num">${esc(c)}</td>`).join('')}
        <td class="num">${p == null ? '—' : price(p)}</td><td class="num ${chg == null ? '' : cls(chg)}">${chg == null ? '—' : pct(chg * 100)}</td></tr>`;
    })
    .join('');
  return `${head}<div class="sim-table-wrap"><table class="sim-table sim-screen-table"><thead><tr><th>#</th><th>股票</th>${st.columns
    .map((c) => `<th>${esc(c.label)}</th>`)
    .join('')}<th>現價</th><th>今日</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted sim-note">共 ${list.length} 檔（最多列 20 檔，依策略排序）。點一列看那一檔。條件跟首頁「五大選股」相同；配息只有 2016 年起的資料、千張大戶只有最近一年，資料不夠時那個條件放寬或略過。</p>`;
}
