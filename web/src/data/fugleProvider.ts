import { FUGLE_WS, FugleClient, FugleError, TAIEX, computeBaseline, parseQuote, type Baseline, type ParsedQuote } from './fugle';
import { buildMockUniverse } from './mockUniverse';
import type { MarketDataProvider } from './provider';
import { SESSION_MINUTES, sessionOpenMs } from './twse';
import type { EtfMeta, Fundamentals, IndexPoint, MarketSnapshot, Quote, SessionState, StockMeta, TurnoverBar, Universe } from './types';

/**
 * 富果真實行情。
 *
 * - 股票池、產業分類沿用內建清單；股價、成交額、昨收來自富果。
 * - 熱力圖的所有股票用 Intraday API 輪流查詢（每分鐘 55 次），約 2～3 分鐘更新一輪。
 * - WebSocket 訂閱 5 檔（市值最大的 4 檔＋目前選取的股票），這幾檔是逐筆即時。
 * - 20 日常態成交額、均線、一年高低點用 Historical API 計算，每天算一次並存在瀏覽器。
 * - 基本面（EPS、股利、籌碼、事件）目前仍是模擬資料，只依真實股價等比例換算。
 *
 * 當天的報價與每分鐘紀錄也存在瀏覽器，重新整理頁面不會從零開始。
 */

export type FugleState = 'connecting' | 'live' | 'closed' | 'error';

export interface FugleStatus {
  state: FugleState;
  /** 顯示在頂部的短訊息。 */
  message: string;
  /** 滑鼠移上去看到的詳細狀態。 */
  detail: string;
}

const DAY_KEY = 'lplc.fugle.day.v1';
const BASE_KEY = 'lplc.fugle.base.v1';
const WS_FIXED = 4;

/** 台北時間的日期（YYYY-MM-DD）。 */
export function taipeiDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

function taipeiWeekday(ms: number): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(ms);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

export function sessionAt(ms: number): SessionState {
  const wd = taipeiWeekday(ms);
  if (wd === 0 || wd === 6) return 'closed';
  const minute = (ms - sessionOpenMs(new Date(ms))) / 60_000;
  if (minute < 0) return 'pre';
  return minute <= SESSION_MINUTES ? 'open' : 'closed';
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 空間不足或無法存取時略過，只影響重新整理後的接續 */
  }
}

interface DayCache {
  date: string;
  quotes: Record<string, Quote>;
  prevClose: Record<string, number>;
  index: { value: number; turnover: number; prevClose: number; series: IndexPoint[] };
  bars: TurnoverBar[];
}

interface BaseCache {
  date: string;
  byCode: Record<string, Baseline>;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class FugleProvider implements MarketDataProvider {
  private readonly client: FugleClient;
  private readonly universe: Universe;
  private readonly stockByCode: Map<string, StockMeta>;
  private readonly etfByCode: Map<string, EtfMeta>;
  /** 內建的模擬基本面與當時的股價，換算成真實股價用。 */
  private readonly mockFundamentals = new Map<string, { f: Fundamentals; prev: number }>();
  /** 輪詢順序：市值大的先。 */
  private readonly symbols: string[];
  private readonly missing = new Set<string>();
  private readonly listeners = new Set<(s: MarketSnapshot) => void>();
  private readonly statusListeners = new Set<(s: FugleStatus) => void>();

  private today = taipeiDate(Date.now());
  private quotes: Record<string, Quote> = {};
  private realPrev: Record<string, number> = {};
  private baselines: Record<string, Baseline> = {};
  private index = { value: 0, turnover: 0, series: [] as IndexPoint[] };
  private bars: TurnoverBar[] = [];
  private lastQuoteDate?: string;

  private status: FugleStatus = { state: 'connecting', message: '富果連線中', detail: '正在讀取第一筆報價' };
  private okCount = 0;
  private fatal = false;
  private baseDone = 0;
  private baseTotal = 0;
  private roundMs = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private barTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  private ws?: WebSocket;
  private wsReady = false;
  private wsRetry = 0;
  private readonly wsChannels = new Map<string, string>();
  private focus: string | null = null;

  constructor(private readonly apiKey: string) {
    this.client = new FugleClient(apiKey);
    this.universe = buildMockUniverse();
    this.stockByCode = new Map(this.universe.stocks.map((s) => [s.code, s]));
    this.etfByCode = new Map((this.universe.etfs ?? []).map((e) => [e.code, e]));
    for (const s of this.universe.stocks) {
      if (s.fundamentals) this.mockFundamentals.set(s.code, { f: { ...s.fundamentals }, prev: s.prevClose });
    }
    this.symbols = [
      ...[...this.universe.stocks].sort((a, b) => b.marketCap - a.marketCap).map((s) => s.code),
      ...(this.universe.etfs ?? []).map((e) => e.code),
    ];
    this.restore();
  }

  async loadUniverse(): Promise<Universe> {
    return this.universe;
  }

  subscribe(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    this.start();
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: FugleStatus) => void): void {
    this.statusListeners.add(listener);
    listener(this.status);
  }

  /** 選取的股票會佔用第 5 個 WebSocket 訂閱，變成逐筆即時。 */
  setFocus(code: string | null): void {
    const next = code && this.stockByCode.has(code) && !this.wsFixed().includes(code) ? code : null;
    if (next === this.focus) return;
    if (this.focus) this.wsUnsubscribe(this.focus);
    this.focus = next;
    if (next) this.wsSubscribe(next);
  }

  // ------------------------------------------------------------ 主流程

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.loadBaselines();
    void this.loop();
    this.connectWs();
    this.barTimer = setInterval(() => this.recordBar(), 15_000);
  }

  private stopAll(): void {
    this.fatal = true;
    this.client.stop();
    if (this.barTimer) clearInterval(this.barTimer);
    this.ws?.close();
  }

  private async loop(): Promise<void> {
    while (!this.fatal) {
      const started = Date.now();
      await this.round();
      this.roundMs = Date.now() - started;
      this.persist();
      this.updateStatus();
      // 收盤或假日只需要確認一次最新資料，之後放慢；開盤前每分鐘確認一次
      const clock = sessionAt(Date.now());
      const wait = clock === 'closed' ? 10 * 60_000 : clock === 'pre' || this.session() !== 'open' ? 60_000 : 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async round(): Promise<void> {
    const jobs: Promise<unknown>[] = [
      this.client.quote(TAIEX).then((q) => this.applyIndex(q), (e) => this.onError(e)),
      this.client.intradayCandles(TAIEX).then(
        (rows) => {
          const series = rows
            .map((c) => ({ t: Date.parse(c.date), v: c.close ?? 0 }))
            .filter((p) => Number.isFinite(p.t) && p.v > 0);
          if (series.length) this.index.series = series;
        },
        (e) => this.onError(e),
      ),
    ];
    for (const code of this.symbols) {
      if (this.missing.has(code)) continue;
      jobs.push(
        this.client.quote(code).then(
          (q) => this.applyQuote(q),
          (e) => this.onError(e, code),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private onError(e: unknown, code?: string): void {
    if (!(e instanceof FugleError)) return;
    if (e.kind === 'not-found' && code) {
      this.missing.add(code);
      return;
    }
    if (e.kind === 'auth') {
      this.setStatus({ state: 'error', message: 'API 金鑰無效', detail: '富果拒絕了這把 API 金鑰。請到右上角選單重新貼上，或確認金鑰仍有效。' });
      this.stopAll();
      return;
    }
    if (e.kind === 'network' && this.okCount === 0) {
      this.setStatus({
        state: 'error',
        message: '無法連線富果',
        detail: '瀏覽器連不到富果 API。可能是網路問題，或富果不允許從網頁直接呼叫（CORS）。',
      });
      this.stopAll();
      return;
    }
  }

  // ------------------------------------------------------------ 報價

  private applyIndex(q: ParsedQuote): void {
    this.okCount++;
    if (q.prevClose) this.universe.index.prevClose = q.prevClose;
    if (q.price) this.index.value = q.price;
    if (q.turnover > 0) this.index.turnover = q.turnover;
    if (q.date) this.lastQuoteDate = q.date;
    this.scheduleEmit();
  }

  private applyQuote(q: ParsedQuote): void {
    this.okCount++;
    const code = q.symbol;
    if (q.prevClose) {
      this.realPrev[code] = q.prevClose;
      this.syncMeta(code);
    }
    if (q.date) this.lastQuoteDate = q.date;
    const prev = this.prevOf(code);
    const price = q.price ?? prev;
    if (!price) return;
    const old = this.quotes[code];
    this.quotes[code] = {
      code,
      price,
      high: q.high ?? price,
      low: q.low ?? price,
      volume: q.volume,
      // 輪詢與 WebSocket 交錯時，累計成交額取較新的（較大的）
      turnover: Math.max(old?.turnover ?? 0, q.turnover),
    };
    if (this.status.state === 'connecting') this.updateStatus();
    this.scheduleEmit();
  }

  private prevOf(code: string): number | undefined {
    return this.stockByCode.get(code)?.prevClose ?? this.etfByCode.get(code)?.prevClose;
  }

  /** 把真實昨收、日 K 資料寫回股票池（基本面依真實股價等比例換算）。 */
  private syncMeta(code: string): void {
    const base = this.baselines[code];
    const prev = this.realPrev[code] ?? base?.lastClose;
    const etf = this.etfByCode.get(code);
    if (etf) {
      if (prev) etf.prevClose = prev;
      if (base && base.avgTurnover20 > 0) etf.avgTurnover20 = base.avgTurnover20;
      return;
    }
    const stock = this.stockByCode.get(code);
    if (!stock) return;
    if (base && base.avgTurnover20 > 0) stock.avgTurnover20 = base.avgTurnover20;
    const mock = this.mockFundamentals.get(code);
    if (!prev) return;
    stock.prevClose = prev;
    if (!mock || !stock.fundamentals) return;
    const r = prev / mock.prev;
    const f = mock.f;
    Object.assign(stock.fundamentals, {
      eps4q: f.eps4q * r,
      dividend: f.dividend * r,
      low3y: base ? Math.min(f.low3y * r, base.low52w) : f.low3y * r,
      high3y: base ? Math.max(f.high3y * r, base.high52w) : f.high3y * r,
      high52w: base?.high52w ?? f.high52w * r,
      high20: base?.high20 ?? f.high20 * r,
      ma5: base?.ma5 ?? f.ma5 * r,
      ma20: base?.ma20 ?? f.ma20 * r,
      ma60: base?.ma60 ?? f.ma60 * r,
    });
  }

  // ------------------------------------------------------------ 20 日常態（日 K）

  private async loadBaselines(): Promise<void> {
    const cache = load<BaseCache>(BASE_KEY);
    if (cache) {
      this.baselines = cache.byCode;
      for (const code of Object.keys(this.baselines)) this.syncMeta(code);
    }
    const codes = this.symbols.filter((c) => !(cache?.date === this.today && cache.byCode[c]));
    this.baseTotal = this.symbols.length;
    this.baseDone = this.baseTotal - codes.length;
    if (codes.length === 0) return;
    const from = shiftDate(this.today, -365);
    await Promise.all(
      codes.map((code) =>
        this.client
          .dailyCandles(code, from, this.today)
          .then((rows) => {
            const b = computeBaseline(rows, this.today);
            if (b) {
              this.baselines[code] = b;
              this.syncMeta(code);
            }
          })
          .catch((e) => this.onError(e, code))
          .finally(() => {
            this.baseDone++;
            if (this.baseDone % 10 === 0 || this.baseDone === this.baseTotal) {
              save(BASE_KEY, { date: this.today, byCode: this.baselines } satisfies BaseCache);
              this.updateStatus();
              this.scheduleEmit();
            }
          }),
      ),
    );
  }

  // ------------------------------------------------------------ WebSocket（5 檔逐筆）

  private wsFixed(): string[] {
    return this.symbols.slice(0, WS_FIXED);
  }

  private connectWs(): void {
    if (this.fatal || typeof WebSocket === 'undefined') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(FUGLE_WS);
    } catch {
      return;
    }
    this.ws = ws;
    this.wsReady = false;
    this.wsChannels.clear();
    ws.onopen = () => ws.send(JSON.stringify({ event: 'auth', data: { apikey: this.apiKey } }));
    ws.onmessage = (msg) => {
      let m: { event?: string; channel?: string; data?: Record<string, unknown> };
      try {
        m = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (m.event === 'authenticated') {
        this.wsReady = true;
        this.wsRetry = 0;
        for (const code of [...this.wsFixed(), ...(this.focus ? [this.focus] : [])]) this.wsSubscribe(code);
        this.updateStatus();
      } else if (m.event === 'subscribed' && m.data) {
        const { id, symbol } = m.data as { id?: string; symbol?: string };
        if (id && symbol) this.wsChannels.set(symbol, id);
      } else if (m.event === 'data' && m.channel === 'aggregates' && m.data) {
        const q = parseQuote(m.data);
        if (q.symbol === TAIEX) this.applyIndex(q);
        else if (q.symbol) this.applyQuote(q);
      }
    };
    ws.onclose = () => {
      this.wsReady = false;
      this.updateStatus();
      if (this.fatal) return;
      this.wsRetry++;
      setTimeout(() => this.connectWs(), Math.min(60_000, 5_000 * this.wsRetry));
    };
  }

  private wsSubscribe(code: string): void {
    if (this.wsReady) this.ws?.send(JSON.stringify({ event: 'subscribe', data: { channel: 'aggregates', symbol: code } }));
  }

  private wsUnsubscribe(code: string): void {
    const id = this.wsChannels.get(code);
    this.wsChannels.delete(code);
    if (id && this.wsReady) this.ws?.send(JSON.stringify({ event: 'unsubscribe', data: { id } }));
  }

  // ------------------------------------------------------------ 每分鐘紀錄、快照

  private session(): SessionState {
    const now = Date.now();
    // 遇到國定假日：最新報價不是今天的，就當作休市
    if (this.lastQuoteDate && this.lastQuoteDate !== taipeiDate(now)) return 'closed';
    return sessionAt(now);
  }

  private recordBar(): void {
    const now = Date.now();
    if (taipeiDate(now) !== this.today) {
      // 跨日：重新開始一天
      this.today = taipeiDate(now);
      this.bars = [];
      this.quotes = {};
      void this.loadBaselines();
    }
    if (this.session() !== 'open' || Object.keys(this.quotes).length === 0) return;
    const t = Math.floor(now / 60_000) * 60_000;
    if (this.bars.length && this.bars[this.bars.length - 1].t >= t) return;
    const byStock: Record<string, number> = {};
    const prices: Record<string, number> = {};
    for (const [code, q] of Object.entries(this.quotes)) {
      byStock[code] = q.turnover;
      prices[code] = q.price;
    }
    this.bars.push({ t, byStock, prices });
    if (this.bars.length % 5 === 0) this.persist();
  }

  private snapshot(): MarketSnapshot {
    const stockTurnover = this.universe.stocks.reduce((s, m) => s + (this.quotes[m.code]?.turnover ?? 0), 0);
    return {
      time: Date.now(),
      session: this.session(),
      index: {
        value: this.index.value || this.universe.index.prevClose,
        turnover: this.index.turnover || stockTurnover,
        series: this.index.series,
      },
      quotes: { ...this.quotes },
      turnoverHistory: this.bars.slice(),
      partial: this.symbols.some((c) => !this.quotes[c] && !this.missing.has(c)),
    };
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const snap = this.snapshot();
      for (const l of this.listeners) l(snap);
    }, 1000);
  }

  // ------------------------------------------------------------ 狀態、暫存

  private updateStatus(): void {
    if (this.fatal) return;
    const loaded = this.symbols.filter((c) => this.quotes[c]).length;
    const total = this.symbols.length - this.missing.size;
    const lines = [
      `報價：${loaded} / ${total} 檔${this.roundMs ? `，每輪約 ${(this.roundMs / 60_000).toFixed(1)} 分鐘` : ''}`,
      `20 日常態：${this.baseDone} / ${this.baseTotal} 檔`,
      `WebSocket：${this.wsReady ? `已連線，${this.wsChannels.size} 檔逐筆即時` : '未連線'}`,
    ];
    if (this.missing.size) lines.push(`富果查無：${[...this.missing].join('、')}`);
    lines.push('基本面、籌碼、ETF 成分股仍為模擬資料');
    const s = this.session();
    if (loaded === 0) {
      this.setStatus({ state: 'connecting', message: '富果連線中', detail: lines.join('\n') });
    } else if (loaded < total || this.baseDone < this.baseTotal) {
      const pct = Math.round(((loaded / total + this.baseDone / Math.max(1, this.baseTotal)) / 2) * 100);
      this.setStatus({ state: 'connecting', message: `富果載入 ${pct}%`, detail: lines.join('\n') });
    } else {
      this.setStatus({ state: s === 'open' ? 'live' : 'closed', message: s === 'open' ? '富果即時' : '富果・休市', detail: lines.join('\n') });
    }
  }

  private setStatus(s: FugleStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private persist(): void {
    save(DAY_KEY, {
      date: this.today,
      quotes: this.quotes,
      prevClose: this.realPrev,
      index: { ...this.index, prevClose: this.universe.index.prevClose },
      bars: this.bars,
    } satisfies DayCache);
  }

  private restore(): void {
    const day = load<DayCache>(DAY_KEY);
    // 只接續同一天的資料；隔天的昨收改由日 K 提供
    if (!day || day.date !== this.today) return;
    this.realPrev = day.prevClose ?? {};
    this.universe.index.prevClose = day.index?.prevClose || this.universe.index.prevClose;
    for (const code of Object.keys(this.realPrev)) this.syncMeta(code);
    this.quotes = day.quotes ?? {};
    this.bars = day.bars ?? [];
    if (day.index) this.index = { value: day.index.value, turnover: day.index.turnover, series: day.index.series ?? [] };
  }
}
