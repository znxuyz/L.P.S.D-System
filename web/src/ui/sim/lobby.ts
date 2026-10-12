/** 登入、大廳（含朋友排行榜）、開新局的畫面。 */
import { clock } from '../../domain/intraday';
import { SALARY, investedOf, type SimState } from '../../domain/sim';
import { WINDOW_NAME, type Window } from '../../domain/simRank';
import type { BoardEntry } from '../../data/simBoard';
import type { CodeEntry, SimSave } from '../../data/simAccount';
import { escapeHtml as esc } from '../format';
import { cls, garble, money, pctOrDash, weekday } from './util';

export const WARMUP = 60;

export function gateHtml(loaded: boolean, msg: string, synced: boolean): string {
  if (!loaded) return `<p class="muted">載入中⋯⋯</p>`;
  return `
    <p class="eyebrow">Laplace Replay</p>
    <h2 class="sim-title">拉普拉斯模擬盤</h2>
    <p class="sim-lead">請輸入開通碼。每個開通碼有自己的模擬帳戶與紀錄，下次用同一個開通碼就能接著玩。</p>
    <form class="sim-form sim-gate" id="sim-gate-form" autocomplete="off">
      <label>開通碼<input type="text" name="code" id="sim-code" placeholder="LPLC-XXXX-XXXX-…（共 40 碼）" spellcheck="false" autocapitalize="characters" required /></label>
      <button type="submit" class="btn btn-accent">開通</button>
    </form>
    <p class="sim-msg" role="alert">${esc(msg)}</p>
    <p class="muted sim-note">${synced ? '紀錄會同步到雲端：換手機或電腦，用同一個開通碼登入就能接著玩。' : '紀錄存在這台裝置的瀏覽器；換手機、電腦或清除瀏覽器資料後不會跟著過去。'}</p>`;
}

export interface BoardRow {
  label: string;
  self: boolean;
  entry: BoardEntry | null | 'error' | undefined;
}

const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m} 分鐘前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 60 / 24)} 天前`;
};

/** 朋友排行榜。 */
export function boardHtml(rows: BoardRow[] | null, tab: Window, loading: boolean): string {
  const tabs = (Object.keys(WINDOW_NAME) as Window[]).map((k) => `<button type="button" data-sim="board-${k}" aria-pressed="${tab === k}">${WINDOW_NAME[k]}</button>`).join('');
  const head = `<div class="sim-card sim-board"><p class="eyebrow">朋友排行榜</p>
    <div class="seg sim-board-tabs" role="group" aria-label="排行區間">${tabs}</div>`;
  const foot = `<p class="muted sim-note">每個人玩的年代與速度不同，所以「日／週／月」是各自最近 1／5／20 個<b>模擬交易日</b>，
    名次依<b>超額報酬</b>（自己的報酬－同一段期間大盤的報酬）排序；天數不夠的不列入名次。收盤後自動更新。</p></div>`;
  if (!rows) return `${head}<p class="muted">${loading ? '讀取中⋯⋯' : '還沒有設定雲端同步，看不到排行榜。'}</p>${foot}`;
  const ranked = rows
    .map((r) => {
      const e = r.entry && r.entry !== 'error' ? r.entry : null;
      return { ...r, e, x: e?.stats.x[tab] ?? null, ret: e?.stats.r[tab] ?? null };
    })
    .sort((a, b) => (b.x ?? -Infinity) - (a.x ?? -Infinity) || (b.ret ?? -Infinity) - (a.ret ?? -Infinity));
  let rank = 0;
  const body = ranked
    .map((r) => {
      const has = r.x != null || r.ret != null;
      if (has) rank += 1;
      const status = r.entry === undefined ? (loading ? '讀取中' : '—') : r.entry === 'error' ? '讀取失敗' : !r.e ? '還沒有成績' : !has ? '天數不足' : '';
      return `<tr class="${r.self ? 'is-me' : ''}">
        <td class="num">${has ? rank : '—'}</td>
        <td><b>${esc(r.label)}</b>${r.self ? ' <small class="muted">（我）</small>' : ''}${r.e?.stats.bankrupt ? ' <span class="sim-ruin-tag is-sm">💥 破產</span>' : ''}</td>
        ${status ? `<td colspan="4" class="muted">${status}</td>` : `<td class="num ${cls(r.x ?? 0)}">${pctOrDash(r.x)}</td><td class="num ${cls(r.ret ?? 0)}">${pctOrDash(r.ret)}</td><td class="num">${r.e!.stats.days}</td><td class="num muted">${ago(r.e!.updatedAt)}</td>`}
      </tr>`;
    })
    .join('');
  return `${head}<div class="sim-table-wrap"><table class="sim-table sim-board-table"><thead><tr><th>#</th><th>玩家</th><th>超額報酬</th><th>報酬率</th><th>已玩天數</th><th>更新</th></tr></thead><tbody>${body}</tbody></table></div>${foot}`;
}

export function lobbyHtml(o: { user: CodeEntry; state: SimState | null; save: SimSave; note: string; players: number; board: string; syncBadge: string }): string {
  const s = o.state;
  let resume = `<div class="sim-card sim-card-empty"><p class="muted">目前沒有進行中的模擬。</p></div>`;
  if (s) {
    const eq = s.equity.at(-1)?.[1] ?? s.settings.capital;
    const ret = eq / investedOf(s) - 1;
    resume = `<div class="sim-card">
        <p class="eyebrow">接續上次${s.bankrupt ? ' <span class="sim-ruin-tag is-sm">💥 破產</span>' : ''}</p>
        <p class="sim-card-date num">第 ${s.day} 天・星期${weekday(s.date)} ${clock(s.minute)}</p>
        <p class="muted num">${garble(s.date)}</p>
        <p class="num">總資產 ${money(eq)}　<span class="${cls(ret)}">${pctOrDash(ret)}</span></p>
        <button type="button" class="btn btn-accent btn-block" data-sim="resume">接續上次的模擬 ▸</button>
      </div>`;
  }
  const hist = o.save.history
    .map((r, i) => {
      const ret = r.equity / (r.invested ?? r.capital) - 1;
      return `<tr${r.detail ? ` data-sim="report" data-i="${i}" tabindex="0" class="is-link"` : ''}>
        <td class="num">${esc(r.start)} → ${esc(r.end)}<br /><small class="muted">${r.days} 個交易日</small>${r.bankrupt ? ' <span class="sim-ruin-tag is-sm">💥 破產</span>' : ''}</td>
        <td class="num">${money(r.invested ?? r.capital)}</td><td class="num ${cls(ret)}">${pctOrDash(ret)}</td>
        <td class="num ${r.bench == null ? 'muted' : cls(r.bench)}">${pctOrDash(r.bench)}</td><td class="num">${r.trades}</td>
        <td>${r.detail ? '<span class="sim-link">報告 ▸</span>' : '<span class="muted">—</span>'}</td></tr>`;
    })
    .join('');
  return `
    <p class="eyebrow">Laplace Replay</p>
    <h2 class="sim-title">歡迎，${esc(o.user.label)}${o.user.admin ? '<span class="sim-admin-tag">管理員</span>' : ''}</h2>
    ${o.note ? `<p class="sim-msg" role="status">${esc(o.note)}</p>` : ''}
    <div class="sim-lobby">
      ${resume}
      <div class="sim-card">
        <p class="eyebrow">開新的模擬</p>
        <p class="muted">選一個起始日期（或隨機）、本金與每月薪資投入重新開始。${s ? '目前這局會結束並存進下面的歷史紀錄。' : ''}</p>
        <button type="button" class="btn btn-block" data-sim="new">開新的模擬</button>
      </div>
    </div>
    ${o.board}
    ${
      o.user.admin
        ? `<div class="sim-card sim-card-admin"><p class="eyebrow">管理員</p><p class="muted">查看所有玩家的持股、交易紀錄與練習紀錄（唯讀）。</p>
            <button type="button" class="btn btn-block" data-sim="admin">查看玩家紀錄（${o.players} 位）</button></div>`
        : ''
    }
    <h3 class="sim-sub">歷史紀錄 <small class="muted">結束後揭曉日期；每局摘要都會保留，完整報告保留最近 10 局</small></h3>
    ${hist ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>期間</th><th>累計投入</th><th>報酬</th><th>同額買大盤</th><th>成交筆數</th><th></th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="muted">還沒有完成的模擬。</p>'}
    <p class="sim-lobby-foot">${o.syncBadge}<a class="btn btn-sm" href="#learn" title="K 棒、K 線圖、均線等基本知識">📘 股市入門</a><button type="button" class="btn btn-sm" data-sim="logout">換開通碼／登出</button></p>`;
}

export function setupHtml(cal: string[] | null | undefined): string {
  if (cal === undefined) return `<p class="muted">正在下載交易日曆⋯⋯</p>`;
  if (!cal?.length) return `<p>還沒有歷史日 K 資料，暫時不能開始模擬盤。</p>`;
  const min = cal[Math.min(WARMUP, cal.length - 1)];
  const max = cal[Math.max(0, cal.length - 21)];
  const def = cal[Math.max(WARMUP, cal.length - 250)];
  return `
    <p class="eyebrow">Laplace Replay</p>
    <h2 class="sim-title">拉普拉斯模擬盤</h2>
    <p class="sim-lead">回到過去的某一天，用模擬帳戶在盤中行情裡交易。時間會自己往前走（現實 1 秒＝盤中 1 分鐘），
      你只看得到「現在」為止的走勢；進入之後畫面上不會出現年月日，只有星期幾和時間 —— 不靠記憶，你能贏過大盤嗎？</p>
    <form class="sim-form" id="sim-setup-form">
      <label>本金（元）<input type="number" name="capital" min="10000" step="10000" value="1000000" /></label>
      <label>每月薪資投入（元）<input type="number" name="monthly" min="0" step="1000" value="${SALARY}" /></label>
      <label>手續費折扣<input type="number" name="discount" min="0.1" max="1" step="0.01" value="0.6" /></label>
      <label>破產條件<select name="ruin">
        <option value="1" selected>總資產歸零就破產</option>
        <option value="0.8">虧掉投入的 80% 就破產</option>
        <option value="0.5">虧掉投入的 50% 就破產（嚴格）</option>
        <option value="0">不會破產</option>
      </select></label>
      <button type="button" class="btn btn-accent" data-sim="random-start" title="從值得練習的行情（崩跌、狂潮、空頭等）或至少一年前的任一天隨機抽，結束才揭曉">🎲 隨機日期開始</button>
      <label>或指定起始日期<input type="date" name="start" id="sim-start" min="${min}" max="${max}" value="${def}" /></label>
      <button type="submit" class="btn">從指定日期開始</button>
      <button type="button" class="btn" data-sim="lobby">返回</button>
    </form>
    <ul class="sim-rules">
      <li>每天先停在 08:30 盤前，可以先掛單；按「🔔 開盤」以開盤價集合競價撮合，接著 09:00～13:30 盤中。可選 1×／3×／5× 速度，可以暫停（暫停時不能交易）或直接跳到隔天，不能倒帶。</li>
      <li><b>盤中走勢是模擬的</b>：每天的開、高、低、收是真實資料，中間每分鐘的跳動是依這四個價格推算出來的，不是當天真正的走勢。</li>
      <li>市價單立刻以當下價格成交；限價單在價格碰到時成交，收盤前沒成交就取消。停損／停利單長效有效，碰到就以市價了結。</li>
      <li>交易類別：現股、現股當沖（證交稅減半，收盤未沖銷自動沖銷）、融資（自備 40%，年息 6.5%）、融券（保證金 90%，借券費 0.08%）；
        整戶維持率低於 130% 提醒、低於 120% 收盤強制了結。</li>
      <li>資金：每月第一個交易日薪資入帳；信用貸款（額度 100 萬、年利率 3.5%、本息平均攤還）；股票質押（現股最多借六成、年利率 2.5%）。
        報酬率＝總資產 ÷ 累計投入（本金＋薪資）－ 1，貸款算負債。</li>
      <li><b>破產</b>：每天收盤檢查，總資產跌到破產條件以下時，所有部位以收盤價強制了結並償還借款，這一局直接結束（可以在上面選條件）。</li>
      <li>手續費 0.1425% × 折扣（整股最低 20 元、零股 1 元），賣出證交稅 0.3%（ETF 0.1%）；一價鎖漲停買不到、鎖跌停賣不掉；除權息自動處理。</li>
    </ul>`;
}
