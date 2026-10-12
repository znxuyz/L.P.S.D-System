/** 管理員（玩家 0）：查看所有玩家的雲端存檔（唯讀，看得到真實日期）。 */
import { clock } from '../../domain/intraday';
import { KIND_NAME, debtOf, investedOf } from '../../domain/sim';
import type { PlayerRef, SimSave } from '../../data/simAccount';
import { escapeHtml as esc, num, price } from '../format';
import { actionName, cls, money, pctOrDash, type SimCtx } from './util';

export type PlayerSave = SimSave | null | 'error';

export function adminHtml(ctx: SimCtx, o: { synced: boolean; players: PlayerRef[] | null; saves: Map<string, PlayerSave>; loading: boolean }): string {
  const back = `<button type="button" class="btn btn-sm" data-sim="lobby">← 回大廳</button>`;
  const head = `<p class="eyebrow">Laplace Replay · 管理員</p><h2 class="sim-title">玩家紀錄</h2>`;
  if (!o.synced) return `${head}<p>還沒有設定雲端同步，看不到其他玩家的紀錄。</p>${back}`;
  if (!o.players?.length) return `${head}<p>沒有可以查看的玩家（請重新輸入管理員開通碼登入一次）。</p>${back}`;
  const rows = o.players
    .map((p) => {
      const sv = o.saves.get(p.sync);
      if (sv === undefined) return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">${o.loading ? '讀取中⋯⋯' : '—'}</td></tr>`;
      if (sv === 'error') return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">讀取失敗</td></tr>`;
      if (!sv || (!sv.current && !sv.history.length)) return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">還沒有玩過</td></tr>`;
      const c = sv.current;
      const eq = c ? c.equity.at(-1)?.[1] ?? c.settings.capital : null;
      const ret = c && eq != null ? eq / investedOf(c) - 1 : null;
      const bench = c ? ctx.benchOf(c) : null;
      const updated = sv.updatedAt ? new Date(sv.updatedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      return `<tr data-sim="pick" data-sync="${esc(p.sync)}" tabindex="0">
        <td><b>${esc(p.label)}</b>${c?.bankrupt ? ' <span class="sim-ruin-tag is-sm">💥 破產</span>' : ''}</td>
        <td class="num">${c ? `${esc(c.settings.start)} → ${esc(c.date)} ${clock(c.minute)}<br /><small class="muted">第 ${c.day} 天</small>` : '<span class="muted">沒有進行中</span>'}</td>
        <td class="num">${eq != null ? money(eq) : '—'}</td>
        <td class="num ${ret == null ? '' : cls(ret)}">${pctOrDash(ret)}</td>
        <td class="num ${bench == null ? 'muted' : cls(bench)}">${pctOrDash(bench)}</td>
        <td class="num">${c?.trades.length ?? 0} 筆／${sv.history.length} 局</td>
        <td class="num muted">${esc(updated)}</td></tr>`;
    })
    .join('');
  return `${head}
    <p class="sim-lead">所有玩家的雲端存檔（唯讀，管理員看得到真實日期）。點一位玩家可以看他的部位、每一筆交易與過去每一局的成績。</p>
    <div class="sim-table-wrap"><table class="sim-table sim-admin-table"><thead><tr><th>玩家</th><th>進行中的模擬</th><th>總資產</th><th>報酬</th><th>同額買大盤</th><th>交易／完成</th><th>最後更新</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="sim-lobby-foot">${back}<button type="button" class="btn btn-sm" data-sim="admin-refresh" ${o.loading ? 'disabled' : ''}>重新讀取</button></p>`;
}

export function playerDetailHtml(ctx: SimCtx, p: PlayerRef, sv: PlayerSave | undefined): string {
  const back = `<button type="button" class="btn btn-sm" data-sim="admin">← 所有玩家</button>`;
  if (!sv || sv === 'error') return `<h2 class="sim-title">${esc(p.label)}</h2><p class="muted">沒有資料。</p>${back}`;
  const c = sv.current;
  let current = '<p class="muted">目前沒有進行中的模擬。</p>';
  if (c) {
    const eq = c.equity.at(-1)?.[1] ?? c.settings.capital;
    const ret = eq / investedOf(c) - 1;
    const bench = ctx.benchOf(c);
    const holds = c.pos
      .map((h) => `<tr><td><b>${esc(h.code)}</b> ${esc(ctx.nameOf(h.code))}</td><td>${KIND_NAME[h.kind]}${h.dir === 'short' && h.kind === 'day' ? '空' : ''}</td><td class="num">${num(h.shares)}</td><td class="num">${price(h.cost / h.shares)}</td><td class="num">${money(h.cost)}</td></tr>`)
      .join('');
    const log = [
      ...c.trades.map((t) => ({
        k: t.day * 1000 + t.minute,
        when: `${t.date} ${clock(t.minute)}`,
        html: `<span class="${t.side === 'buy' ? 'up' : 'down'}">${actionName(t.kind, t.side)}</span> <b>${esc(t.code)}</b> ${esc(ctx.nameOf(t.code))}
          <span class="num">${num(t.shares)} 股 @ ${price(t.price)}</span>${t.pnl != null ? ` <span class="num ${cls(t.pnl)}">損益 ${money(t.pnl)}</span>` : ''}`,
      })),
      ...c.notes.map((n) => ({ k: n.day * 1000 + n.minute + 0.5, when: `${n.date} ${clock(n.minute)}`, html: `${n.code ? `<b>${esc(n.code)}</b> ${esc(ctx.nameOf(n.code))} ` : ''}<span class="muted">${esc(n.text)}</span>` })),
    ].sort((a, b) => b.k - a.k);
    const pending = c.orders.map((o) => `<li>${actionName(o.kind, o.side)} <b>${esc(o.code)}</b> ${num(o.shares)} 股 限價 ${o.limit}</li>`).join('');
    current = `
      <dl class="sim-kpis">
        <div><dt>期間</dt><dd class="num">${esc(c.settings.start)} → ${esc(c.date)}</dd></div>
        <div><dt>總資產（上次收盤）</dt><dd class="num">${money(eq)}</dd></div>
        <div><dt>累計投入</dt><dd class="num">${money(investedOf(c))}</dd></div>
        <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pctOrDash(ret)}</dd></div>
        <div><dt>同額買大盤</dt><dd class="num ${bench == null ? 'muted' : cls(bench)}">${pctOrDash(bench)}</dd></div>
        <div><dt>現金</dt><dd class="num">${money(c.cash)}</dd></div>
        <div><dt>負債</dt><dd class="num">${money(debtOf(c))}</dd></div>
      </dl>
      <h3 class="sim-sub">部位</h3>
      ${holds ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>類別</th><th>股數</th><th>成本均價</th><th>成本合計</th></tr></thead><tbody>${holds}</tbody></table></div>` : '<p class="muted">沒有部位。</p>'}
      ${pending ? `<h3 class="sim-sub">委託中</h3><ul class="sim-orders">${pending}</ul>` : ''}
      <h3 class="sim-sub">交易紀錄（${c.trades.length} 筆）</h3>
      ${log.length ? `<ol class="sim-logs sim-admin-log">${log.map((i) => `<li><time class="num muted">${esc(i.when)}</time> ${i.html}</li>`).join('')}</ol>` : '<p class="muted">還沒有交易。</p>'}`;
  }
  const hist = sv.history
    .map((r, i) => {
      const ret = r.equity / (r.invested ?? r.capital) - 1;
      return `<tr${r.detail ? ` data-sim="report" data-i="${i}" data-sync="${esc(p.sync)}" tabindex="0" class="is-link"` : ''}><td class="num">${esc(r.start)} → ${esc(r.end)}${r.bankrupt ? ' <span class="sim-ruin-tag is-sm">💥 破產</span>' : ''}</td><td class="num">${r.days}</td><td class="num">${money(r.invested ?? r.capital)}</td><td class="num ${cls(ret)}">${pctOrDash(ret)}</td>
        <td class="num ${r.bench == null ? 'muted' : cls(r.bench)}">${pctOrDash(r.bench)}</td><td class="num">${r.trades}</td><td>${r.detail ? '<span class="sim-link">報告 ▸</span>' : ''}</td></tr>`;
    })
    .join('');
  return `<p class="eyebrow">Laplace Replay · 管理員</p><h2 class="sim-title">${esc(p.label)}</h2>
    <h3 class="sim-sub">進行中的模擬</h3>${current}
    <h3 class="sim-sub">練習紀錄（完成 ${sv.history.length} 局）</h3>
    ${hist ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>期間</th><th>交易日</th><th>累計投入</th><th>報酬</th><th>同額買大盤</th><th>成交筆數</th><th></th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="muted">還沒有完成的模擬。</p>'}
    <p class="sim-lobby-foot">${back}</p>`;
}
