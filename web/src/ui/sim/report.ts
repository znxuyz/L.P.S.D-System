/** 結束報告：一局結束時揭曉真實日期，並用圖表回顧這一局。 */
import { investedOf, summarize, type Market, type SimState } from '../../domain/sim';
import type { SimRecord } from '../../data/simAccount';
import { escapeHtml as esc, num } from '../format';
import { drawdownChart, pnlBars, returnChart } from './charts';
import { cls, investedAt, money, pctOrDash, weekday, type SimCtx } from './util';

/** 把目前這一局整理成歷史紀錄（含完整明細）。 */
export function recordOf(s: SimState, ctx: SimCtx): SimRecord {
  const last = s.equity[s.equity.length - 1];
  const invested = investedOf(s);
  const bench = s.equity.map(([d]) => ctx.benchAt(s, d));
  const b = bench[bench.length - 1];
  return {
    start: s.settings.start,
    end: last[0],
    days: s.equity.length,
    capital: s.settings.capital,
    equity: last[1],
    bench: b != null ? b / invested - 1 : null,
    trades: s.trades.length,
    endedAt: new Date().toISOString(),
    invested,
    detail: { equity: s.equity, days: s.days, trades: s.trades, flows: s.flows, bench },
  };
}

/** 扣掉投入資金後的「時間加權」報酬指數（從 1 開始），用來算回檔。 */
function twr(equity: Array<[string, number]>, flows: Array<[string, number]>, capital: number): number[] {
  const flowOn = new Map<string, number>();
  for (const [d, v] of flows) flowOn.set(d, (flowOn.get(d) ?? 0) + v);
  const out: number[] = [];
  let idx = 1;
  let prev = capital;
  for (const [d, v] of equity) {
    const f = flowOn.get(d) ?? 0;
    if (prev + f > 0) idx *= v / (prev + f);
    out.push(idx);
    prev = v;
  }
  return out;
}

export function reportHtml(r: SimRecord, w: number, back: string, who = ''): string {
  const invested = r.invested ?? r.capital;
  const ret = r.equity / invested - 1;
  const excess = r.bench == null ? null : ret - r.bench;
  const det = r.detail;
  const head = `<p class="eyebrow">Laplace Replay · 結束報告${who ? ` · ${esc(who)}` : ''}</p>
    <h2 class="sim-title">這一局揭曉</h2>
    <p class="sim-reveal num">${esc(r.start)}（${weekday(r.start)}）<span class="muted">→</span> ${esc(r.end)}（${weekday(r.end)}）<small class="muted">共 ${r.days} 個交易日</small></p>
    ${excess != null ? `<p class="sim-verdict ${cls(excess)}">${excess >= 0 ? `贏過大盤 ${num(excess * 100, 2)} 個百分點` : `落後大盤 ${num(-excess * 100, 2)} 個百分點`}</p>` : ''}`;
  let stats = `<dl class="sim-kpis sim-report-kpis">
      <div><dt>最終資產</dt><dd class="num">${money(r.equity)}</dd></div>
      <div><dt>累計投入</dt><dd class="num">${money(invested)}</dd></div>
      <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pctOrDash(ret)}</dd></div>
      <div><dt>同額買大盤</dt><dd class="num ${r.bench == null ? 'muted' : cls(r.bench)}">${pctOrDash(r.bench)}</dd></div>
      <div><dt>成交筆數</dt><dd class="num">${r.trades}</dd></div>`;
  if (!det || det.equity.length < 1) {
    return `${head}${stats}</dl><p class="muted">這一局沒有保留明細（完整明細只保留最近 10 局）。</p><p class="sim-lobby-foot">${back}</p>`;
  }
  const dates = det.equity.map(([d]) => d);
  const idx = twr(det.equity, det.flows, r.capital);
  let peak = 1;
  const dd = idx.map((v) => {
    peak = Math.max(peak, v);
    return v / peak - 1;
  });
  const closes = det.trades.filter((t) => t.pnl != null);
  const wins = closes.filter((t) => (t.pnl ?? 0) > 0).length;
  const fees = det.trades.reduce((a, t) => a + t.fee + t.tax, 0);
  stats += `<div><dt>最大回檔</dt><dd class="num">${num(-Math.min(0, ...dd) * 100, 1)}%</dd></div>
      <div><dt>勝率</dt><dd class="num">${closes.length ? `${Math.round((wins / closes.length) * 100)}%` : '—'} <small class="muted">${wins} 勝 ${closes.length - wins} 敗</small></dd></div>
      <div><dt>手續費＋稅</dt><dd class="num">${money(fees)}</dd></div></dl>`;
  const fakeState = { settings: { capital: r.capital }, flows: det.flows } as Pick<SimState, 'settings' | 'flows'>;
  const mine = det.equity.map(([d, v]) => v / investedAt(fakeState, d) - 1);
  const bench = det.equity.map(([d], i) => (det.bench[i] == null ? null : det.bench[i]! / investedAt(fakeState, d) - 1));
  // 每日損益：有每日結算就用，沒有（舊存檔）就只用資產變化
  const recOn = new Map(det.days.map((x) => [x.d, x]));
  const realOn = new Map<string, number>();
  for (const t of closes) realOn.set(t.date, (realOn.get(t.date) ?? 0) + (t.pnl ?? 0));
  const flowOn = new Map<string, number>();
  for (const [d, v] of det.flows) flowOn.set(d, (flowOn.get(d) ?? 0) + v);
  const real: number[] = [];
  const unreal: number[] = [];
  det.equity.forEach(([d, v], i) => {
    const prev = i ? det.equity[i - 1][1] : r.capital;
    const total = v - prev - (flowOn.get(d) ?? 0);
    const re = recOn.get(d)?.real ?? realOn.get(d) ?? 0;
    real.push(re);
    unreal.push(total - re);
  });
  // 各股票的已實現損益
  const byCode = new Map<string, { pnl: number; n: number }>();
  for (const t of closes) {
    const x = byCode.get(t.code) ?? { pnl: 0, n: 0 };
    x.pnl += t.pnl ?? 0;
    x.n += 1;
    byCode.set(t.code, x);
  }
  const ranked = [...byCode.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  const row = ([code, x]: [string, { pnl: number; n: number }]) => `<tr><td><b>${esc(code)}</b></td><td class="num ${cls(x.pnl)}">${money(x.pnl)}</td><td class="num">${x.n}</td></tr>`;
  const best = ranked.filter(([, x]) => x.pnl > 0).slice(0, 5).map(row).join('');
  const worst = ranked.filter(([, x]) => x.pnl < 0).reverse().slice(0, 5).map(row).join('');
  const table = (title: string, rows: string) =>
    `<div><h3 class="sim-sub">${title}</h3>${rows ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>已實現損益</th><th>了結次數</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">沒有。</p>'}</div>`;
  const totalReal = real.reduce((a, b) => a + b, 0);
  return `${head}${stats}
    <section class="sim-report-sec"><h3 class="sim-sub">報酬率走勢 <small class="muted">對照組＝同樣的錢都在同一天買進加權指數</small></h3>
      ${returnChart([{ cls: 'sim-bench', values: bench }, { cls: 'sim-mine', values: mine }], w, 220, dates)}
      <p class="sim-eq-legend"><span class="sim-mine-t">━ 我的帳戶</span>　<span class="sim-bench-t">━ 同額買大盤</span></p></section>
    <section class="sim-report-sec"><h3 class="sim-sub">每日損益 <small class="muted">已實現合計 <b class="${cls(totalReal)}">${money(totalReal)}</b></small></h3>
      ${pnlBars(real, unreal, w, 180, dates)}
      <p class="sim-eq-legend"><span class="sim-bar-real-t">■ 已實現</span>　<span class="sim-bar-unreal-t">■ 未實現（變動）</span></p></section>
    <section class="sim-report-sec"><h3 class="sim-sub">回檔 <small class="muted">扣掉薪資投入後，從前高跌了多少</small></h3>${drawdownChart(dd, w, 130, dates)}</section>
    <div class="sim-report-grid">${table('賺最多的股票', best)}${table('賠最多的股票', worst)}</div>
    <p class="sim-lobby-foot">${back}</p>`;
}

/** 目前這一局的簡短評語（玩到最新資料時顯示）。 */
export function verdict(s: SimState, m: Market, bench: number | null): string {
  const sum = summarize(s, m);
  const vs = bench == null ? '' : sum.ret > bench ? `，贏過大盤 ${num((sum.ret - bench) * 100, 2)} 個百分點` : `，落後大盤 ${num((bench - sum.ret) * 100, 2)} 個百分點`;
  return `${sum.days} 個交易日報酬 ${pctOrDash(sum.ret)}${vs}；最大回檔 ${num(sum.maxDrawdown * 100, 1)}%，了結 ${sum.wins + sum.losses} 次、賺 ${sum.wins} 次，手續費＋稅 ${money(sum.fees)} 元。`;
}
