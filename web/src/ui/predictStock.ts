/**
 * 預測頁「個股預測」：搜尋任一檔股票，選 K 線週期看預測。
 * - 日 K：未來約三個月的方向預測主線（一定押方向）與 80% 區間（見 domain/stockForecast.ts）。
 * - 3 分 K、5 分 K：個股沒有公開的歷史盤中資料，沒辦法訓練和驗證，誠實說明而不是亂畫。
 */
import type { Candle } from '../domain/technicals';
import { analogBacktest, analogForecast, dailyForecast, directionPath, typicalMove, type AnalogResult, type StockCalib } from '../domain/stockForecast';
import { adjustSplits, loadOfficialCandles } from '../data/candles';
import { loadStockDirectory, searchDirectory, type DirEntry } from '../data/stockDirectory';
import type { RevStocks } from '../data/predict';
import { escapeHtml as esc, num } from './format';

type Tf = 'day' | '5m' | '3m';
const st: { code: string; tf: Tf } = { code: '2330', tf: 'day' };
let dir: DirEntry[] = [];
const cache = new Map<string, Promise<Candle[] | null>>();

const pctTxt = (v: number, d = 1) => `${v > 0 ? '+' : ''}${num(v * 100, d)}%`;

export function stockForecastShell(): string {
  return `<section class="pd-card glass" id="pd-stock">
    <header class="pd-head"><div><p class="eyebrow">Stock forecast · 個股</p><h2>個股預測</h2></div></header>
    <form class="pd-stock-form" id="pd-stock-form" role="search">
      <input type="search" id="pd-stock-q" list="pd-stock-list" placeholder="代號或名稱，例如 2330" aria-label="搜尋股票" autocomplete="off" />
      <datalist id="pd-stock-list"></datalist>
      <div class="pd-tf" role="group" aria-label="K 線週期">
        <button type="button" data-tf="day">日 K</button><button type="button" data-tf="5m">5 分 K</button><button type="button" data-tf="3m">3 分 K</button>
      </div>
      <button type="submit" class="btn btn-accent">預測</button>
    </form>
    <div id="pd-stock-body"><p class="muted">載入中…</p></div>
  </section>`;
}

export function bindStockForecast(root: HTMLElement, rev: RevStocks | undefined): void {
  const sec = root.querySelector<HTMLElement>('#pd-stock');
  if (!sec) return;
  const q = sec.querySelector<HTMLInputElement>('#pd-stock-q')!;
  const list = sec.querySelector<HTMLDataListElement>('#pd-stock-list')!;
  void loadStockDirectory().then((d) => {
    dir = d?.stocks ?? [];
    list.innerHTML = dir.map((x) => `<option value="${x.code} ${esc(x.name)}"></option>`).join('');
    const e = dir.find((x) => x.code === st.code);
    if (e && !q.value) q.value = `${e.code} ${e.name}`;
  });
  const go = () => void show(sec, rev);
  sec.querySelector('#pd-stock-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const hit = searchDirectory(dir, q.value) ?? (/^\d{4,6}[A-Z]?$/.test(q.value.trim()) ? { code: q.value.trim(), name: '' } : undefined);
    if (hit) st.code = hit.code;
    go();
  });
  sec.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) =>
    b.addEventListener('click', () => {
      st.tf = b.dataset.tf as Tf;
      go();
    }),
  );
  go();
}

async function show(sec: HTMLElement, rev: RevStocks | undefined): Promise<void> {
  sec.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => b.classList.toggle('is-on', b.dataset.tf === st.tf));
  const body = sec.querySelector<HTMLElement>('#pd-stock-body')!;
  const name = dir.find((x) => x.code === st.code)?.name ?? '';
  if (st.tf !== 'day') {
    body.innerHTML = `<p class="pd-note is-warn"><b>${esc(st.code)} ${esc(name)}：個股的 ${st.tf === '5m' ? '5' : '3'} 分 K 預測還在準備，先不畫線。</b>
      系統每天收盤後用你放在 GitHub 的富果金鑰，收集約 50 檔（成交額最大的股票、00631L、0050、營收選股名單）的 1 分 K，存在私人儲存庫，目前約 140 天，還會往回補到富果提供的最早日期。
      富果的資料不能公開，所以模型會在 GitHub 上私下訓練，網站只放<b>預測結果與回測成績</b>，不放原始 K 線。資料量夠、而且回測確認比「不會動」準之後才上線；在那之前個股請看「日 K」，大盤看下面的 00631L 5 分 K。</p>`;
    return;
  }
  if (!rev?.calib) {
    body.innerHTML = '<p class="muted">預測資料還沒準備好。</p>';
    return;
  }
  body.innerHTML = '<p class="muted">載入日 K…</p>';
  let p = cache.get(st.code);
  if (!p) {
    p = loadOfficialCandles(st.code).then(async (c) => (c ? (await adjustSplits(st.code, { candles: c, source: 'official' })).candles : null));
    cache.set(st.code, p);
  }
  const candles = await p;
  if (!candles || candles.length < 80) {
    body.innerHTML = `<p class="muted">${esc(st.code)} 沒有足夠的日 K 資料（至少要 80 天）。</p>`;
    return;
  }
  const score = rev.all?.[st.code] ?? null;
  const f = dailyForecast(candles.map((c) => c.close), score, rev.calib as StockCalib, FH);
  if (!f.path.length) {
    body.innerHTML = '<p class="muted">近期波動資料不夠，算不出區間。</p>';
    return;
  }
  const closes = candles.map((c) => c.close);
  const an = analogForecast(closes, closes.length - 1, 20, FH);
  const bt = analogBacktest(closes, FH);
  const last = candles[candles.length - 1];
  // 主線：方向預測（一定押方向）；區間仍以營收分數組的平均為中心
  const dp = an ? directionPath(an, 5, typicalMove(f.sigma, FH)) : null;
  const path = f.path.map((p, i) => ({ ...p, mid: dp ? last.close * Math.exp(dp[i]) : p.mid }));
  const end = path[path.length - 1];
  const m1 = path[20];
  const up = end.mid >= last.close;
  const px = (v: number) => num(v, v < 100 ? 2 : 1);
  const dc = f.decile != null ? rev.calib.deciles[f.decile] : null;
  const cov = rev.calib.coverage.filter((x) => x.inside != null);
  body.innerHTML = `
    <dl class="pd-stats">
      <div><dt>${esc(st.code)} ${esc(name)}　收盤（${esc(last.date.slice(5))}）</dt><dd class="num">${num(last.close, last.close < 100 ? 2 : 1)}</dd></div>
      <div><dt>營收選股分數</dt><dd class="num">${score == null ? '—' : `${score} <small class="muted">（第 ${f.decile! + 1} 組／10）</small>`}</dd></div>
      <div><dt>方向預測（一個月／三個月後）</dt><dd class="num"><b class="${up ? 'up' : 'down'}">${up ? '押漲' : '押跌'}</b> ${px(m1.mid)} <small>${pctTxt(m1.mid / last.close - 1)}</small>／${px(end.mid)} <small>${pctTxt(end.mid / last.close - 1)}</small></dd></div>
      <div><dt>方向命中率（三個月後，這檔過去約兩年）</dt><dd class="num">${bt ? `${num(bt.hit * 100, 0)}% <small class="muted">（${num(bt.n)} 次；同期間一直押漲 ${num(bt.upRate * 100, 0)}%）</small>` : '—'}</dd></div>
      <div><dt>營收分數組一個月平均</dt><dd class="num">${pctTxt(f.avg)}</dd></div>
      <div><dt>80% 區間（一個月後）</dt><dd class="num">${px(m1.lo)}～${px(m1.hi)}</dd></div>
      <div><dt>80% 區間（三個月後）</dt><dd class="num">${px(end.lo)}～${px(end.hi)}</dd></div>
    </dl>
    ${chartSvg(candles.slice(-FH), path, an, 0, '方向預測（主線）')}
    <p class="pd-note">怎麼算的：<b>方向預測（主線）</b>一定押一個方向：在這檔股票自己的歷史裡找最近 20 天走勢形狀（漲跌先除以當時的波動）最像現在的 5 段${an ? `（${an.lines.slice(0, 3).map((l) => esc(candles[l.at].date)).join('、')}⋯）` : ''}，看它們之後三個月平均是漲還是跌來決定方向；線的形狀與幅度＝其中「也往這個方向走」的那幾段真實走勢的平均，終點幅度＝這種波動下三個月一般會走的幅度（中位數）。細線是最像的 3 段。<b>方向命中率</b>是同樣方法、只用當時以前的資料，回測這檔過去約兩年（每 5 天一次）三個月後方向猜對的比例。</p>
    <p class="pd-note"><b>區間</b>＝近 60 日波動 ${num(f.sigma * 100, 2)}%／天 × √天數，以營收選股分數組的平均報酬 ${pctTxt(f.avg)}／月為中心${dc ? `（這一組贏全部平均的比例 ${num((dc.beat ?? 0) * 100, 0)}%）` : score == null ? '（這檔不在可選範圍，用全部股票的平均）' : ''}，再用歷史實際落點的 10%／90% 分位數放寬；一個月後回測各年實際落在區間內的比例：${cov.map((x) => `${esc(x.year)} ${num(x.inside! * 100, 0)}%`).join('、')}。</p>
    <p class="pd-note is-warn">命中率照實寫：之前測 17 檔常見股票，這種方法一個月後的方向平均約對 51%。看上面這一檔自己的命中率決定要信幾成；營收分數高的組<b>平均</b>比較好（最高組一個月 ${pctTxt(rev.calib.deciles[9]?.avg ?? 0)}、最低組 ${pctTxt(rev.calib.deciles[0]?.avg ?? 0)}）。</p>`;
}

/** 日 K（最近 120 天）＋未來的中線與區間。 */
/** 預測長度：約三個月的交易日（畫面左半邊是過去同樣長度，預測線從中間開始）。 */
export const FH = 63;

/** from 之後的 n 個平日（YYYY-MM-DD），用來標未來的時間軸。 */
export function futureWeekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function chartSvg(c: Candle[], path: Array<{ t: number; mid: number; lo: number; hi: number }>, an: AnalogResult | null = null, _off = 0, midLabel = '中線（同分數組的平均）'): string {
  const W = 640;
  const H = 300;
  const n = c.length + path.length;
  const last0 = c[c.length - 1].close;
  const anPx = an ? [an.avg, ...an.lines.slice(0, 3).map((l) => l.path)].flat().map((r) => last0 * Math.exp(r)) : [];
  const lo = Math.min(...c.map((x) => x.low), ...path.map((p) => p.lo), ...anPx);
  const hi = Math.max(...c.map((x) => x.high), ...path.map((p) => p.hi), ...anPx);
  const x = (i: number) => 8 + ((i + 0.5) / n) * (W - 16);
  const y = (v: number) => 24 + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - 42);
  const bw = Math.max(1, ((W - 16) / n) * 0.6);
  const candles = c
    .map((k, i) => {
      const up = k.close >= k.open;
      return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(k.high)}" y2="${y(k.low)}" class="pd-k ${up ? 'up' : 'down'}"/><rect x="${x(i) - bw / 2}" y="${Math.min(y(k.open), y(k.close))}" width="${bw}" height="${Math.max(1, Math.abs(y(k.open) - y(k.close)))}" class="pd-k ${up ? 'up' : 'down'}"/>`;
    })
    .join('');
  const i0 = c.length - 1;
  const last = c[i0].close;
  const pts = [{ t: 0, mid: last, lo: last, hi: last }, ...path];
  const band = `${pts.map((p) => `${x(i0 + p.t)},${y(p.hi)}`).join(' ')} ${pts
    .slice()
    .reverse()
    .map((p) => `${x(i0 + p.t)},${y(p.lo)}`)
    .join(' ')}`;
  const mid = pts.map((p) => `${x(i0 + p.t)},${y(p.mid)}`).join(' ');
  const line = (r: number[]) => [`${x(i0)},${y(last)}`, ...r.map((v, t) => `${x(i0 + t + 1)},${y(last * Math.exp(v))}`)].join(' ');
  const anSvg = an ? `${an.lines.slice(0, 3).map((l) => `<polyline points="${line(l.path)}" class="pd-an" fill="none"/>`).join('')}<polyline points="${line(an.avg)}" class="pd-an-avg" fill="none"/>` : '';
  // 時間軸：過去用真實交易日、未來用「平日」推估（不扣國定假日），每個月第一個交易日標一次
  const dates = [...c.map((k) => k.date), ...futureWeekdays(c[i0].date, path.length)];
  const ticks = dates
    .map((d, i) => {
      if (i === 0 || d.slice(0, 7) === dates[i - 1].slice(0, 7)) return '';
      const lab = d.slice(5, 7) === '01' ? d.slice(0, 7) : `${Number(d.slice(5, 7))} 月`;
      return `<line x1="${x(i - 0.5)}" x2="${x(i - 0.5)}" y1="8" y2="${H - 16}" class="pd-grid"/><text x="${x(i - 0.5) + 3}" y="${H - 2}" class="pd-axis${i > i0 ? ' is-future' : ''}">${esc(lab)}</text>`;
    })
    .join('');
  return `<div class="pd-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="過去約三個月日 K 與未來三個月預測">
    <polygon points="${band}" class="pd-band"/>${candles}
    <polyline points="${mid}" class="pd-mid" fill="none"/>${anSvg}
    <line x1="${x(i0 + 0.5)}" x2="${x(i0 + 0.5)}" y1="8" y2="${H - 16}" class="pd-now"/>
    ${ticks}<text x="${x(i0 + 0.5)}" y="18" class="pd-axis" text-anchor="middle">今天 ${esc(c[i0].date.slice(5).replace('-', '/'))}</text>
  </svg>
  <p class="pd-legend muted"><span class="pd-sw band"></span>80% 區間　<span class="pd-sw mid"></span>${midLabel}${an ? '　<span class="pd-sw an-avg"></span>相似走勢預測線　<span class="pd-sw an"></span>最像的 3 段' : ''}　<span class="muted">（未來的日期用平日推估，不扣國定假日）</span></p></div>`;
}
