import { bisector, pointer, scaleBand, scaleLinear, select } from 'd3';
import type { DailySeries } from '../data/candles';
import type { Fundamentals, Universe } from '../data/types';
import { buildSummary, peerRating, peerStars, peerStats, strategyScores, type StrategyScore, type Summary } from '../domain/analysis';
import type { MarketMetrics, StockMetrics } from '../domain/metrics';
import { mockNews, newsLinks } from '../domain/news';
import { industryPeMedians, stockView, type StockView } from '../domain/screens';
import { MA_PERIODS, analyzeTechnicals, type Candle, type MaPeriod, type TechReport, type Tilt } from '../domain/technicals';
import { PATTERN_COLORS, PATTERN_GUIDE, detectPatterns, type Bias, type Pattern } from '../domain/patterns';
import type { DirEntry, StockDirectory } from '../data/stockDirectory';
import type { Palette } from './colors';
import { direction, escapeHtml as esc, num, pct, price, signedYi, yi } from './format';

/**
 * 個股分析頁：K 線、五大策略評分、技術指標、資金與籌碼、同業比較、新聞與綜合摘要。
 */

/** 熱力圖股票池以外的股票（從全市場目錄查到的）。 */
export interface ExternalStock {
  stock: StockMetrics;
  f: Fundamentals;
  entry: DirEntry;
  /** 目錄資料日期。 */
  asOf: string;
  /** 是否已拿到即時報價（否則是目錄的最近收盤）。 */
  live: boolean;
}

export interface StockPageContext {
  /** 真實行情時，基本面哪些是官方資料的說明。 */
  realSrc?: string;
  /** 查詢的股票不在股票池時才有。 */
  external?: ExternalStock;
  /** 全市場股票目錄（搜尋建議用）。 */
  directory?: StockDirectory;
  metrics: MarketMetrics;
  universe: Universe;
  fundamentals: Map<string, Fundamentals>;
  pal: Palette;
  /** 今天盤中的股價紀錄（推算今天的開盤價）。 */
  history: Map<string, number[]>;
  /** 日 K；undefined = 載入中。 */
  daily: DailySeries | undefined;
  /** 日 K 開始下載的時間（載入中才有）。 */
  dailyStartedAt?: number;
  /** 預計的日 K 來源（載入動畫顯示用）。 */
  dailySource?: 'fugle' | 'official' | 'mock';
  /** 是否為真實行情。 */
  live: boolean;
  today: string;
}

/**
 * 均線顏色（已通過深色背景的色盲與對比檢查）。同一週期的 MA 與 EMA 同色，
 * 用線型區分：MA 虛線、EMA 實線。
 */
const MA_COLORS: Record<MaPeriod, string> = { 20: '#3987e5', 60: '#c98500', 120: '#9d73e6' };
const MA_NAME: Record<MaPeriod, string> = { 20: '月線', 60: '季線', 120: '半年線' };

/** K 線圖上要顯示哪些均線，記在這台裝置的瀏覽器。 */
const LINES_KEY = 'lplc.kchart.lines';
const lineVis: { ma: boolean; ema: boolean; pat: boolean } = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(LINES_KEY) ?? '{}');
    return { ma: v.ma !== false, ema: v.ema !== false, pat: v.pat !== false };
  } catch {
    return { ma: true, ema: true, pat: true };
  }
})();
/** 型態面板裡取消勾選「畫在圖上」的型態，記在這台裝置。 */
const PAT_HIDDEN_KEY = 'lplc.kchart.hiddenPatterns';
const hiddenPatterns: Set<string> = (() => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(PAT_HIDDEN_KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
})();
/** 切換均線後立刻重畫圖例與 K 線圖（不用等下一次行情更新）。 */
let redrawChart: (() => void) | null = null;

/**
 * K 線的縮放與平移：count = 顯示幾根，right = 最右邊往回推幾根（0 = 最新）。
 * 滑鼠滾輪縮放、拖曳平移；手機用兩指縮放、單指左右滑動；雙擊還原。
 */
const DEFAULT_BARS = 120;
const MIN_BARS = 20;
const kView = { code: '', count: DEFAULT_BARS, right: 0 };
/** 最近一次繪圖的版面，事件處理用來換算座標。 */
let kLayout = { plotL: 0, plotW: 1, total: 0 };

function clampView(total: number): void {
  kView.count = Math.round(Math.min(Math.max(kView.count, Math.min(MIN_BARS, total)), total));
  kView.right = Math.round(Math.min(Math.max(kView.right, 0), total - kView.count));
}

/** 以畫面上的某個位置（0–1）為中心縮放。 */
function zoomAt(frac: number, factor: number): void {
  const { total } = kLayout;
  if (!total) return;
  const off = total - kView.right - kView.count;
  const anchor = off + frac * kView.count;
  kView.count = kView.count * factor;
  clampView(total);
  const newOff = Math.round(anchor - frac * kView.count);
  kView.right = total - newOff - kView.count;
  clampView(total);
}

/** 只綁一次：滾輪、滑鼠拖曳、觸控縮放與滑動。 */
function bindZoom(el: HTMLElement): void {
  if (el.dataset.zoomBound) return;
  el.dataset.zoomBound = '1';
  const redraw = () => {
    delete el.dataset.hover;
    redrawChart?.();
  };
  const fracOf = (clientX: number) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left - kLayout.plotL) / kLayout.plotW));
  };
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(fracOf(e.clientX), Math.exp(e.deltaY * 0.0015));
      redraw();
    },
    { passive: false },
  );
  const pts = new Map<number, number>();
  let start = { count: 0, right: 0, x: 0, dist: 0, frac: 0 };
  const snapshot = () => {
    const xs = [...pts.values()];
    start = {
      count: kView.count,
      right: kView.right,
      x: xs[0] ?? 0,
      dist: xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0,
      frac: xs.length > 1 ? fracOf((xs[0] + xs[1]) / 2) : 0,
    };
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, e.clientX);
    el.setPointerCapture(e.pointerId);
    snapshot();
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e.clientX);
    const xs = [...pts.values()];
    if (xs.length >= 2 && start.dist > 10) {
      // 兩指縮放：手指距離變大 = 放大（顯示的根數變少）
      kView.count = start.count;
      kView.right = start.right;
      zoomAt(start.frac, start.dist / Math.max(10, Math.abs(xs[0] - xs[1])));
    } else if (xs.length === 1) {
      // 拖曳平移：往右拖看更早的資料
      kView.right = start.right + ((xs[0] - start.x) / kLayout.plotW) * kView.count;
      clampView(kLayout.total);
    } else return;
    el.classList.add('is-dragging');
    redraw();
  });
  const end = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    snapshot();
    if (!pts.size) el.classList.remove('is-dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => {
    kView.count = DEFAULT_BARS;
    kView.right = 0;
    clampView(kLayout.total);
    redraw();
  });
}

/** 圖例用的小圖示：虛線是 MA、實線是 EMA，只畫有勾選的。 */
function lineIcon(color: string): string {
  const dashed = `<line x1="0" x2="18" y1="${lineVis.ema ? 2.5 : 5}" y2="${lineVis.ema ? 2.5 : 5}" stroke="${color}" stroke-width="1.6" stroke-dasharray="3 2"></line>`;
  const solid = `<line x1="0" x2="18" y1="${lineVis.ma ? 7.5 : 5}" y2="${lineVis.ma ? 7.5 : 5}" stroke="${color}" stroke-width="1.8"></line>`;
  return `<svg class="ma-icon" width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">${lineVis.ma ? dashed : ''}${lineVis.ema ? solid : ''}</svg>`;
}
const TILT_LABEL: Record<Tilt, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };
const TILT_ICON: Record<Tilt, string> = { bull: '▲', bear: '▼', neutral: '●' };

const dirCls = (v: number) => direction(v);

/** 內容沒變就不重畫，避免每秒更新時打斷使用者的操作（例如展開的項目被收起）。 */
function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

/** 使用者展開過的策略（跨更新與換股都保留）。 */
const openStrategies = new Set<string>();

/** 星等（1–5，可有半顆）。 */
function starsHtml(stars: number, cls = ''): string {
  const icons = [1, 2, 3, 4, 5].map((i) => {
    const kind = stars >= i ? 'full' : stars >= i - 0.5 ? 'half' : 'empty';
    return `<i class="s-${kind}">★</i>`;
  });
  return `<span class="stars ${cls}" role="img" aria-label="${stars} 顆星（滿分 5 顆）">${icons.join('')}</span>`;
}

function kv(label: string, value: string, cls = ''): string {
  return `<div class="d-kv"><dt>${label}</dt><dd class="num ${cls}">${value}</dd></div>`;
}

function tiltTag(t: Tilt): string {
  return `<span class="tilt tilt-${t}"><i aria-hidden="true">${TILT_ICON[t]}</i>${TILT_LABEL[t]}</span>`;
}

/** 把今天的即時報價補成最後一根 K 棒。 */
function withToday(candles: Candle[], s: StockMetrics, history: number[] | undefined, today: string, session: string): Candle[] {
  if (session === 'pre' || !candles.length || candles[candles.length - 1].date >= today) return candles;
  if (s.volume <= 0 && session !== 'open') return candles;
  const open = history?.[0] ?? s.prevClose;
  return [
    ...candles,
    { date: today, open, high: Math.max(s.high, open, s.price), low: Math.min(s.low, open, s.price), close: s.price, volume: s.volume },
  ];
}

export function renderStockPage(root: HTMLElement, code: string, ctx: StockPageContext): void {
  const s = ctx.metrics.stockByCode.get(code) ?? ctx.external?.stock;
  const f = ctx.fundamentals.get(code) ?? ctx.external?.f;
  if (!root.dataset.ready) {
    root.innerHTML = `
      <header class="sa-head glass" id="sa-head"></header>
      <section class="sa-chart glass" aria-label="K 線圖"><div class="sa-chart-head" id="sa-chart-head"></div><div class="kchart" id="sa-kchart"></div></section>
      <section class="sa-pattern glass" id="sa-pattern" aria-label="型態辨識"></section>
      <section class="sa-summary glass" id="sa-summary" aria-label="綜合摘要"></section>
      <section class="sa-score glass" id="sa-score" aria-label="五大策略評分"></section>
      <section class="sa-tech glass" id="sa-tech" aria-label="技術指標"></section>
      <section class="sa-fund glass" id="sa-fund" aria-label="基本面與同業比較"></section>
      <section class="sa-news glass" id="sa-news" aria-label="新聞"></section>`;
    root.dataset.ready = '1';
  }
  const $ = (id: string) => root.querySelector<HTMLElement>(id)!;
  renderHead($('#sa-head'), code, s, ctx);
  if (!s || !f) {
    for (const id of ['#sa-chart-head', '#sa-kchart', '#sa-pattern', '#sa-summary', '#sa-score', '#sa-tech', '#sa-fund', '#sa-news']) $(id).innerHTML = '';
    $('#sa-summary').innerHTML =
      ctx.directory === undefined && !ctx.metrics.stockByCode.has(code)
        ? '<p class="muted">正在載入全市場股票目錄…（若一直沒有出現，代表目錄還沒產生，目前只能查熱力圖裡的股票）</p>'
        : '<p class="muted">找不到這檔股票。請用上方的搜尋輸入代號或名稱。</p>';
    return;
  }
  const candles = ctx.daily ? withToday(ctx.daily.candles, s, ctx.history.get(code), ctx.today, ctx.metrics.session) : [];
  const tech = analyzeTechnicals(candles);
  const { patterns } = detectPatterns(candles);
  const view = stockView(s, f, industryPeMedians(ctx.metrics, ctx.universe).get(s.industryId) ?? null);
  const scores = strategyScores(view);
  const summary = buildSummary(view, scores, tech, ctx.metrics, ctx.universe, !ctx.external);

  redrawChart = () => {
    renderKChart($('#sa-kchart'), code, candles, tech, ctx, patterns);
    renderChartHead($('#sa-chart-head'), ctx, tech, candles.length);
  };
  redrawChart();
  renderPatterns($('#sa-pattern'), patterns, ctx, candles.length);
  renderSummary($('#sa-summary'), summary);
  renderScores($('#sa-score'), scores);
  renderTech($('#sa-tech'), tech, ctx.daily === undefined, ctx);
  renderFund($('#sa-fund'), view, ctx, f);
  renderNews($('#sa-news'), s, f, ctx);
}

// ---------------------------------------------------------------- 標頭與搜尋

function renderHead(el: HTMLElement, code: string, s: StockMetrics | undefined, ctx: StockPageContext): void {
  // 搜尋框只建立一次（避免每秒重畫洗掉輸入），之後只更新名稱與報價
  if (!el.dataset.ready) {
    el.innerHTML = `
      <div class="sa-id"></div>
      <div class="sa-quote"></div>
      <form class="sa-search" id="sa-search" role="search">
        <input type="search" id="sa-q" list="sa-stocks" placeholder="輸入代號或名稱，例如 2330、聯一光" aria-label="搜尋股票" autocomplete="off" />
        <datalist id="sa-stocks"></datalist>
        <button type="submit" class="btn btn-accent">分析</button>
      </form>`;
    el.dataset.ready = '1';
  }
  const list = el.querySelector<HTMLDataListElement>('#sa-stocks')!;
  const want = ctx.directory ? 'dir' : 'pool';
  if (list.dataset.src !== want) {
    const items = ctx.directory?.stocks ?? ctx.universe.stocks;
    list.innerHTML = items.map((x) => `<option value="${x.code} ${esc(x.name)}"></option>`).join('');
    list.dataset.src = want;
  }
  const ext = ctx.external;
  const ind = s && !ext ? ctx.metrics.industryById.get(s.industryId)?.name : ext?.entry.industry;
  const market = ext ? (ext.entry.market === 'otc' ? '上櫃' : '上市') : '';
  setHtml(
    el.querySelector<HTMLElement>('.sa-id')!,
    `<p class="eyebrow">個股分析 · ${esc(code)}${market ? ` · ${market}` : ''}${ind ? ` · ${esc(ind)}` : ''}</p>
     <h2 class="sa-name">${esc(s?.name ?? code)}</h2>`,
  );
  setHtml(el.querySelector<HTMLElement>('.sa-quote')!, s ? quoteHtml(s, ext) : '');
}

function quoteHtml(s: StockMetrics, ext?: ExternalStock): string {
  const d = dirCls(s.change);
  const meta = ext
    ? `成交 ${yi(s.turnover, 2)}・${ext.live ? '即時報價' : `${ext.asOf.slice(5).replace('-', '/')} 收盤`}・不在熱力圖股票池，沒有資金流`
    : `成交 ${yi(s.turnover, 1)}・資金流 <em class="${dirCls(s.flow)}">${signedYi(s.flow, 1)}</em>`;
  return `<b class="num">${price(s.price)}</b>
    <span class="num ${d}">${s.change >= 0 ? '▲' : '▼'} ${price(Math.abs(s.change))}（${pct(s.changePct)}）</span>
    <span class="sa-meta num">${meta}</span>`;
}

// ---------------------------------------------------------------- K 線圖

function renderChartHead(el: HTMLElement, ctx: StockPageContext, tech: TechReport | null, total = 0): void {
  const lastOf = (arr: (number | null)[] | undefined) => {
    const v = arr?.[arr.length - 1];
    return v == null ? '—' : price(v);
  };
  const SRC: Record<DailySeries['source'], string> = {
    official: '證交所／櫃買每日收盤',
    fugle: '富果日 K',
    mock: '模擬行情（示意走勢）',
    none: '沒有真實日 K',
  };
  const src = ctx.daily === undefined ? '載入中…' : `${SRC[ctx.daily.source]}${ctx.daily.source === 'official' && ctx.daily.note ? '（富果日 K 沒抓到）' : ''}`;
  // 勾選框只建立一次，之後只更新標題與圖例，避免每秒重畫打斷點擊
  if (!el.dataset.ready) {
    el.innerHTML = `<div class="kc-title"></div>
      <div class="kc-toggles" role="group" aria-label="圖上顯示的線">
        <label class="kc-toggle"><input type="checkbox" data-line="ma" /><svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2"></line></svg>MA</label>
        <label class="kc-toggle"><input type="checkbox" data-line="ema" /><svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke="currentColor" stroke-width="1.8"></line></svg>EMA</label>
        <label class="kc-toggle" title="自動畫出通道、W 底 / M 頭、頭肩、三角形、波浪、跳空缺口、爆量"><input type="checkbox" data-line="pat" /><svg width="16" height="8" aria-hidden="true"><polyline points="0,7 5,1 9,5 16,0" fill="none" stroke="currentColor" stroke-width="1.6"></polyline></svg>型態</label>
      </div>
      <ul class="ma-legend" aria-label="均線：虛線為 MA，實線為 EMA"></ul>`;
    for (const box of el.querySelectorAll<HTMLInputElement>('[data-line]')) {
      const key = box.dataset.line as 'ma' | 'ema' | 'pat';
      box.checked = lineVis[key];
      box.addEventListener('change', () => {
        lineVis[key] = box.checked;
        try {
          localStorage.setItem(LINES_KEY, JSON.stringify(lineVis));
        } catch {
          /* 無法儲存時只在這次有效 */
        }
        redrawChart?.();
      });
    }
    el.dataset.ready = '1';
  }
  const range =
    total > 1
      ? `<span class="k-range" title="滑鼠滾輪或兩指縮放、拖曳平移、雙擊還原">${kView.count} / ${total} 根${kView.right > 0 ? `・往前 ${kView.right} 根` : ''}・滾輪縮放、拖曳平移、雙擊還原</span>`
      : '';
  setHtml(el.querySelector<HTMLElement>('.kc-title')!, `<h2 class="panel-title">日 K 線 <small>${src}</small></h2>${range}`);
  const vals = (n: MaPeriod) =>
    [lineVis.ma ? `MA <b>${lastOf(tech?.series.ma[n])}</b>` : '', lineVis.ema ? `EMA <b>${lastOf(tech?.series.ema[n])}</b>` : '']
      .filter(Boolean)
      .join(' · ');
  const legend =
    lineVis.ma || lineVis.ema
      ? MA_PERIODS.map(
          (n) => `<li>${lineIcon(MA_COLORS[n])}<span>${n}（${MA_NAME[n]}）</span><span class="ma-vals num">${vals(n)}</span></li>`,
        ).join('')
      : '<li class="ma-key">均線已隱藏</li>';
  setHtml(el.querySelector<HTMLElement>('.ma-legend')!, legend);
}

// ---------------------------------------------------------------- 載入動畫

/**
 * 「拉普拉斯核心」載入動畫：中央的眼睛代表拉普拉斯之惡魔，外圈資料環旋轉，
 * 下方 K 棒逐根長出，旁邊列出目前的步驟與已等待時間。
 * 只建立一次 DOM，之後每秒只更新文字，動畫才不會被重畫打斷。
 */
const BIAS_WORD: Record<Bias, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };

/** 型態面板：偵測到的型態、後續情境（什麼條件會怎麼走），以及型態辭典。 */
function renderPatterns(el: HTMLElement, patterns: Pattern[], ctx: StockPageContext, total: number): void {
  if (!el.dataset.ready) {
    el.innerHTML = `<h2 class="panel-title">型態辨識 <small>依近一年日 K 自動判斷，僅供參考</small></h2>
      <div class="pat-list"></div>
      <details class="pat-guide"><summary>型態辭典：什麼條件會形成什麼圖、之後常見的走法</summary>
        <div class="pat-guide-grid">${PATTERN_GUIDE.map(
          (g) => `<div class="pg-item"><b class="tilt-text-${g.bias}">${esc(g.name)}</b>
            <p><span>形狀</span>${esc(g.shape)}</p><p><span>關鍵</span>${esc(g.when)}</p><p><span>走法</span>${esc(g.then)}</p></div>`,
        ).join('')}</div>
        <p class="disclaimer">型態是用固定規則從歷史價格找出來的，同一段走勢可能有不同解讀；假突破、假跌破也很常見，請搭配量能與基本面判斷。</p>
      </details>`;
    el.addEventListener('change', (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-pat]');
      if (!box) return;
      if (box.checked) hiddenPatterns.delete(box.dataset.pat!);
      else hiddenPatterns.add(box.dataset.pat!);
      try {
        localStorage.setItem(PAT_HIDDEN_KEY, JSON.stringify([...hiddenPatterns]));
      } catch {
        /* 無法儲存時只在這次有效 */
      }
      redrawChart?.();
    });
    el.dataset.ready = '1';
  }
  const list = el.querySelector<HTMLElement>('.pat-list')!;
  if (ctx.daily === undefined) return setHtml(list, '<p class="muted">日 K 載入後自動辨識型態。</p>');
  if (total < 30) return setHtml(list, '<p class="muted">日 K 不足 30 根，還無法辨識型態。</p>');
  if (!patterns.length) return setHtml(list, '<p class="muted">近期沒有明確的型態（走勢沒有形成可辨識的轉折組合）。</p>');
  const icon: Record<Bias, string> = { bull: '▲', bear: '▼', neutral: '●' };
  setHtml(
    list,
    patterns
      .map(
        (p) => `<article class="pat-card">
          <header>
            <span class="pat-swatch" style="background:${PATTERN_COLORS[p.id]}"></span>
            <b>${esc(p.name)}</b>
            <span class="tilt tilt-${p.bias}">${esc(p.status)}・${BIAS_WORD[p.bias]}</span>
            <label class="pat-show"><input type="checkbox" data-pat="${p.id}" ${hiddenPatterns.has(p.id) ? '' : 'checked'} />畫在圖上</label>
          </header>
          <p class="pat-summary">${esc(p.summary)}</p>
          <ul class="pat-scen">${p.scenarios
            .map((sc) => `<li class="pt-${sc.bias}"><i>${icon[sc.bias]}</i><span><b>若</b>${esc(sc.when)}</span><span class="pat-then">→ ${esc(sc.then)}</span></li>`)
            .join('')}</ul>
        </article>`,
      )
      .join(''),
  );
}

function renderLoader(el: HTMLElement, ctx: StockPageContext, compact = false): void {
  const kind = compact ? 'compact' : 'full';
  const fugle = ctx.dailySource === 'fugle';
  if (el.dataset.loader !== kind) {
    delete el.dataset.html;
    const candles = [0.55, 0.35, 0.7, 0.5, 0.85, 0.6, 0.95, 0.75]
      .map((hgt, i) => {
        const up = i % 3 !== 1;
        const h = 8 + hgt * 26;
        return `<rect class="lc-candle ${up ? 'up' : 'down'}" x="${20 + i * 15}" y="${150 - h}" width="8" height="${h}" rx="2" style="animation-delay:${i * 0.18}s"></rect>`;
      })
      .join('');
    const svg = `<svg class="lc-svg" viewBox="0 0 160 160" aria-hidden="true">
      <defs>
        <linearGradient id="lc-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#8b7bff"></stop></linearGradient>
        <radialGradient id="lc-eye" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#e9fdff"></stop><stop offset="0.45" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#8b7bff" stop-opacity="0"></stop></radialGradient>
      </defs>
      <g class="lc-core">
        <circle class="lc-ring lc-ring-1" cx="80" cy="64" r="52" stroke="url(#lc-g)"></circle>
        <circle class="lc-ring lc-ring-2" cx="80" cy="64" r="40" stroke="url(#lc-g)"></circle>
        <g class="lc-orbit"><circle cx="80" cy="12" r="3"></circle><circle cx="132" cy="64" r="2"></circle><circle cx="43" cy="101" r="2.4"></circle></g>
        <circle class="lc-glow" cx="80" cy="64" r="24" fill="url(#lc-eye)"></circle>
        <circle class="lc-pupil" cx="80" cy="64" r="6"></circle>
        <line class="lc-scan" x1="22" x2="138" y1="64" y2="64"></line>
      </g>
      ${compact ? '' : candles}
    </svg>`;
    const steps = [
      ['已排入優先查詢', 'done'],
      [fugle ? '向富果下載一年日 K' : ctx.dailySource === 'official' ? '讀取證交所／櫃買每日收盤' : '產生示意日 K', 'active'],
      ['計算 MA・EMA・RSI・MACD・KD', 'wait'],
      ['推演綜合判斷', 'wait'],
    ]
      .map(([t, st]) => `<li class="lc-step is-${st}"><i aria-hidden="true"></i>${t}</li>`)
      .join('');
    el.innerHTML = `<div class="lc ${compact ? 'is-compact' : ''}" role="status" aria-live="polite">
      ${svg}
      <div class="lc-text">
        <p class="lc-title">拉普拉斯核心<span>解析中</span></p>
        ${compact ? '' : `<ol class="lc-steps">${steps}</ol>`}
        <p class="lc-elapsed"></p>
      </div>
    </div>`;
    el.dataset.loader = kind;
  }
  const sec = ctx.dailyStartedAt ? Math.max(0, Math.floor((Date.now() - ctx.dailyStartedAt) / 1000)) : 0;
  const note =
    fugle && sec >= 15 ? '・富果每分鐘最多 60 次查詢，背景還在下載熱力圖資料，請稍候' : '';
  const t = el.querySelector('.lc-elapsed');
  if (t) t.textContent = `已等待 ${sec} 秒${note}`;
}

function renderKChart(el: HTMLElement, code: string, all: Candle[], tech: TechReport | null, ctx: StockPageContext, patterns: Pattern[] = []): void {
  if (el.dataset.hover) return;
  if (ctx.daily === undefined) return renderLoader(el, ctx);
  delete el.dataset.loader;
  if (all.length < 2) {
    const note = ctx.daily.note ? `<p class="kchart-note">${esc(ctx.daily.note)}</p>` : '';
    el.innerHTML = `<div class="kchart-empty"><p>還沒有這檔股票的真實日 K。</p>${note}
      <p class="muted">證交所／櫃買的每日收盤資料由系統每天自動累積、回補一年；在選單填入富果 API 金鑰也可以直接看真實日 K。
      為了不誤導判斷，這裡不用示意走勢代替。</p></div>`;
    return;
  }
  bindZoom(el);
  // 換股票時回到預設範圍
  if (code !== kView.code) {
    kView.code = code;
    kView.count = DEFAULT_BARS;
    kView.right = 0;
  }
  clampView(all.length);
  const N = kView.count;
  const off = all.length - kView.right - N;
  const candles = all.slice(off, off + N);
  const w = Math.max(320, el.clientWidth);
  const h = Math.max(260, el.clientHeight);
  const pad = { l: 8, r: 56, t: 10, b: 22 };
  kLayout = { plotL: pad.l, plotW: Math.max(1, w - pad.l - pad.r), total: all.length };
  const volH = Math.round((h - pad.t - pad.b) * 0.2);
  const gap = 10;
  const priceBottom = h - pad.b - volH - gap;

  const x = scaleBand<number>().domain(candles.map((_, i) => i)).range([pad.l, w - pad.r]).padding(0.28);
  const ma = tech?.series;
  // 只把有顯示的均線算進縱軸範圍
  const maVals = ma
    ? MA_PERIODS.flatMap((n) => [...(lineVis.ma ? [ma.ma[n]] : []), ...(lineVis.ema ? [ma.ema[n]] : [])]).flatMap((arr) =>
        arr.slice(off, off + N).filter((v): v is number => v != null),
      )
    : [];
  const lo = Math.min(...candles.map((c) => c.low), ...maVals);
  const hi = Math.max(...candles.map((c) => c.high), ...maVals);
  const y = scaleLinear().domain([lo, hi]).nice(5).range([priceBottom, pad.t]);
  const vMax = Math.max(...candles.map((c) => c.volume), 1);
  const yv = scaleLinear().domain([0, vMax]).range([h - pad.b, h - pad.b - volH]);
  const bw = x.bandwidth();
  const cx = (i: number) => x(i)! + bw / 2;
  const up = ctx.pal.up.strong;
  const down = ctx.pal.down.strong;
  const colorOf = (c: Candle) => (c.close >= c.open ? up : down);

  const maPath = (arr: (number | null)[] | undefined) => {
    if (!arr) return '';
    let d = '';
    arr.slice(off, off + N).forEach((v, i) => {
      if (v == null) return;
      d += `${d ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };

  // 月份標籤：每個月第一根 K 棒
  const months: Array<{ i: number; label: string }> = [];
  candles.forEach((c, i) => {
    const m = c.date.slice(5, 7);
    if (i !== 0 && candles[i - 1].date.slice(5, 7) === m) return;
    // 太擠時（例如手機）略過離前一個標籤太近的月份
    const prev = months[months.length - 1];
    if (prev && cx(i) - cx(prev.i) < 30) months.pop();
    months.push({ i, label: `${Number(m)}月` });
  });

  const ticks = y.ticks(5);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const tickFmt = (t: number) => (step >= 1 ? num(t, 0) : step >= 0.1 ? num(t, 1) : num(t, 2));
  const last = candles[candles.length - 1];
  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${N} 根日 K 線、均線與成交量（滾輪或兩指縮放，拖曳平移）">
    ${ticks
      .map(
        (t) =>
          `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"></line>` +
          // 和最新價標籤太近時省略刻度文字，避免重疊
          (Math.abs(y(t) - y(all[all.length - 1].close)) < 13 ? '' : `<text class="axis" x="${w - pad.r + 6}" y="${y(t) + 4}">${tickFmt(t)}</text>`),
      )
      .join('')}
    ${candles
      .map((c, i) => {
        const col = colorOf(c);
        const top = y(Math.max(c.open, c.close));
        const bh = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        return `<line x1="${cx(i)}" x2="${cx(i)}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"></line>
          <rect x="${x(i)}" y="${top}" width="${bw}" height="${bh}" rx="${Math.min(2, bw / 3)}" fill="${col}"></rect>
          <rect x="${x(i)}" y="${yv(c.volume)}" width="${bw}" height="${Math.max(0, h - pad.b - yv(c.volume))}" rx="${Math.min(2, bw / 3)}" fill="${col}" opacity="0.45"></rect>`;
      })
      .join('')}
    ${[...MA_PERIODS]
      .reverse()
      .map(
        (n) =>
          (lineVis.ma ? `<path d="${maPath(ma?.ma[n])}" fill="none" stroke="${MA_COLORS[n]}" stroke-width="1.4" stroke-dasharray="5 4"></path>` : '') +
          (lineVis.ema ? `<path d="${maPath(ma?.ema[n])}" fill="none" stroke="${MA_COLORS[n]}" stroke-width="1.8"></path>` : ''),
      )
      .join('')}
    ${tech && !(lineVis.pat && patterns.length) ? levelLine(tech.resistance, '壓力') + levelLine(tech.support, '支撐') : ''}
    ${lineVis.pat ? patternLayer() : ''}
    <text class="axis strong" x="${w - pad.r + 6}" y="${y(last.close) + 4}">${price(last.close)}</text>
    <text class="axis" x="${pad.l}" y="${h - pad.b - volH - 2}">成交量</text>
    ${months.map((m) => `<text class="axis" x="${cx(m.i)}" y="${h - 6}" text-anchor="middle">${m.label}</text>`).join('')}
    <line class="cross" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"></line>
    <rect class="hit" x="${pad.l}" y="0" width="${w - pad.l - pad.r}" height="${h}" fill="transparent"></rect>
  </svg><div class="k-tip glass" hidden></div>`;

  /** 型態疊圖：只畫在價格區，超出範圍的部分裁掉。 */
  function patternLayer(): string {
    const step = x.step();
    const xAt = (gi: number) => cx(0) + (gi - off) * step;
    const right = off + N - 1 + 2;
    const shown = patterns.filter((p) => !hiddenPatterns.has(p.id));
    if (!shown.length) return '';
    let volMarks = '';
    const body = shown
      .map((p) => {
        const col = PATTERN_COLORS[p.id];
        const lines = p.lines
          .map((l) => {
            let [i2, v2] = l.b;
            if (l.extend && right > i2) {
              const slope = (l.b[1] - l.a[1]) / Math.max(1, l.b[0] - l.a[0]);
              v2 = l.b[1] + slope * (right - l.b[0]);
              i2 = right;
            }
            // 手機寬度太窄時不標線名，避免和價格標籤擠在一起
            const lab =
              l.label && w >= 520 && l.b[0] >= off && l.b[0] < off + N
                ? `<text class="pat-label" x="${xAt(i2) - 4}" y="${y(v2) - 5}" text-anchor="end" fill="${col}">${esc(l.label)}</text>`
                : '';
            return `<line x1="${xAt(l.a[0])}" y1="${y(l.a[1])}" x2="${xAt(i2)}" y2="${y(v2)}" stroke="${col}" stroke-width="${l.dash ? 1.2 : 1.6}" ${l.dash ? 'stroke-dasharray="6 4"' : ''} opacity="0.9"></line>${lab}`;
          })
          .join('');
        // 量價的爆量標記畫在成交量柱上（不在價格區，避免和 K 線、缺口標籤擠在一起）
        if (p.id === 'volume') {
          let lastLabel = -Infinity;
          volMarks += p.points
            .filter((pt) => pt.i >= off && pt.i < off + N)
            .map((pt) => {
              const px = xAt(pt.i);
              const top = yv(all[pt.i].volume);
              // 相鄰的爆量只標一次文字，避免重疊
              const label = px - lastLabel > 40;
              if (label) lastLabel = px;
              return `<path d="M${px - 4},${top - 9} L${px + 4},${top - 9} L${px},${top - 3} Z" fill="${col}"></path>${
                label ? `<text class="pat-point" x="${px}" y="${top - 12}" text-anchor="middle" fill="${col}">爆量${esc(pt.label === '爆量' ? '' : pt.label)}</text>` : ''
              }`;
            })
            .join('');
          return '';
        }
        const pts = p.points
          .filter((pt) => pt.i >= off && pt.i < off + N)
          .map((pt) => {
            const px = xAt(pt.i);
            const py = y(pt.p) + (pt.pos === 'above' ? -14 : 16);
            return `<circle cx="${px}" cy="${y(pt.p)}" r="3" fill="${col}"></circle>
              <text class="pat-point" x="${px}" y="${py}" text-anchor="middle" fill="${col}">${esc(pt.label)}</text>`;
          })
          .join('');
        const zones = (p.zones ?? [])
          .filter((z) => z.i < off + N)
          .map((z) => {
            const x1 = Math.max(xAt(z.i) - step / 2, pad.l);
            const x2 = xAt(right);
            const top = y(z.hi);
            const hgt = Math.max(1.5, y(z.lo) - y(z.hi));
            const lab = w >= 520 && z.i >= off ? `<text class="pat-label" x="${x1 + 3}" y="${top - 3}" fill="${col}">${esc(z.label)}</text>` : '';
            return `<rect x="${x1}" y="${top}" width="${Math.max(0, x2 - x1)}" height="${hgt}" fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-opacity="0.5" stroke-dasharray="3 3"></rect>${lab}`;
          })
          .join('');
        return `<g class="pat pat-${p.id}">${zones}${lines}${pts}</g>`;
      })
      .join('');
    return `<defs><clipPath id="kclip"><rect x="${pad.l}" y="${pad.t}" width="${w - pad.l - pad.r}" height="${priceBottom - pad.t}"></rect></clipPath></defs><g clip-path="url(#kclip)">${body}</g>${volMarks}`;
  }

  function levelLine(v: number, label: string): string {
    if (v < y.domain()[0] || v > y.domain()[1]) return '';
    return `<line class="level" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"></line>
      <text class="axis level-label" x="${pad.l + 4}" y="${y(v) - 4}">${label} ${price(v)}</text>`;
  }

  const svg = select(el).select('svg');
  const tip = el.querySelector<HTMLDivElement>('.k-tip')!;
  const centers = candles.map((_, i) => cx(i));
  const find = bisector<number, number>((v) => v).center;
  svg
    .select('rect.hit')
    .on('mousemove', (e: MouseEvent) => {
      const [mx] = pointer(e);
      const i = find(centers, mx);
      const c = candles[i];
      if (!c) return;
      el.dataset.hover = '1';
      svg.select('line.cross').attr('x1', cx(i)).attr('x2', cx(i)).attr('visibility', 'visible');
      const prev = i > 0 ? candles[i - 1].close : all[off - 1]?.close;
      const chg = prev ? ((c.close - prev) / prev) * 100 : 0;
      const mv = (arr: (number | null)[] | undefined) => {
        const v = arr?.[off + i];
        return v == null ? '—' : price(v);
      };
      tip.hidden = false;
      tip.innerHTML = `<b>${c.date}</b>
        <dl><dt>開</dt><dd>${price(c.open)}</dd><dt>高</dt><dd>${price(c.high)}</dd><dt>低</dt><dd>${price(c.low)}</dd>
        <dt>收</dt><dd class="${dirCls(chg)}">${price(c.close)}（${pct(chg)}）</dd><dt>量</dt><dd>${num(c.volume)} 張</dd>
        ${
          lineVis.ma || lineVis.ema
            ? MA_PERIODS.map(
                (n) =>
                  `<dt><i style="background:${MA_COLORS[n]}"></i>${n} 日</dt><dd>${[lineVis.ma ? mv(ma?.ma[n]) : '', lineVis.ema ? mv(ma?.ema[n]) : ''].filter(Boolean).join(' / ')}</dd>`,
              ).join('') + `<dt></dt><dd class="muted">${[lineVis.ma ? 'MA' : '', lineVis.ema ? 'EMA' : ''].filter(Boolean).join(' / ')}</dd>`
            : ''
        }</dl>`;
      const left = cx(i) + 14 + tip.offsetWidth > w - pad.r ? cx(i) - 14 - tip.offsetWidth : cx(i) + 14;
      tip.style.transform = `translate(${Math.max(4, left)}px, ${pad.t + 6}px)`;
    })
    .on('mouseleave', () => {
      delete el.dataset.hover;
      svg.select('line.cross').attr('visibility', 'hidden');
      tip.hidden = true;
    });
}

// ---------------------------------------------------------------- 綜合摘要

function renderSummary(el: HTMLElement, sum: Summary): void {
  const pos = ((sum.score + 100) / 200) * 100;
  el.innerHTML = `<h2 class="panel-title">綜合摘要</h2>
    <div class="gauge" role="img" aria-label="綜合評分 ${sum.score}，${sum.label}">
      <div class="gauge-head"><b class="gauge-label tilt-text-${sum.tilt}">${sum.label}</b><span class="num">${sum.score > 0 ? '+' : ''}${sum.score}</span></div>
      <div class="gauge-track"><i style="left:${pos.toFixed(1)}%"></i></div>
      <div class="gauge-scale"><span>偏空 −100</span><span>0</span><span>+100 偏多</span></div>
    </div>
    <ul class="sum-points">${sum.points.map((p) => `<li class="pt-${p.tilt}"><i aria-hidden="true">${TILT_ICON[p.tilt]}</i><span>${esc(p.text)}</span></li>`).join('')}</ul>
    <p class="disclaimer">依指標規則自動整理，不構成投資建議。</p>`;
}

// ---------------------------------------------------------------- 五大策略

function radar(scores: StrategyScore[]): string {
  const size = 220;
  const c = size / 2;
  const R = 74;
  const n = scores.length;
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r];
  };
  const ring = (k: number) => scores.map((_, i) => pt(i, R * k).map((v) => v.toFixed(1)).join(',')).join(' ');
  const poly = scores.map((s, i) => pt(i, R * Math.max(0.04, s.score)).map((v) => v.toFixed(1)).join(',')).join(' ');
  return `<svg class="radar" viewBox="-44 -4 ${size + 88} ${size + 8}" role="img" aria-label="五大策略符合度">
    ${[0.25, 0.5, 0.75, 1].map((k) => `<polygon class="radar-ring" points="${ring(k)}"></polygon>`).join('')}
    ${scores.map((_, i) => { const [x, y] = pt(i, R); return `<line class="radar-axis" x1="${c}" y1="${c}" x2="${x}" y2="${y}"></line>`; }).join('')}
    <polygon class="radar-area" points="${poly}"></polygon>
    ${scores.map((s, i) => { const [x, y] = pt(i, R * Math.max(0.04, s.score)); return `<circle class="radar-dot" cx="${x}" cy="${y}" r="4"></circle>`; }).join('')}
    ${scores
      .map((s, i) => {
        const [x, y] = pt(i, R + 22);
        const anchor = Math.abs(x - c) < 8 ? 'middle' : x > c ? 'start' : 'end';
        return `<text class="radar-label" x="${x}" y="${y + 4}" text-anchor="${anchor}">${esc(s.strategy.name)}</text>`;
      })
      .join('')}
  </svg>`;
}

function renderScores(el: HTMLElement, scores: StrategyScore[]): void {
  if (!el.dataset.bound) {
    // toggle 事件不會冒泡，用捕獲階段記住哪些項目是展開的
    el.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        const id = d.dataset.strategy;
        if (!id) return;
        if (d.open) openStrategies.add(id);
        else openStrategies.delete(id);
      },
      true,
    );
    el.dataset.bound = '1';
  }
  const best = [...scores].sort((a, b) => b.score - a.score)[0];
  setHtml(el, `<h2 class="panel-title">五大策略評分 <small>最接近：${esc(best.strategy.name)}</small></h2>
    <div class="score-wrap">${radar(scores)}</div>
    <div class="score-list">${scores
      .map(
        (s) => `<details class="score-item${s.matched ? ' is-match' : ''}" data-strategy="${s.strategy.id}"${openStrategies.has(s.strategy.id) ? ' open' : ''}>
          <summary><span class="si-name">${esc(s.strategy.name)}</span>
            <span class="si-bar"><i style="width:${(s.score * 100).toFixed(0)}%"></i></span>
            <span class="si-n num">${s.strategy.match === 'any' ? (s.passed ? '符合' : '—') : `${s.passed} / ${s.checks.length}`}</span></summary>
          <ul>${s.strategy.criteria
            .map((c, i) => `<li class="${s.checks[i].pass ? 'pass' : 'fail'}"><i aria-hidden="true">${s.checks[i].pass ? '✓' : '✗'}</i><span>${esc(c.label)}</span><em class="num">${esc(s.checks[i].value)}</em></li>`)
            .join('')}</ul>
          <button type="button" class="btn btn-sm" data-goto-strategy="${s.strategy.id}">看同策略的其他股票</button>
        </details>`,
      )
      .join('')}</div>`);
}

// ---------------------------------------------------------------- 技術指標

function renderTech(el: HTMLElement, tech: TechReport | null, loading: boolean, ctx?: StockPageContext): void {
  if (!tech && loading && ctx) {
    if (el.dataset.loader !== 'compact') {
      el.innerHTML = '<h2 class="panel-title">技術指標</h2><div class="lc-slot"></div>';
      el.dataset.loader = 'compact';
    }
    renderLoader(el.querySelector<HTMLElement>('.lc-slot')!, ctx, true);
    return;
  }
  delete el.dataset.loader;
  if (!tech) {
    el.innerHTML = `<h2 class="panel-title">技術指標</h2><p class="muted">${loading ? '日 K 載入中…' : '日 K 資料不足，無法計算。'}</p>`;
    return;
  }
  el.innerHTML = `<h2 class="panel-title">技術指標</h2>
    <table class="tech-table"><tbody>${tech.signals
      .map((s) => `<tr><th>${esc(s.name)}</th><td class="num">${esc(s.value)}</td><td>${tiltTag(s.tilt)}</td><td class="muted">${esc(s.note)}</td></tr>`)
      .join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- 基本面、籌碼、同業

/** 區間條：最低到最高，標出目前位置（和可選的參考線）。 */
function rangeBar(o: {
  title: string;
  lo: number;
  hi: number;
  current: number;
  fmt: (v: number) => string;
  verdict: string;
  verdictTilt: Tilt;
  note: string;
  zones?: [number, number];
  ref?: { value: number; label: string };
}): string {
  const at = (v: number) => Math.max(0, Math.min(100, ((v - o.lo) / Math.max(1e-9, o.hi - o.lo)) * 100));
  const zones = o.zones
    ? `<i class="rb-zone rb-cheap" style="left:0;width:${at(o.zones[0])}%"></i>
       <i class="rb-zone rb-fair" style="left:${at(o.zones[0])}%;width:${at(o.zones[1]) - at(o.zones[0])}%"></i>
       <i class="rb-zone rb-rich" style="left:${at(o.zones[1])}%;width:${100 - at(o.zones[1])}%"></i>`
    : '<i class="rb-zone rb-fair" style="left:0;width:100%"></i>';
  return `<div class="rb">
    <div class="rb-head"><span>${o.title}</span><b class="tilt-text-${o.verdictTilt}">${o.verdict}</b></div>
    <div class="rb-track">${zones}
      ${o.ref ? `<i class="rb-ref" style="left:${at(o.ref.value)}%" title="${o.ref.label} ${o.fmt(o.ref.value)}"></i>` : ''}
      <i class="rb-now" style="left:${at(o.current)}%"></i>
    </div>
    <div class="rb-scale num"><span>${o.fmt(o.lo)}</span><span>${o.fmt(o.hi)}</span></div>
    <p class="rb-note">${o.note}</p>
  </div>`;
}

function valuationBlock(v: StockView): string {
  const f = v.f;
  const parts: string[] = [];
  const band = f.pe5y;
  if (band && v.pe > 0 && Number.isFinite(v.pe) && v.pePct !== null) {
    const pctile = Math.round(v.pePct * 100);
    const verdict = v.pePct <= 0.3 ? '偏便宜' : v.pePct >= 0.7 ? '偏貴' : '合理';
    parts.push(
      rangeBar({
        title: '本益比位置（和自己近 5 年比）',
        lo: Math.min(band[0], v.pe),
        hi: Math.max(band[4], v.pe),
        current: v.pe,
        fmt: (x) => `${x.toFixed(1)} 倍`,
        verdict,
        verdictTilt: v.pePct <= 0.3 ? 'bull' : v.pePct >= 0.7 ? 'bear' : 'neutral',
        zones: [band[1], band[3]],
        ref: v.industryPe ? { value: v.industryPe, label: '產業中位數' } : undefined,
        note: `目前 <b>${v.pe.toFixed(1)} 倍</b>，過去 5 年有 ${pctile}% 的時間比現在便宜。5 年中位數 ${band[2].toFixed(1)} 倍${v.industryPe ? `，產業中位數 ${v.industryPe.toFixed(1)} 倍（灰線）` : ''}。`,
      }),
    );
  }
  const pos = Math.round(v.pos3y * 100);
  parts.push(
    rangeBar({
      title: '股價位階（和自己近 3 年比）',
      lo: Math.min(f.low3y, v.stock.price),
      hi: Math.max(f.high3y, v.stock.price),
      current: v.stock.price,
      fmt: (x) => price(x),
      verdict: v.pos3y <= 0.3 ? '低檔' : v.pos3y >= 0.7 ? '高檔' : '中間',
      verdictTilt: v.pos3y <= 0.3 ? 'bull' : v.pos3y >= 0.7 ? 'bear' : 'neutral',
      zones: [f.low3y + (f.high3y - f.low3y) * 0.3, f.low3y + (f.high3y - f.low3y) * 0.7],
      note: `目前 <b>${price(v.stock.price)}</b>，位在近 3 年最低到最高之間的 ${pos}% 位置。`,
    }),
  );
  return `<h3 class="d-sub">評價位置 <small>用這檔股票自己的歷史判斷，不用統一標準</small></h3>${parts.join('')}`;
}

function renderFund(el: HTMLElement, v: StockView, ctx: StockPageContext, fund: Fundamentals): void {
  const s = v.stock;
  const f = v.f;
  const fundamentals = ctx.external ? new Map(ctx.fundamentals).set(s.code, fund) : ctx.fundamentals;
  // 股票池以外的股票沒有資金流資料，不拿來比
  const peers = peerStats(s, ctx.metrics, fundamentals).filter((p) => !(ctx.external && p.label === '今日資金流'));
  const rating = peerRating(peers);
  const ext = ctx.external;
  const realRatios = ext && (ext.entry.pe || ext.entry.yieldPct !== undefined);
  const src = ctx.realSrc
    ? ctx.realSrc
    : realRatios
    ? `本益比、殖利率為${ext!.entry.market === 'otc' ? '櫃買中心' : '證交所'} ${ext!.asOf.slice(5).replace('-', '/')} 資料，其餘模擬`
    : '模擬資料';
  setHtml(el, `<h2 class="panel-title">基本面與籌碼 <small>${src}</small></h2>
    <dl class="d-grid d-grid-4">
      ${kv('本益比', Number.isFinite(v.pe) && v.pe > 0 ? `${v.pe.toFixed(1)} 倍` : '—')}
      ${kv('殖利率', `${v.yieldPct.toFixed(2)}%`)}
      ${kv('EPS（近四季）', `${f.eps4q.toFixed(2)} 元`)}
      ${kv('EPS 年增', pct(f.epsYoY, 1), dirCls(f.epsYoY))}
      ${kv('毛利率變化', `${f.grossMarginChg >= 0 ? '+' : '−'}${Math.abs(f.grossMarginChg).toFixed(1)} 百分點`, dirCls(f.grossMarginChg))}
      ${kv('連續配息', `${f.dividendYears} 年`)}
      ${kv('法人', f.instBuyDays >= 0 ? `連買 ${f.instBuyDays} 天` : `連賣 ${-f.instBuyDays} 天`, dirCls(f.instBuyDays))}
      ${kv('千張大戶（4 週）', `${f.bigHolderChg >= 0 ? '+' : '−'}${Math.abs(f.bigHolderChg).toFixed(1)} 百分點`, dirCls(f.bigHolderChg))}
    </dl>
    ${valuationBlock(v)}
    <h3 class="d-sub">同業比較 <small>${esc(ctx.metrics.industryById.get(s.industryId)?.name ?? '')}・${peers[0]?.count ?? 0} 檔</small></h3>
    ${
      rating
        ? `<div class="peer-rating">
            <div><span class="pr-title">同業推薦度</span><b class="pr-label">${rating.label}</b></div>
            ${starsHtml(rating.stars)}<b class="pr-num num">${rating.stars.toFixed(1)}</b>
            <p class="pr-note">${esc(rating.note)}。只代表和同產業相比的相對位置，不是買賣建議。</p>
          </div>`
        : ''
    }
    <table class="peer-table">
      <thead><tr><th>指標</th><th>本股</th><th>同業中間值</th><th>同業評等</th></tr></thead>
      <tbody>${peers
        .map((p) => {
          const st = peerStars(p);
          const word = st >= 4 ? '優於同業' : st === 3 ? '和同業差不多' : '落後同業';
          return `<tr><td>${p.label}<small class="peer-hint">${p.hint}</small></td><td class="num">${p.format(p.value)}</td><td class="num muted">${p.format(p.median)}</td>
            <td>${starsHtml(st, 'stars-sm')}<span class="peer-word w-${st >= 4 ? 'good' : st === 3 ? 'mid' : 'weak'}">${word}</span>
            <small class="peer-hint num">第 ${p.rank} 名 / ${p.count} 檔</small></td></tr>`;
        })
        .join('')}</tbody>
    </table>`);
}

// ---------------------------------------------------------------- 新聞

function renderNews(el: HTMLElement, s: StockMetrics, f: Fundamentals, ctx: StockPageContext): void {
  const items = ctx.live ? [] : mockNews(s.code, s.name, f, ctx.today);
  const links = newsLinks(s.code);
  el.innerHTML = `<h2 class="panel-title">新聞 <small>${ctx.live ? '外部連結' : '示意新聞・關鍵字判斷利多利空'}</small></h2>
    ${
      items.length
        ? `<ul class="news-list">${items
            .map((n) => `<li><span class="news-date num">${n.date.slice(5)}</span><span class="news-title">${esc(n.title)}</span>${tiltTag(n.tilt)}</li>`)
            .join('')}</ul>`
        : '<p class="muted">即時新聞需要轉接服務，目前先提供外部連結。</p>'
    }
    <div class="news-links">${links.map((l) => `<a class="chip-btn" href="${l.href}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>`;
}
