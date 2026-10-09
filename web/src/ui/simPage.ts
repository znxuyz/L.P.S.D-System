/**
 * 拉普拉斯模擬盤頁面：選一個過去的日期當起點，用模擬帳戶一天一天回放歷史行情練習交易。
 * 圖表只畫到「目前這一天」為止，看不到未來；狀態存在這台裝置的瀏覽器（localStorage）。
 */
import { scaleBand, scaleLinear } from 'd3';
import { loadOfficialCandles } from '../data/candles';
import { loadTaiex } from '../data/chipSeries';
import { loadStockDirectory, searchDirectory, type DirEntry } from '../data/stockDirectory';
import { detectPatterns, type Bias } from '../domain/patterns';
import {
  LOT,
  advance,
  buildMarket,
  cancelOrder,
  equityOf,
  feeOf,
  newSim,
  placeOrder,
  reservedCash,
  summarize,
  taxOf,
  type ExRight,
  type Market,
  type Side,
  type SimState,
} from '../domain/sim';
import { sma, type Candle } from '../domain/technicals';
import { escapeHtml as esc, num, pct, price } from './format';

const KEY = 'lplc.sim.v1';
/** 交易日曆：0050 從 2003 年起每個交易日都有成交。 */
const CALENDAR_CODE = '0050';
/** 起點之前至少要有這麼多根日 K 給圖表與型態判斷用。 */
const WARMUP = 60;
const BARS = 120;

function load(): SimState | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SimState | null;
    return s?.v === 1 ? s : null;
  } catch {
    return null;
  }
}

function save(s: SimState | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* 無痕模式等情況存不了，只是重新整理後會重來 */
  }
}

function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const money = (v: number) => num(Math.round(v));
const BIAS: Record<Bias, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };

export class SimPage {
  private state: SimState | null = load();
  private readonly candles = new Map<string, Candle[] | null>();
  private readonly loading = new Map<string, Promise<Candle[] | null>>();
  private calendar: string[] | null | undefined;
  private dir: DirEntry[] = [];
  private taiex: Map<string, number> | null = null;
  private ex: ExRight[] = [];
  private exYears = new Set<number>();
  private market: Market = buildMarket(new Map());
  private busy = false;
  private started = false;
  private side: Side = 'buy';
  private unit: 'lot' | 'share' = 'lot';
  private msg = '';
  private hints = true;

  constructor(private readonly root: HTMLElement) {}

  /** 切到模擬盤時呼叫；第一次會下載交易日曆、股票目錄與加權指數。 */
  show(): void {
    this.build();
    if (!this.started) {
      this.started = true;
      void Promise.all([
        this.fetchCandles(CALENDAR_CODE).then((c) => (this.calendar = c?.map((x) => x.date) ?? null)),
        loadStockDirectory().then((d) => (this.dir = d?.stocks ?? [])),
        loadTaiex().then((t) => (this.taiex = t)),
      ]).then(() => this.prepare());
    }
    this.render();
  }

  // ------------------------------------------------------------ 資料

  private fetchCandles(code: string): Promise<Candle[] | null> {
    if (this.candles.has(code)) return Promise.resolve(this.candles.get(code)!);
    let p = this.loading.get(code);
    if (!p) {
      p = loadOfficialCandles(code).then((c) => {
        this.candles.set(code, c);
        this.loading.delete(code);
        this.rebuildMarket();
        return c;
      });
      this.loading.set(code, p);
    }
    return p;
  }

  private async fetchExRights(fromYear: number): Promise<void> {
    const thisYear = new Date().getFullYear();
    const todo: number[] = [];
    for (let y = fromYear; y <= thisYear; y++) if (!this.exYears.has(y)) todo.push(y);
    const rows = await Promise.all(
      todo.map((y) =>
        fetch(`data/exrights/${y}.json`, { cache: 'no-cache' })
          .then((r) => (r.ok ? (r.json() as Promise<ExRight[]>) : []))
          .catch(() => [] as ExRight[]),
      ),
    );
    for (const y of todo) this.exYears.add(y);
    this.ex.push(...rows.flat().filter((r) => Array.isArray(r)));
    this.rebuildMarket();
  }

  private rebuildMarket(): void {
    const series = new Map<string, Candle[]>();
    for (const [code, c] of this.candles) if (c) series.set(code, c);
    this.market = buildMarket(series, this.ex);
  }

  /** 目前用到的股票（觀看中、持有、委託中）都要有日 K。 */
  private neededCodes(): string[] {
    const s = this.state;
    if (!s) return [];
    return [...new Set([s.watch, ...Object.keys(s.holdings), ...s.orders.map((o) => o.code)])];
  }

  private async prepare(): Promise<void> {
    const s = this.state;
    if (s) {
      await Promise.all([...this.neededCodes().map((c) => this.fetchCandles(c)), this.fetchExRights(Number(s.settings.start.slice(0, 4)))]);
    }
    this.render();
  }

  private nameOf(code: string): string {
    return this.dir.find((d) => d.code === code)?.name ?? '';
  }

  // ------------------------------------------------------------ 操作

  private start(form: HTMLFormElement): void {
    const cal = this.calendar;
    if (!cal?.length) return;
    const fd = new FormData(form);
    const want = String(fd.get('start') || '');
    const capital = Math.max(10_000, Number(fd.get('capital')) || 1_000_000);
    const discount = Math.min(1, Math.max(0.1, Number(fd.get('discount')) || 0.6));
    const minIdx = Math.min(WARMUP, cal.length - 1);
    let idx = cal.findIndex((d) => d >= want);
    if (idx < 0) idx = cal.length - 1;
    idx = Math.max(idx, minIdx);
    const date = cal[idx];
    this.state = newSim({ start: date, capital, discount }, date, this.state?.watch ?? '2330');
    this.msg = '';
    save(this.state);
    void this.prepare();
  }

  private async step(n: number): Promise<void> {
    const s = this.state;
    const cal = this.calendar;
    if (!s || !cal || this.busy) return;
    this.busy = true;
    this.msg = '';
    this.render();
    try {
      await Promise.all(this.neededCodes().map((c) => this.fetchCandles(c)));
      let i = cal.indexOf(s.date);
      if (i < 0) i = cal.findIndex((d) => d > s.date) - 1;
      for (let k = 0; k < n && i + 1 < cal.length; k++) advance(s, this.market, cal[++i]);
      save(s);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async watch(q: string): Promise<void> {
    const s = this.state;
    if (!s || !q.trim()) return;
    const hit = searchDirectory(this.dir, q) ?? (/^\d{4,6}[A-Z]?$/.test(q.trim()) ? { code: q.trim() } : undefined);
    if (!hit) {
      this.msg = `找不到「${q}」`;
      return this.render();
    }
    s.watch = hit.code;
    this.msg = '';
    save(s);
    this.render();
    await this.fetchCandles(hit.code);
    this.render();
  }

  private order(form: HTMLFormElement): void {
    const s = this.state;
    if (!s) return;
    const fd = new FormData(form);
    const qty = Number(fd.get('qty'));
    const shares = Math.round(qty * (this.unit === 'lot' ? LOT : 1));
    const limitRaw = String(fd.get('limit') ?? '').trim();
    const limit = fd.get('type') === 'limit' && limitRaw ? Number(limitRaw) : undefined;
    if (fd.get('type') === 'limit' && !limitRaw) {
      this.msg = '限價單要填價格';
      return this.render();
    }
    const err = placeOrder(s, this.market, { code: s.watch, side: this.side, shares, limit });
    this.msg = err ?? `已委託：${this.side === 'buy' ? '買進' : '賣出'} ${s.watch} ${num(shares)} 股（${limit ? `限價 ${limit}` : '市價'}），下一個交易日成交`;
    if (!err) save(s);
    this.render();
  }

  private reset(): void {
    if (!confirm('結束這一局並清除模擬帳戶？')) return;
    this.state = null;
    this.msg = '';
    save(null);
    this.render();
  }

  // ------------------------------------------------------------ 畫面

  private build(): void {
    const root = this.root;
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="sim-head glass" id="sim-head"></div>
      <div class="sim-chart glass" id="sim-chart"></div>
      <div class="sim-order glass" id="sim-order"></div>
      <div class="sim-hold glass" id="sim-hold"></div>
      <div class="sim-equity glass" id="sim-equity"></div>
      <div class="sim-log glass" id="sim-log"></div>
      <div class="sim-setup glass" id="sim-setup"></div>`;
    root.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-sim]');
      if (!el) return;
      const a = el.dataset.sim!;
      if (a.startsWith('step')) void this.step(Number(a.slice(4)));
      else if (a === 'reset') this.reset();
      else if (a === 'buy' || a === 'sell') {
        this.side = a;
        this.render();
      } else if (a === 'lot' || a === 'share') {
        this.unit = a;
        this.render();
      } else if (a === 'cancel') {
        cancelOrder(this.state!, Number(el.dataset.id));
        save(this.state);
        this.render();
      } else if (a === 'watch') void this.watch(el.dataset.code!);
      else if (a === 'hints') {
        this.hints = !this.hints;
        this.render();
      } else if (a === 'random') {
        const cal = this.calendar;
        const input = root.querySelector<HTMLInputElement>('#sim-start');
        if (cal && input && cal.length > WARMUP + 40) input.value = cal[WARMUP + Math.floor(Math.random() * (cal.length - WARMUP - 40))];
      } else if (a === 'all') {
        const s = this.state;
        const qty = root.querySelector<HTMLInputElement>('#sim-qty');
        if (!s || !qty) return;
        const have = s.holdings[s.watch]?.shares ?? 0;
        if (this.side === 'sell') qty.value = String(this.unit === 'lot' ? Math.floor(have / LOT) : have);
        else {
          const px = this.market.lastClose(s.watch, s.date) ?? 0;
          const cash = s.cash - reservedCash(s, this.market);
          const sh = px ? Math.floor(cash / (px * 1.1 * (1 + 0.001425))) : 0;
          qty.value = String(this.unit === 'lot' ? Math.floor(sh / LOT) : sh);
        }
        this.renderEstimate();
      }
    });
    root.addEventListener('submit', (e) => {
      const form = e.target as HTMLFormElement;
      e.preventDefault();
      if (form.id === 'sim-setup-form') this.start(form);
      else if (form.id === 'sim-search') void this.watch(new FormData(form).get('q') as string);
      else if (form.id === 'sim-order-form') this.order(form);
    });
    root.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).closest('#sim-order-form')) this.renderEstimate();
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'type') {
        const lim = root.querySelector<HTMLInputElement>('#sim-limit');
        if (lim) lim.disabled = t.value !== 'limit';
        this.renderEstimate();
      }
    });
    // 視窗寬度改變時重畫圖表
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.render());
    }).observe(root);
    // → 鍵下一天（不在輸入框時）
    window.addEventListener('keydown', (e) => {
      if (!document.querySelector('.app.page-sim') || !this.state) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select') || document.querySelector('.laplace-intro')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        void this.step(e.shiftKey ? 5 : 1);
      }
    });
  }

  render(): void {
    if (!this.root.dataset.ready) return;
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    const s = this.state;
    this.root.classList.toggle('is-setup', !s);
    if (!s) {
      setHtml($('sim-setup'), this.setupHtml());
      return;
    }
    setHtml($('sim-head'), this.headHtml(s));
    this.renderChart($('sim-chart'), s);
    this.renderOrder($('sim-order'), s);
    setHtml($('sim-hold'), this.holdHtml(s));
    setHtml($('sim-equity'), this.equityHtml(s, Math.max(280, $('sim-equity').clientWidth - 36)));
    setHtml($('sim-log'), this.logHtml(s));
  }

  private setupHtml(): string {
    const cal = this.calendar;
    if (cal === undefined) return `<p class="muted">正在下載交易日曆⋯⋯</p>`;
    if (!cal?.length) return `<p>還沒有歷史日 K 資料，暫時不能開始模擬盤。</p>`;
    const min = cal[Math.min(WARMUP, cal.length - 1)];
    const max = cal[Math.max(0, cal.length - 2)];
    const def = cal[Math.max(WARMUP, cal.length - 250)];
    return `
      <p class="eyebrow">Laplace Replay</p>
      <h2 class="sim-title">拉普拉斯模擬盤</h2>
      <p class="sim-lead">回到過去的某一天，用一個模擬帳戶一天一天往前推進。你只看得到「那一天為止」的 K 線，
        收盤後下單、隔天開盤成交 —— 試試看在不知道未來的情況下，你的判斷能贏過大盤嗎？</p>
      <form class="sim-form" id="sim-setup-form">
        <label>起始日期<input type="date" name="start" id="sim-start" min="${min}" max="${max}" value="${def}" required /></label>
        <button type="button" class="btn" data-sim="random" title="隨機選一個過去的日期，避免記得之後的走勢">隨機日期</button>
        <label>本金（元）<input type="number" name="capital" min="10000" step="10000" value="1000000" /></label>
        <label>手續費折扣<input type="number" name="discount" min="0.1" max="1" step="0.01" value="0.6" /></label>
        <button type="submit" class="btn btn-accent">開始回放</button>
      </form>
      <ul class="sim-rules">
        <li>資料：證交所／櫃買每日收盤，可選 ${esc(min)} 到 ${esc(max)}（資料持續回補到 2020 年）。</li>
        <li>收盤後下單，<b>下一個交易日</b>成交：市價單用開盤價，限價單當天碰到才成交，沒碰到就取消。</li>
        <li>手續費 0.1425% × 折扣（整股最低 20 元、零股 1 元），賣出證交稅 0.3%（ETF 0.1%）。</li>
        <li>一價漲停買不到、一價跌停賣不掉；除息現金直接入帳、除權依參考價換算配股。</li>
        <li>帳戶存在這台裝置的瀏覽器，關掉網頁再回來可以接著玩。</li>
      </ul>`;
  }

  private headHtml(s: SimState): string {
    const m = this.market;
    const eq = equityOf(s, m);
    const ret = eq / s.settings.capital - 1;
    const t0 = this.taiex?.get(s.settings.start);
    const t1 = this.taiex?.get(s.date);
    const bench = t0 && t1 ? t1 / t0 - 1 : null;
    const cal = this.calendar ?? [];
    const end = cal.length > 0 && s.date >= cal[cal.length - 1];
    const dis = this.busy || end ? 'disabled' : '';
    const wd = '日一二三四五六'[new Date(`${s.date}T00:00:00Z`).getUTCDay()];
    return `
      <div class="sim-date">
        <p class="eyebrow">Laplace Replay · 第 ${s.equity.length - 1} 天</p>
        <p class="sim-day num">${esc(s.date)} <small>（${wd}）收盤後</small></p>
      </div>
      <dl class="sim-kpis">
        <div><dt>總資產</dt><dd class="num">${money(eq)}</dd></div>
        <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pct(ret * 100)}</dd></div>
        <div><dt>同期大盤</dt><dd class="num ${bench == null ? 'muted' : cls(bench)}">${bench == null ? '—' : pct(bench * 100)}</dd></div>
        <div><dt>可用現金</dt><dd class="num">${money(s.cash - reservedCash(s, m))}</dd></div>
      </dl>
      <div class="sim-steps">
        <button type="button" class="btn btn-accent" data-sim="step1" ${dis} title="快捷鍵：→">下一天 ▸</button>
        <button type="button" class="btn" data-sim="step5" ${dis} title="快捷鍵：Shift + →">5 天 ▸▸</button>
        <button type="button" class="btn" data-sim="step20" ${dis}>20 天 ▸▸▸</button>
        <button type="button" class="btn" data-sim="reset">結束這局</button>
      </div>
      ${end ? `<p class="sim-end">已經回放到最新的資料（${esc(s.date)}）。${this.verdict(s)}</p>` : ''}`;
  }

  private verdict(s: SimState): string {
    const sum = summarize(s, this.market);
    const t0 = this.taiex?.get(s.settings.start);
    const t1 = this.taiex?.get(s.date);
    const bench = t0 && t1 ? t1 / t0 - 1 : null;
    const vs = bench == null ? '' : sum.ret > bench ? `，贏過大盤 ${num((sum.ret - bench) * 100, 2)} 個百分點` : `，落後大盤 ${num((bench - sum.ret) * 100, 2)} 個百分點`;
    return `${sum.days} 個交易日報酬 ${pct(sum.ret * 100)}${vs}；最大回檔 ${num(sum.maxDrawdown * 100, 1)}%，賣出 ${sum.wins + sum.losses} 次、賺 ${sum.wins} 次，手續費＋稅 ${money(sum.fees)} 元。`;
  }

  private renderChart(el: HTMLElement, s: SimState): void {
    const all = this.candles.get(s.watch);
    const name = this.nameOf(s.watch);
    const visible = all ? all.filter((c) => c.date <= s.date) : [];
    const last = visible[visible.length - 1];
    const prev = visible[visible.length - 2];
    const chg = last && prev ? last.close / prev.close - 1 : 0;
    const options = this.dir.map((d) => `<option value="${esc(`${d.code} ${d.name}`)}"></option>`).join('');
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = `
        <div class="sim-chart-head">
          <div class="sim-stock" id="sim-stock"></div>
          <form class="sim-search" id="sim-search" role="search">
            <input name="q" id="sim-q" list="sim-dir" placeholder="代號或名稱，例如 2330" autocomplete="off" aria-label="查詢股票" />
            <button type="submit" class="btn">看這檔</button>
            <datalist id="sim-dir"></datalist>
          </form>
        </div>
        <div class="sim-k" id="sim-k"></div>
        <div class="sim-hints" id="sim-hints"></div>`;
    }
    const dl = el.querySelector<HTMLElement>('#sim-dir')!;
    if (this.dir.length && !dl.childElementCount) dl.innerHTML = options;
    setHtml(
      el.querySelector<HTMLElement>('#sim-stock')!,
      `<b>${esc(s.watch)}</b> ${esc(name)}
       ${last ? `<span class="num">${price(last.close)}</span> <span class="num ${cls(chg)}">${pct(chg * 100)}</span>
       <small class="muted num">開 ${price(last.open)} 高 ${price(last.high)} 低 ${price(last.low)} 量 ${num(last.volume)} 張</small>` : ''}`,
    );
    const k = el.querySelector<HTMLElement>('#sim-k')!;
    if (all === undefined) setHtml(k, `<p class="muted sim-empty">下載 ${esc(s.watch)} 的日 K⋯⋯</p>`);
    else if (visible.length < 2) setHtml(k, `<p class="muted sim-empty">${esc(s.watch)} 在 ${esc(s.date)} 以前沒有日 K（可能還沒上市，或資料尚未回補到這一天）。</p>`);
    else setHtml(k, this.chartSvg(visible, Math.max(320, k.clientWidth || 640), Math.max(240, k.clientHeight || 320)));
    setHtml(el.querySelector<HTMLElement>('#sim-hints')!, visible.length >= 30 ? this.hintsHtml(visible) : '');
  }

  private chartSvg(visible: Candle[], w: number, h: number): string {
    const n = Math.min(BARS, visible.length);
    const off = visible.length - n;
    const c = visible.slice(off);
    const closes = visible.map((x) => x.close);
    const ma20 = sma(closes, 20).slice(off);
    const ma60 = sma(closes, 60).slice(off);
    const pad = { l: 6, r: 52, t: 8, b: 18 };
    const volH = Math.round((h - pad.t - pad.b) * 0.2);
    const pb = h - pad.b - volH - 8;
    const x = scaleBand<number>().domain(c.map((_, i) => i)).range([pad.l, w - pad.r]).padding(0.25);
    const vals = [...c.flatMap((b) => [b.high, b.low]), ...ma20, ...ma60].filter((v): v is number => v != null);
    const y = scaleLinear().domain([Math.min(...vals), Math.max(...vals)]).nice(5).range([pb, pad.t]);
    const yv = scaleLinear().domain([0, Math.max(1, ...c.map((b) => b.volume))]).range([h - pad.b, h - pad.b - volH]);
    const bw = x.bandwidth();
    const cx = (i: number) => x(i)! + bw / 2;
    let body = '';
    c.forEach((b, i) => {
      const k = b.close >= b.open ? 'sim-up' : 'sim-down';
      const top = y(Math.max(b.open, b.close));
      const bh = Math.max(1, Math.abs(y(b.open) - y(b.close)));
      body += `<line class="${k}" x1="${cx(i).toFixed(1)}" x2="${cx(i).toFixed(1)}" y1="${y(b.high).toFixed(1)}" y2="${y(b.low).toFixed(1)}"></line>`;
      body += `<rect class="${k}" x="${x(i)!.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`;
      body += `<rect class="${k} sim-vol" x="${x(i)!.toFixed(1)}" y="${yv(b.volume).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad.b - yv(b.volume)).toFixed(1)}"></rect>`;
    });
    const path = (arr: (number | null)[]) => {
      let d = '';
      arr.forEach((v, i) => {
        if (v != null) d += `${d ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(v).toFixed(1)}`;
      });
      return d;
    };
    const ticks = y.ticks(5).map((t) => `<g><line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 6}" y="${(y(t) + 4).toFixed(1)}">${price(t)}</text></g>`).join('');
    const months: string[] = [];
    c.forEach((b, i) => {
      if (i > 0 && b.date.slice(5, 7) !== c[i - 1].date.slice(5, 7)) months.push(`<text class="sim-axis" x="${cx(i).toFixed(1)}" y="${h - 4}" text-anchor="middle">${b.date.slice(2, 7).replace('-', '/')}</text>`);
    });
    const lastC = c[c.length - 1].close;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="日 K 線（只到目前日期）">
      ${ticks}${months.join('')}${body}
      <path class="sim-ma20" d="${path(ma20)}"></path><path class="sim-ma60" d="${path(ma60)}"></path>
      <line class="sim-last" x1="${pad.l}" x2="${w - pad.r}" y1="${y(lastC).toFixed(1)}" y2="${y(lastC).toFixed(1)}"></line>
      <text class="sim-legend" x="${pad.l + 4}" y="${pad.t + 10}"><tspan class="sim-ma20t">— 月線 MA20</tspan>  <tspan class="sim-ma60t">— 季線 MA60</tspan></text>
    </svg>`;
  }

  private hintsHtml(visible: Candle[]): string {
    const toggle = `<button type="button" class="btn btn-sm" data-sim="hints" aria-pressed="${this.hints}">${this.hints ? '隱藏' : '顯示'}型態提示</button>`;
    if (!this.hints) return `<div class="sim-hints-row">${toggle}</div>`;
    const { patterns } = detectPatterns(visible);
    const list = patterns.slice(0, 5).map((p) => `<li><span class="tilt tilt-${p.bias}">${BIAS[p.bias]}</span> <b>${esc(p.name)}</b> <span class="muted">${esc(p.status)}</span></li>`).join('');
    return `<div class="sim-hints-row">${toggle}<small class="muted">只用到 ${esc(visible[visible.length - 1].date)} 為止的資料判斷，可到「個股分析」看完整說明</small></div>
      ${list ? `<ul class="sim-pat">${list}</ul>` : '<p class="muted">目前沒有明顯的型態。</p>'}`;
  }

  private renderOrder(el: HTMLElement, s: SimState): void {
    const have = s.holdings[s.watch]?.shares ?? 0;
    const pend = s.orders
      .map(
        (o) => `<li><span class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '買' : '賣'}</span>
          <b>${esc(o.code)}</b> ${esc(this.nameOf(o.code))} <span class="num">${num(o.shares)} 股</span>
          <span class="muted">${o.limit ? `限價 ${o.limit}` : '市價'}</span>
          <button type="button" class="btn btn-sm" data-sim="cancel" data-id="${o.id}">取消</button></li>`,
      )
      .join('');
    const html = `
      <h2 class="panel-title">下單 <small>收盤後委託，下一個交易日成交</small></h2>
      <form class="sim-order-form" id="sim-order-form">
        <div class="seg seg-2" role="group" aria-label="買賣">
          <button type="button" data-sim="buy" aria-pressed="${this.side === 'buy'}">買進</button>
          <button type="button" data-sim="sell" aria-pressed="${this.side === 'sell'}">賣出</button>
        </div>
        <p class="sim-target"><b>${esc(s.watch)}</b> ${esc(this.nameOf(s.watch))}<span class="muted">　持有 ${num(have)} 股</span></p>
        <div class="sim-qty-row">
          <input type="number" name="qty" id="sim-qty" min="1" step="1" value="1" aria-label="數量" required />
          <div class="seg seg-2 sim-unit" role="group" aria-label="單位">
            <button type="button" data-sim="lot" aria-pressed="${this.unit === 'lot'}">張</button>
            <button type="button" data-sim="share" aria-pressed="${this.unit === 'share'}">股</button>
          </div>
          <button type="button" class="btn btn-sm" data-sim="all">${this.side === 'buy' ? '最多' : '全部'}</button>
        </div>
        <div class="sim-type">
          <label><input type="radio" name="type" value="market" checked /> 市價（開盤價）</label>
          <label><input type="radio" name="type" value="limit" /> 限價 <input type="number" name="limit" id="sim-limit" step="0.01" min="0" disabled aria-label="限價" /></label>
        </div>
        <p class="sim-est num" id="sim-est"></p>
        <button type="submit" class="btn ${this.side === 'buy' ? 'btn-buy' : 'btn-sell'} btn-block" ${this.busy ? 'disabled' : ''}>委託${this.side === 'buy' ? '買進' : '賣出'}</button>
      </form>
      <p class="sim-msg" role="status">${esc(this.msg)}</p>
      <h3 class="sim-sub">委託中</h3>
      ${pend ? `<ul class="sim-orders">${pend}</ul>` : '<p class="muted">沒有委託。</p>'}`;
    // 輸入框的值不要被重畫蓋掉：只在結構改變時整個重畫
    const key = `${s.watch}|${this.side}|${this.unit}|${have}|${this.busy}|${this.msg}|${s.orders.map((o) => o.id).join(',')}|${this.dir.length}`;
    if (el.dataset.key !== key) {
      const qty = el.querySelector<HTMLInputElement>('#sim-qty')?.value;
      el.dataset.key = key;
      el.innerHTML = html;
      if (qty) el.querySelector<HTMLInputElement>('#sim-qty')!.value = qty;
    }
    this.renderEstimate();
  }

  private renderEstimate(): void {
    const s = this.state;
    const out = this.root.querySelector<HTMLElement>('#sim-est');
    const form = this.root.querySelector<HTMLFormElement>('#sim-order-form');
    if (!s || !out || !form) return;
    const fd = new FormData(form);
    const shares = Math.round(Number(fd.get('qty')) * (this.unit === 'lot' ? LOT : 1));
    const limit = fd.get('type') === 'limit' ? Number(fd.get('limit')) : NaN;
    const ref = this.market.lastClose(s.watch, s.date);
    const px = limit > 0 ? limit : ref;
    if (!px || !(shares > 0)) {
      out.textContent = '';
      return;
    }
    const amt = px * shares;
    const fee = feeOf(amt, s.settings.discount, shares);
    const tax = this.side === 'sell' ? taxOf(amt, s.watch) : 0;
    out.textContent = `${limit > 0 ? '以限價' : '以今天收盤估'} ${price(px)} × ${num(shares)} 股 ≈ ${money(amt)} 元，手續費 ${money(fee)}${tax ? `、證交稅 ${money(tax)}` : ''}`;
  }

  private holdHtml(s: SimState): string {
    const m = this.market;
    const rows = Object.entries(s.holdings)
      .map(([code, h]) => {
        const close = m.lastClose(code, s.date);
        const mv = close ? close * h.shares : 0;
        const pnl = close ? mv - feeOf(mv, s.settings.discount, h.shares) - taxOf(mv, code) - h.cost : 0;
        return `<tr data-sim="watch" data-code="${esc(code)}" tabindex="0">
          <td><b>${esc(code)}</b> ${esc(this.nameOf(code))}</td>
          <td class="num">${num(h.shares)}</td>
          <td class="num">${price(h.cost / h.shares)}</td>
          <td class="num">${close ? price(close) : '—'}</td>
          <td class="num">${money(mv)}</td>
          <td class="num ${cls(pnl)}">${money(pnl)}<br /><small>${pct((pnl / h.cost) * 100)}</small></td>
        </tr>`;
      })
      .join('');
    return `<h2 class="panel-title">持股 <small>未實現損益已扣掉賣出的手續費與稅</small></h2>
      ${rows ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>股數</th><th>成本</th><th>收盤</th><th>市值</th><th>損益</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">還沒有持股。搜尋一檔股票，收盤後下單吧。</p>'}`;
  }

  private equityHtml(s: SimState, w: number): string {
    const pts = s.equity;
    const sum = summarize(s, this.market);
    const head = `<h2 class="panel-title">資產曲線 <small>對照同期加權指數</small></h2>
      <dl class="sim-stats">
        <div><dt>最大回檔</dt><dd class="num">${num(sum.maxDrawdown * 100, 1)}%</dd></div>
        <div><dt>已實現損益</dt><dd class="num ${cls(sum.realized)}">${money(sum.realized)}</dd></div>
        <div><dt>勝 / 敗</dt><dd class="num">${sum.wins} / ${sum.losses}</dd></div>
        <div><dt>手續費＋稅</dt><dd class="num">${money(sum.fees)}</dd></div>
      </dl>`;
    if (pts.length < 2) return `${head}<p class="muted">往前推進幾天後就會畫出資產曲線。</p>`;
    const h = 180;
    const pad = { l: 4, r: 46, t: 8, b: 16 };
    const t0 = this.taiex?.get(s.settings.start);
    const bench = t0 ? pts.map(([d]) => (this.taiex?.get(d) ?? NaN) / t0) : [];
    const mine = pts.map(([, v]) => v / s.settings.capital);
    const all = [...mine, ...bench.filter(Number.isFinite), 1];
    const y = scaleLinear().domain([Math.min(...all), Math.max(...all)]).nice(4).range([h - pad.b, pad.t]);
    const x = (i: number) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
    const line = (arr: number[]) => {
      let d = '';
      let pen = false;
      arr.forEach((v, i) => {
        if (!Number.isFinite(v)) return void (pen = false);
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const ticks = y.ticks(4).map((t) => `<line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 4}" y="${(y(t) + 4).toFixed(1)}">${pct((t - 1) * 100, 0)}</text>`).join('');
    return `${head}<svg class="sim-eq" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="資產曲線">
      ${ticks}<line class="sim-base" x1="${pad.l}" x2="${w - pad.r}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}"></line>
      ${bench.length ? `<path class="sim-bench" d="${line(bench)}"></path>` : ''}<path class="sim-mine" d="${line(mine)}"></path>
      <text class="sim-axis" x="${pad.l}" y="${h - 3}">${esc(pts[0][0])}</text><text class="sim-axis" x="${w - pad.r}" y="${h - 3}" text-anchor="end">${esc(pts[pts.length - 1][0])}</text>
    </svg>
    <p class="sim-eq-legend"><span class="sim-mine-t">━ 我的帳戶</span>　<span class="sim-bench-t">━ 加權指數</span>${t0 ? '' : '<small class="muted">（加權指數資料還沒回補到起始日）</small>'}</p>`;
  }

  private logHtml(s: SimState): string {
    const items = [
      ...s.trades.map((t) => ({
        date: t.date,
        html: `<span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '買進' : '賣出'}</span> <b>${esc(t.code)}</b> ${esc(this.nameOf(t.code))}
          <span class="num">${num(t.shares)} 股 @ ${price(t.price)}</span>
          ${t.pnl != null ? `<span class="num ${cls(t.pnl)}">損益 ${money(t.pnl)}</span>` : ''}
          <small class="muted num">費 ${money(t.fee)}${t.tax ? `／稅 ${money(t.tax)}` : ''}</small>`,
      })),
      ...s.notes.map((n) => ({ date: n.date, html: `<b>${esc(n.code)}</b> ${esc(this.nameOf(n.code))} <span class="muted">${esc(n.text)}</span>` })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 80);
    return `<h2 class="panel-title">交易紀錄</h2>
      ${items.length ? `<ol class="sim-logs">${items.map((i) => `<li><time class="num muted">${esc(i.date.slice(5))}</time> ${i.html}</li>`).join('')}</ol>` : '<p class="muted">還沒有交易。</p>'}`;
  }
}
