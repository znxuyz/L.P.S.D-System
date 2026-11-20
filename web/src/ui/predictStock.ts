/**
 * 預測頁「個股預測」：搜尋任一檔股票，選 K 線週期看預測。
 * - 日 K：未來約一個月的中線與 80% 區間（見 domain/stockForecast.ts，回測校準過）。
 * - 3 分 K、5 分 K：個股沒有公開的歷史盤中資料，沒辦法訓練和驗證，誠實說明而不是亂畫。
 */
import type { Candle } from '../domain/technicals';
import { dailyForecast, type StockCalib } from '../domain/stockForecast';
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
    body.innerHTML = `<p class="pd-note is-warn"><b>${esc(st.code)} ${esc(name)}：個股的 ${st.tf === '5m' ? '5' : '3'} 分 K 預測目前做不到，不想亂畫一條線騙你。</b>
      要預測又要能驗證準不準，需要這檔股票過去幾年的盤中 K 線來訓練和回測；但證交所、櫃買只公開<b>大盤指數</b>的盤中資料（所以 00631L 能做），個股的歷史盤中資料沒有公開來源。
      富果的盤中 K 線只有當天、而且金鑰只存在你的瀏覽器，沒辦法拿來訓練。能做的是：個股看下面的「日 K」；大盤（00631L）看下面的 5 分 K${st.tf === '3m' ? '（3 分 K 的歷史資料正在回補，補齊後加上）' : ''}。</p>`;
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
  const f = dailyForecast(candles.map((c) => c.close), score, rev.calib as StockCalib);
  if (!f.path.length) {
    body.innerHTML = '<p class="muted">近期波動資料不夠，算不出區間。</p>';
    return;
  }
  const last = candles[candles.length - 1];
  const end = f.path[f.path.length - 1];
  const dc = f.decile != null ? rev.calib.deciles[f.decile] : null;
  const cov = rev.calib.coverage.filter((x) => x.inside != null);
  body.innerHTML = `
    <dl class="pd-stats">
      <div><dt>${esc(st.code)} ${esc(name)}　收盤（${esc(last.date.slice(5))}）</dt><dd class="num">${num(last.close, last.close < 100 ? 2 : 1)}</dd></div>
      <div><dt>營收選股分數</dt><dd class="num">${score == null ? '—' : `${score} <small class="muted">（第 ${f.decile! + 1} 組／10）</small>`}</dd></div>
      <div><dt>約一個月後中線</dt><dd class="num">${num(end.mid, end.mid < 100 ? 2 : 1)} <small>${pctTxt(f.avg)}</small></dd></div>
      <div><dt>約一個月後 80% 區間</dt><dd class="num">${num(end.lo, end.lo < 100 ? 2 : 1)}～${num(end.hi, end.hi < 100 ? 2 : 1)}</dd></div>
    </dl>
    ${chartSvg(candles.slice(-120), f.path)}
    <p class="pd-note">怎麼算的：<b>中線</b>＝這檔股票目前的營收選股分數所在的那一組（全部股票分 10 組），2021 年以來每次換股後一個月的平均報酬 ${pctTxt(f.avg)}${dc ? `（這一組贏全部平均的比例 ${num((dc.beat ?? 0) * 100, 0)}%）` : score == null ? '（這檔不在可選範圍：成交額太小或上市不滿一年，用全部股票的平均）' : ''}；<b>區間</b>＝近 60 日波動 ${num(f.sigma * 100, 2)}%／天 × √天數，再用歷史上實際落點的 10%／90% 分位數放寬，回測各年實際落在區間內的比例：${cov.map((x) => `${esc(x.year)} ${num(x.inside! * 100, 0)}%`).join('、')}。</p>
    <p class="pd-note is-warn">誠實說：分數高的那幾組<b>平均</b>比較好（最高組一個月平均 ${pctTxt(rev.calib.deciles[9]?.avg ?? 0)}、最低組 ${pctTxt(rev.calib.deciles[0]?.avg ?? 0)}），但單一一檔股票下個月漲或跌接近擲銅板，中線只是「同類股票的平均」，<b>區間才是這張圖最可靠的部分</b>。</p>`;
}

/** 日 K（最近 120 天）＋未來的中線與區間。 */
function chartSvg(c: Candle[], path: Array<{ t: number; mid: number; lo: number; hi: number }>): string {
  const W = 640;
  const H = 300;
  const n = c.length + path.length;
  const lo = Math.min(...c.map((x) => x.low), ...path.map((p) => p.lo));
  const hi = Math.max(...c.map((x) => x.high), ...path.map((p) => p.hi));
  const x = (i: number) => 8 + ((i + 0.5) / n) * (W - 16);
  const y = (v: number) => 8 + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - 24);
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
  return `<div class="pd-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日 K 與未來一個月預測">
    <polygon points="${band}" class="pd-band"/>${candles}
    <polyline points="${mid}" class="pd-mid" fill="none"/>
    <line x1="${x(i0 + 0.5)}" x2="${x(i0 + 0.5)}" y1="8" y2="${H - 16}" class="pd-now"/>
    <text x="8" y="${H - 2}" class="pd-axis">${esc(c[0].date.slice(0, 7))}</text><text x="${x(i0)}" y="${H - 2}" class="pd-axis" text-anchor="middle">今天</text><text x="${W - 8}" y="${H - 2}" class="pd-axis" text-anchor="end">約一個月後</text>
  </svg>
  <p class="pd-legend muted"><span class="pd-sw band"></span>80% 區間　<span class="pd-sw mid"></span>中線（同分數組的平均）</p></div>`;
}
