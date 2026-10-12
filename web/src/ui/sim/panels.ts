/** 遊戲中的各個面板（純粹由狀態產生 HTML）。 */
import { clock } from '../../domain/intraday';
import {
  KIND_NAME,
  LOAN_LIMIT,
  LOAN_RATE,
  LOAN_TERMS,
  PLEDGE_CALL,
  PLEDGE_LTV,
  PLEDGE_RATE,
  debtOf,
  investedOf,
  pledgeRatio,
  pledgedShares,
  priceNow,
  stopOf,
  summarize,
  unrealizedOf,
  type SimState,
} from '../../domain/sim';
import { type NewsItem, newsMinute } from '../../data/simData';
import { escapeHtml as esc, num, pct, price } from '../format';
import { returnChart } from './charts';
import { actionName, cls, garble, investedAt, money, pctOrDash, weekday, type SimCtx } from './util';

export function newsHtml(s: SimState, news: NewsItem[]): string {
  const head = '<h2 class="panel-title">新聞 <small>日期已隱藏</small></h2>';
  // 今天的新聞要等到發布時間（開盤前 09:00、收盤後 13:30）才看得到
  // 盤前只看得到今天 09:00 以前發布的新聞
  const now = s.pre ? -1 : s.minute;
  const visible = news.filter(([d, time]) => d < s.date || (d === s.date && newsMinute(time) <= now));
  const items = visible.slice(-25).reverse();
  if (!items.length) return `${head}<p class="muted">還沒有新聞。</p>`;
  return `${head}<ol class="sim-newslist">${items
    .map(([d, , level, title]) => `<li class="sim-news-${level}"><span class="sim-news-date num">${garble(d)}（${weekday(d)}）</span><span class="sim-news-title">${esc(title)}</span></li>`)
    .join('')}</ol>`;
}

export function holdHtml(s: SimState, ctx: SimCtx): string {
  const rows = s.pos
    .map((p) => {
      const { now, pnl, base } = unrealizedOf(p, s, ctx.market);
      const st = stopOf(s, p);
      const pledged = p.kind === 'cash' ? pledgedShares(s, p.code) : 0;
      const stop = st ? `${st.loss != null ? `<span class="down">損 ${st.loss}</span>` : ''}${st.loss != null && st.profit != null ? '<br />' : ''}${st.profit != null ? `<span class="up">利 ${st.profit}</span>` : ''}` : '<span class="muted">—</span>';
      return `<tr data-sim="watch" data-code="${esc(p.code)}" tabindex="0">
        <td><b>${esc(p.code)}</b> ${esc(ctx.nameOf(p.code))}</td>
        <td><span class="sim-kind sim-kind-${p.kind}">${KIND_NAME[p.kind]}${p.dir === 'short' && p.kind === 'day' ? '空' : ''}</span></td>
        <td class="num">${num(p.shares)}${pledged ? `<br /><small class="muted">質押 ${num(pledged)}</small>` : ''}</td>
        <td class="num">${price(p.cost / p.shares)}</td>
        <td class="num">${now != null ? price(now) : '—'}</td>
        <td class="num ${cls(pnl)}">${money(pnl)}<br /><small>${pct((pnl / Math.max(1, base)) * 100)}</small></td>
        <td class="num sim-stopcell">${stop}</td>
      </tr>`;
    })
    .join('');
  return `<h2 class="panel-title">部位 <small>未實現損益已扣掉了結時的手續費與稅${s.pos.some((p) => p.kind === 'margin') ? '、融資利息' : ''}</small></h2>
    ${rows ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>類別</th><th>股數</th><th>成本</th><th>現價</th><th>未實現損益</th><th>停損／停利</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">還沒有部位。看看排行或搜尋一檔股票，盤中下單吧。</p>'}`;
}

/** 最近一次收盤的結算：今日損益分成已實現與未實現。 */
export function dayReportHtml(s: SimState, fresh: boolean): string {
  const head = (t: string) => `<h2 class="panel-title">${t} <small>每天收盤後更新</small></h2>`;
  const rec = s.days.at(-1);
  if (!rec) return `${head('收盤結算')}<p class="muted">今天收盤後，這裡會列出當日損益（已實現／未實現）、手續費與成交筆數。</p>`;
  const i = s.equity.findIndex(([d]) => d === rec.d);
  const prev = i > 0 ? s.equity[i - 1][1] : s.settings.capital;
  const total = rec.eq - prev - rec.flow;
  const unreal = total - rec.real;
  const which = rec.d === s.date ? '今天' : '上一個交易日';
  return `${head(`${which}收盤結算`)}
    <div class="sim-dayrep${fresh ? ' is-fresh' : ''}">
      <dl class="sim-stats sim-dayrep-main">
        <div><dt>當日損益</dt><dd class="num ${cls(total)}">${money(total)}</dd></div>
        <div><dt>已實現</dt><dd class="num ${cls(rec.real)}">${money(rec.real)}</dd></div>
        <div><dt>未實現（變動）</dt><dd class="num ${cls(unreal)}">${money(unreal)}</dd></div>
        <div><dt>當日報酬</dt><dd class="num ${cls(total)}">${pctOrDash(prev + rec.flow > 0 ? total / (prev + rec.flow) : null)}</dd></div>
      </dl>
      <p class="muted sim-note num">持有部位的未實現損益合計 <b class="${cls(rec.float)}">${money(rec.float)}</b>　手續費＋稅 ${money(rec.fee)}　成交 ${rec.n} 筆${rec.flow ? `　薪資入帳 ${money(rec.flow)}` : ''}</p>
      <p class="muted sim-note">未實現（變動）＝當日損益－已實現，包含持股漲跌、股利與利息；把之前帳上的獲利賣掉時，已實現會增加、未實現會等額減少。</p>
    </div>`;
}

export function equityHtml(s: SimState, ctx: SimCtx, w: number): string {
  const sum = summarize(s, ctx.market);
  const head = `<h2 class="panel-title">資產曲線 <small>每天收盤的報酬率；對照組＝同樣的錢都拿去買大盤</small></h2>
    <dl class="sim-stats">
      <div><dt>最大回檔</dt><dd class="num">${num(sum.maxDrawdown * 100, 1)}%</dd></div>
      <div><dt>已實現損益</dt><dd class="num ${cls(sum.realized)}">${money(sum.realized)}</dd></div>
      <div><dt>勝 / 敗</dt><dd class="num">${sum.wins} / ${sum.losses}</dd></div>
      <div><dt>手續費＋稅</dt><dd class="num">${money(sum.fees)}</dd></div>
    </dl>`;
  const pts = s.equity;
  if (pts.length < 2) return `${head}<p class="muted">收盤兩天以上就會畫出資產曲線。</p>`;
  const mine = pts.map(([d, v]) => v / investedAt(s, d) - 1);
  const bench = pts.map(([d]) => {
    const b = ctx.benchAt(s, d);
    return b == null ? null : b / investedAt(s, d) - 1;
  });
  return `${head}${returnChart([{ cls: 'sim-bench', values: bench }, { cls: 'sim-mine', values: mine }], w, 180)}
    <p class="sim-eq-legend"><span class="sim-mine-t">━ 我的帳戶</span>　<span class="sim-bench-t">━ 同額買大盤</span></p>`;
}

export function logHtml(s: SimState, ctx: SimCtx): string {
  const items = [
    ...s.trades.map((t) => ({
      k: t.day * 1000 + t.minute,
      when: `第 ${t.day} 天 ${clock(t.minute)}`,
      html: `<span class="${t.side === 'buy' ? 'up' : 'down'}">${actionName(t.kind, t.side)}</span> <b>${esc(t.code)}</b> ${esc(ctx.nameOf(t.code))}
        <span class="num">${num(t.shares)} 股 @ ${price(t.price)}</span>
        ${t.pnl != null ? `<span class="num ${cls(t.pnl)}">損益 ${money(t.pnl)}</span>` : ''}
        <small class="muted num">費 ${money(t.fee)}${t.tax ? `／稅 ${money(t.tax)}` : ''}</small>`,
    })),
    ...s.notes.map((n) => ({ k: n.day * 1000 + n.minute + 0.5, when: `第 ${n.day} 天 ${clock(n.minute)}`, html: `${n.code ? `<b>${esc(n.code)}</b> ${esc(ctx.nameOf(n.code))} ` : ''}<span class="muted">${esc(n.text)}</span>` })),
  ]
    .sort((a, b) => b.k - a.k)
    .slice(0, 80);
  return `<h2 class="panel-title">交易紀錄</h2>
    ${items.length ? `<ol class="sim-logs">${items.map((i) => `<li><time class="num muted">${i.when}</time> ${i.html}</li>`).join('')}</ol>` : '<p class="muted">還沒有交易。</p>'}`;
}

/** 觀看中股票的部位：停損／停利設定。 */
export function stopHtml(s: SimState): string {
  const mine = s.pos.filter((p) => p.code === s.watch);
  if (!mine.length) return '';
  const rows = mine
    .map((p) => {
      const st = stopOf(s, p);
      const label = `${KIND_NAME[p.kind]}${p.dir === 'short' ? (p.kind === 'short' ? '' : '空') : ''} ${num(p.shares)} 股`;
      const long = p.dir === 'long';
      return `<form class="sim-stop" data-kind="${p.kind}" data-dir="${p.dir}">
        <span class="sim-stop-label">${esc(label)}</span>
        <label>停損<input type="number" name="loss" step="0.01" min="0" value="${st?.loss ?? ''}" placeholder="${long ? '跌到' : '漲到'}" /></label>
        <label>停利<input type="number" name="profit" step="0.01" min="0" value="${st?.profit ?? ''}" placeholder="${long ? '漲到' : '跌到'}" /></label>
        <button type="submit" class="btn btn-sm">${st ? '更新' : '設定'}</button>
        ${st ? '<button type="button" class="btn btn-sm" data-sim="stop-clear">取消</button>' : ''}
      </form>`;
    })
    .join('');
  return `<h3 class="sim-sub">停損／停利 <small class="muted">長效，價格碰到就以市價了結整個部位</small></h3>${rows}`;
}

/** 資金面板：薪資投入、信用貸款、股票質押。 */
export function bankHtml(s: SimState, ctx: SimCtx, msg: string): string {
  const m = ctx.market;
  const monthly = s.settings.monthly ?? 0;
  const used = s.loans.reduce((a, l) => a + l.balance, 0);
  const loans = s.loans
    .map(
      (l) => `<li><div class="num">本金餘額 <b>${money(l.balance)}</b>　月付 ${money(l.payment)}　剩 ${l.left} 期</div>
        <form class="sim-inline" data-form="loan-repay" data-id="${l.id}"><input type="number" name="amount" min="1" step="1000" placeholder="提前還款金額" aria-label="提前還款金額" />
        <button type="submit" class="btn btn-sm">還款</button><button type="button" class="btn btn-sm" data-sim="loan-payoff" data-id="${l.id}" ${s.cash < l.balance ? 'disabled title="現金不夠一次還清"' : ''}>全部還清</button></form></li>`,
    )
    .join('');
  const ratio = pledgeRatio(s, m);
  const pledges = s.pledges
    .map((p) => {
      const debt = p.loan + p.interest;
      return `<li><div><b>${esc(p.code)}</b> ${esc(ctx.nameOf(p.code))} <span class="num">質押 ${num(p.shares)} 股　借款 ${money(debt)}</span></div>
        <form class="sim-inline" data-form="pledge-repay" data-code="${esc(p.code)}"><input type="number" name="amount" min="1" step="1000" placeholder="還款金額" aria-label="質押還款金額" />
        <button type="submit" class="btn btn-sm">還款</button></form>
        <form class="sim-inline" data-form="pledge-release" data-code="${esc(p.code)}"><input type="number" name="shares" min="1" step="1000" placeholder="解除股數" aria-label="解除質押股數" />
        <button type="submit" class="btn btn-sm">解除質押</button></form></li>`;
    })
    .join('');
  const cashPos = s.pos.filter((p) => p.kind === 'cash' && p.dir === 'long');
  const options = cashPos
    .map((p) => {
      const free = p.shares - pledgedShares(s, p.code);
      const px = priceNow(s, m, p.code) ?? 0;
      return `<option value="${esc(p.code)}"${p.code === s.watch ? ' selected' : ''}>${esc(p.code)} ${esc(ctx.nameOf(p.code))}（可質押 ${num(free)} 股，市值 ${money(free * px)}）</option>`;
    })
    .join('');
  return `<h2 class="panel-title">資金 <small>薪資、信貸、質押</small></h2>
    <dl class="sim-stats">
      <div><dt>現金</dt><dd class="num">${money(s.cash)}</dd></div>
      <div><dt>累計投入</dt><dd class="num">${money(investedOf(s))}</dd></div>
      <div><dt>每月薪資投入</dt><dd class="num">${monthly ? money(monthly) : '不投入'}</dd></div>
      <div><dt>負債合計</dt><dd class="num">${money(debtOf(s))}</dd></div>
      <div><dt>質押維持率</dt><dd class="num ${ratio != null && ratio < PLEDGE_CALL ? 'down' : ''}">${ratio == null ? '—' : `${Math.round(ratio * 100)}%`}</dd></div>
    </dl>
    <p class="sim-msg" role="status">${esc(msg)}</p>
    <h3 class="sim-sub">定期定額 <small class="muted">每月第一個交易日（薪資入帳後）以開盤價買進，可以買零股</small></h3>
    ${
      s.dca.length
        ? `<ul class="sim-bank-list">${s.dca
            .map(
              (p) => `<li class="sim-dca-row"><span><b>${esc(p.code)}</b> ${esc(ctx.nameOf(p.code))}　<span class="num">每月 ${money(p.amount)} 元</span></span>
                <button type="button" class="btn btn-sm" data-sim="dca-off" data-code="${esc(p.code)}">取消</button></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <form class="sim-inline" data-form="dca">
      <input type="hidden" name="code" value="${esc(s.watch)}" />
      <span class="sim-dca-target">每月買進 <b>${esc(s.watch)}</b> ${esc(ctx.nameOf(s.watch))}</span>
      <input type="number" name="amount" min="1000" step="1000" placeholder="每月金額" aria-label="定期定額每月金額" required />
      <button type="submit" class="btn btn-sm">${s.dca.some((p) => p.code === s.watch) ? '更新' : '設定'}</button>
    </form>
    <h3 class="sim-sub">信用貸款 <small class="muted">額度 ${money(LOAN_LIMIT)}，已用 ${money(used)}；年利率 ${(LOAN_RATE * 100).toFixed(1)}%，本息平均攤還，每月第一個交易日扣款</small></h3>
    ${loans ? `<ul class="sim-bank-list">${loans}</ul>` : ''}
    <form class="sim-inline" data-form="loan">
      <input type="number" name="amount" min="10000" step="10000" placeholder="借款金額" aria-label="借款金額" required />
      <select name="months" aria-label="期數">${LOAN_TERMS.map((t) => `<option value="${t}"${t === 36 ? ' selected' : ''}>${t} 期</option>`).join('')}</select>
      <button type="submit" class="btn btn-sm">申請信貸</button>
    </form>
    <h3 class="sim-sub">股票質押 <small class="muted">現股最多借市值 ${PLEDGE_LTV * 100}%，年利率 ${(PLEDGE_RATE * 100).toFixed(1)}%；質押中的股票不能賣，維持率低於 120% 會被強制賣出</small></h3>
    ${pledges ? `<ul class="sim-bank-list">${pledges}</ul>` : ''}
    ${
      options
        ? `<form class="sim-inline sim-pledge-form" data-form="pledge">
            <select name="code" aria-label="質押股票">${options}</select>
            <input type="number" name="shares" min="0" step="1000" placeholder="增加質押股數" aria-label="質押股數" />
            <input type="number" name="amount" min="0" step="1000" placeholder="借款金額" aria-label="借款金額" />
            <button type="submit" class="btn btn-sm">質押借款</button>
          </form>`
        : '<p class="muted">有現股部位才能質押。</p>'
    }`;
}
