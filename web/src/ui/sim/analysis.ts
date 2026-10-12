/**
 * 模擬盤的「分析」分頁：基本面與技術分析。
 *
 * - 只用模擬當天以前看得到的資料：財報要過了申報期限才出現，本益比等用昨收計算，法人買賣超到昨天為止。
 * - 不顯示任何年份或日期（季別寫「最新一季、前 1 季…」），避免猜出是哪一年。
 */
import type { ChipSeries } from '../../data/chipSeries';
import type { FundQuarter, SimFund } from '../../data/simData';
import { analyzeTechnicals, type Candle, type Tilt } from '../../domain/technicals';
import { escapeHtml as esc, num } from '../format';
import { cls } from './util';

const TILT: Record<Tilt, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };
const f2 = (v: number) => num(v, 2);
const pctTxt = (v: number | null, digits = 1) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const x = Number((v * 100).toFixed(digits));
  return x === 0 ? `${num(0, digits)}%` : `${x > 0 ? '+' : ''}${num(x, digits)}%`;
};
const ratioTxt = (v: number | null, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${num(v * 100, digits)}%`);
/** 千元 → 億 */
const yi = (v: number | null) => (v == null ? '—' : num(v / 1e5, v / 1e5 >= 100 ? 0 : 1));
const growth = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : (a - b) / Math.abs(b));

export function fundHtml(opts: { code: string; etf: boolean; fund: SimFund | null | undefined; date: string; prevClose: number | null }): string {
  const head = '<h2 class="panel-title">基本面 <small>只看得到當時已公布的資料</small></h2>';
  if (opts.etf) return `${head}<p class="muted">ETF 沒有財報；可以看技術分析與成分股的表現。</p>`;
  if (opts.fund === undefined) return `${head}<p class="muted">載入中…</p>`;
  const f = opts.fund;
  if (!f) return `${head}<p class="muted">這一檔沒有財報資料。</p>`;
  const { date, prevClose } = opts;

  // 估值：最近一筆（昨天以前）的近四季 EPS、股利、每股淨值，配上昨收
  let val = '';
  const r = [...f.r].reverse().find((x) => x[0] < date);
  if (r && prevClose) {
    const [, eps4, div, bvps] = r;
    const pe = eps4 && eps4 > 0 ? prevClose / eps4 : null;
    const yld = div != null ? div / prevClose : null;
    const pb = bvps && bvps > 0 ? prevClose / bvps : null;
    val = `<dl class="sim-kpis sim-fund-kpis">
      <div><dt>本益比</dt><dd class="num">${pe == null ? (eps4 != null && eps4 <= 0 ? '虧損' : '—') : `${num(pe, 1)} 倍`}</dd></div>
      <div><dt>殖利率</dt><dd class="num">${ratioTxt(yld, 2)}</dd></div>
      <div><dt>股價淨值比</dt><dd class="num">${pb == null ? '—' : `${num(pb, 2)} 倍`}</dd></div>
      <div><dt>近四季 EPS</dt><dd class="num">${eps4 == null ? '—' : f2(eps4)}</dd></div>
      <div><dt>現金股利</dt><dd class="num">${div == null ? '—' : f2(div)}</dd></div>
      <div><dt>每股淨值</dt><dd class="num">${bvps == null ? '—' : f2(bvps)}</dd></div>
    </dl>`;
  }

  // 已公布的季報（公布日在今天以前），新的在前
  const seen = f.q.filter((q) => q[1] < date);
  const byLabel = new Map(seen.map((q) => [q[0], q]));
  const lastYear = (q: FundQuarter) => byLabel.get(`${Number(q[0].slice(0, 4)) - 1}${q[0].slice(4)}`);
  const rows = seen
    .slice(-8)
    .reverse()
    .map((q, i) => {
      const [label, , rev, gp, op, , eps] = q;
      const ly = lastYear(q);
      const revYoy = growth(rev, ly?.[2] ?? null);
      const epsYoy = growth(eps, ly?.[6] ?? null);
      const gm = rev && gp != null ? gp / rev : null;
      const om = rev && op != null ? op / rev : null;
      return `<tr><td>${i === 0 ? '最新一季' : `前 ${i} 季`}<small class="muted">（Q${label.slice(5)}）</small></td>
        <td class="num">${yi(rev)}</td><td class="num ${revYoy == null ? '' : cls(revYoy)}">${pctTxt(revYoy)}</td>
        <td class="num">${ratioTxt(gm)}</td><td class="num">${ratioTxt(om)}</td>
        <td class="num ${eps == null ? '' : cls(eps)}">${eps == null ? '—' : f2(eps)}</td><td class="num ${epsYoy == null ? '' : cls(epsYoy)}">${pctTxt(epsYoy)}</td></tr>`;
    })
    .join('');

  // 一句話重點
  const tips: string[] = [];
  const latest = seen[seen.length - 1];
  if (latest) {
    const ly = lastYear(latest);
    const g = growth(latest[6], ly?.[6] ?? null);
    if (g != null) tips.push(g > 0.2 ? `最新一季 EPS 比去年同季成長 ${pctTxt(g, 0)}，獲利明顯變好` : g < -0.2 ? `最新一季 EPS 比去年同季衰退 ${pctTxt(g, 0)}，獲利變差` : '最新一季獲利跟去年同季差不多');
    const prev = seen[seen.length - 2];
    const gm = (q?: FundQuarter) => (q && q[2] && q[3] != null ? q[3] / q[2] : null);
    const a = gm(latest);
    const b = gm(prev);
    if (a != null && b != null && Math.abs(a - b) >= 0.01) tips.push(`毛利率比上一季${a > b ? '提高' : '下降'} ${num(Math.abs(a - b) * 100, 1)} 個百分點`);
    if (latest[7] != null && latest[5] != null && latest[5] > 0 && latest[7] < 0) tips.push('本業賺錢但營業現金流為負，留意收款狀況');
  }
  const table = rows
    ? `<div class="sim-table-wrap"><table class="sim-table sim-fund-table"><thead><tr><th>季別</th><th>營收（億）</th><th>營收年增</th><th>毛利率</th><th>營益率</th><th>EPS</th><th>EPS 年增</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">還沒有已公布的季報。</p>';
  return `${head}${val}${tips.length ? `<ul class="sim-fund-tips">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${table}
    <p class="muted sim-fund-note">財報過了申報期限才看得到；本益比、殖利率、淨值比用昨天收盤價計算。金融股沒有毛利，營收為淨收益。</p>`;
}

export function techHtml(opts: { candles: Candle[]; chips: ChipSeries | null | undefined; date: string }): string {
  const head = '<h2 class="panel-title">技術分析 <small>只用到現在為止的價格</small></h2>';
  const rep = analyzeTechnicals(opts.candles, 'ema');
  if (!rep) return `${head}<p class="muted">資料不足 30 天，還算不出指標。</p>`;
  const bull = rep.signals.filter((x) => x.tilt === 'bull').length;
  const bear = rep.signals.filter((x) => x.tilt === 'bear').length;
  const overall: Tilt = bull - bear >= 2 ? 'bull' : bear - bull >= 2 ? 'bear' : 'neutral';
  const list = rep.signals
    .map(
      (x) => `<li><span class="tilt tilt-${x.tilt}">${TILT[x.tilt]}</span><b>${esc(x.name)}</b> <span class="num">${esc(x.value)}</span><small class="muted">${esc(x.note)}</small></li>`,
    )
    .join('');

  // 籌碼：外資＋投信買賣超（到昨天為止）、千張大戶
  let chips = '';
  const c = opts.chips;
  if (c === undefined) chips = '<p class="muted">籌碼載入中…</p>';
  else if (c) {
    const inst = c.inst.filter(([d]) => d < opts.date);
    const sum = (n: number) => inst.slice(-n).reduce((a, [, v]) => a + v, 0);
    let streak = 0;
    for (let i = inst.length - 1; i >= 0; i--) {
      const v = inst[i][1];
      if (v === 0 || (streak > 0 && v < 0) || (streak < 0 && v > 0)) break;
      streak += v > 0 ? 1 : -1;
    }
    const big = c.big.filter(([d]) => d < opts.date);
    const b0 = big[big.length - 1]?.[1];
    const b4 = big[big.length - 5]?.[1];
    if (inst.length)
      chips = `<h3 class="sim-sub">籌碼 <small class="muted">外資＋投信，到昨天為止</small></h3>
        <dl class="sim-kpis sim-fund-kpis">
          <div><dt>近 5 日買賣超</dt><dd class="num ${cls(sum(5))}">${num(sum(5))} 張</dd></div>
          <div><dt>近 20 日買賣超</dt><dd class="num ${cls(sum(20))}">${num(sum(20))} 張</dd></div>
          <div><dt>連續</dt><dd class="num ${cls(streak)}">${streak ? `${streak > 0 ? '買' : '賣'} ${Math.abs(streak)} 天` : '—'}</dd></div>
          ${b0 != null ? `<div><dt>千張大戶</dt><dd class="num">${num(b0, 1)}%${b4 != null ? ` <small class="${cls(b0 - b4)}">${b0 >= b4 ? '+' : ''}${num(b0 - b4, 2)}</small>` : ''}</dd></div>` : ''}
        </dl>`;
  }
  return `${head}<p class="sim-tech-overall">綜合：<span class="tilt tilt-${overall}">${TILT[overall]}</span> <small class="muted">偏多 ${bull} 項、偏空 ${bear} 項</small></p>
    <ul class="sim-tech-list">${list}</ul>${chips}
    <p class="muted sim-fund-note">均線用 EMA20／60／120。指標是常見的看法，不一定準；看不懂可以到「📘 股市入門」的技術指標章節。</p>`;
}
