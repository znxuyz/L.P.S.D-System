import { FUGLE_WS, FugleClient, FugleError, TAIEX, computeBaseline, parseQuote, type Baseline, type ParsedQuote } from './fugle';
import { MIS_BATCH, MIS_TAIEX, MisClient, MisError, misChannel, parseMis, type MisExchange } from './twseMis';
import { mockDailyCandles, type DailySeries } from './candles';
import { nearMonthContract, type FuturesQuote } from './futures';
import { buildMockUniverse } from './mockUniverse';
import type { MarketDataProvider } from './provider';
import { SESSION_MINUTES, sessionOpenMs } from './twse';
import type { EtfMeta, Fundamentals, IndexPoint, MarketSnapshot, Quote, SessionState, StockMeta, TurnoverBar, Universe } from './types';

/**
 * 真實行情，有兩種來源：
 *
 * 富果（fugleKey）
 * - 熱力圖的所有股票用 Intraday API 輪流查詢（每分鐘 55 次），約 2～3 分鐘更新一輪。
 * - WebSocket 訂閱 5 檔（市值最大的 4 檔＋目前選取的股票），這幾檔是逐筆即時。
 *
 * 證交所 MIS（misProxy）
 * - 經過自己的轉接服務，一次查 50 檔，全部股票約 10 秒更新一輪。
 * - 成交額由成交量估算。
 *
 * 共通
 * - 股票池、產業分類沿用內建清單；股價、成交額、昨收來自真實行情。
 * - 有富果金鑰時，20 日常態成交額、均線、一年高低點用 Historical API 計算，每天算一次並存在瀏覽器。
 *   證交所模式的富果金鑰是選填；沒有時沿用內建的常態估計值。
 * - 基本面（EPS、股利、籌碼、事件）目前仍是模擬資料，只依真實股價等比例換算。
 *
 * 當天的報價與每分鐘紀錄也存在瀏覽器，重新整理頁面不會從零開始。
 */

export type LiveState = 'connecting' | 'live' | 'closed' | 'error';

export interface LiveOptions {
  /** 富果 API 金鑰：富果模式必填，證交所模式選填（用來算 20 日常態）。 */
  fugleKey?: string;
  /** 證交所 MIS 轉接服務網址；有設定就用證交所報價。 */
  misProxy?: string;
}

export interface LiveStatus {
  state: LiveState;
  /** 顯示在頂部的短訊息。 */
  message: string;
  /** 滑鼠移上去看到的詳細狀態。 */
  detail: string;
}

const DAY_KEY = 'lplc.fugle.day.v1';
const BASE_KEY = 'lplc.fugle.base.v1';
const EX_KEY = 'lplc.mis.ex.v1';
const WS_FIXED = 4;
/** 證交所模式：每輪最短間隔。 */
const MIS_ROUND_MS = 10_000;

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

export class LiveProvider implements MarketDataProvider {
  readonly mode: 'fugle' | 'twse';
  private readonly sourceName: string;
  private readonly client?: FugleClient;
  private readonly mis?: MisClient;
  /** 每檔股票在 MIS 的市場別（上市 / 上櫃），第一輪查詢後記住。 */
  private exchange: Record<string, MisExchange> = {};
  private readonly universe: Universe;
  private readonly stockByCode: Map<string, StockMeta>;
  private readonly etfByCode: Map<string, EtfMeta>;
  /** 內建的模擬基本面與當時的股價，換算成真實股價用。 */
  private readonly mockFundamentals = new Map<string, { f: Fundamentals; prev: number }>();
  /** 輪詢順序：市值大的先。 */
  private readonly symbols: string[];
  private readonly missing = new Set<string>();
  private readonly listeners = new Set<(s: MarketSnapshot) => void>();
  private readonly statusListeners = new Set<(s: LiveStatus) => void>();

  private today = taipeiDate(Date.now());
  private quotes: Record<string, Quote> = {};
  private realPrev: Record<string, number> = {};
  private baselines: Record<string, Baseline> = {};
  private index = { value: 0, turnover: 0, series: [] as IndexPoint[] };
  private bars: TurnoverBar[] = [];
  /** 台指期近月（需要富果金鑰；方案不支援時記下原因、不再查詢）。 */
  private fut: FuturesQuote | null = null;
  private futNote = '';
  private futLastPoll = 0;
  private lastQuoteDate?: string;

  private status: LiveStatus;
  private okCount = 0;
  private fatal = false;
  private baseDone = 0;
  private baseTotal = 0;
  private baseNote = '';
  private roundMs = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private barTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  private ws?: WebSocket;
  private wsReady = false;
  private wsRetry = 0;
  private readonly wsChannels = new Map<string, string>();
  private focus: string | null = null;

  private readonly apiKey: string;

  constructor(options: LiveOptions) {
    this.apiKey = options.fugleKey ?? '';
    this.mode = options.misProxy ? 'twse' : 'fugle';
    this.sourceName = this.mode === 'twse' ? '證交所' : '富果';
    if (this.apiKey) this.client = new FugleClient(this.apiKey);
    if (options.misProxy) this.mis = new MisClient(options.misProxy);
    this.exchange = load<Record<string, MisExchange>>(EX_KEY) ?? {};
    this.status = { state: 'connecting', message: `${this.sourceName}連線中`, detail: '正在讀取第一筆報價' };
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

  /** 股票池以外的股票：富果或證交所 MIS 查一次即時報價。 */
  async extraQuote(code: string, market?: 'tse' | 'otc'): Promise<(Quote & { prevClose?: number }) | null> {
    try {
      let q: ParsedQuote | undefined;
      if (this.mis) {
        const items = await this.mis.fetch(market ? [misChannel(market, code)] : [misChannel('tse', code), misChannel('otc', code)]);
        const item = items.find((it) => it.c === code);
        q = item ? parseMis(item) : undefined;
      } else if (this.client) {
        q = await this.client.quote(code, true);
      }
      if (!q) return null;
      const price = q.price ?? q.prevClose;
      if (!price) return null;
      return { code, price, high: q.high ?? price, low: q.low ?? price, volume: q.volume, turnover: q.turnover, prevClose: q.prevClose };
    } catch {
      return null;
    }
  }

  /** 有富果金鑰時抓一年真實日 K，否則用示意資料。 */
  async dailyCandles(code: string, prevClose?: number): Promise<DailySeries> {
    const prev = this.prevOf(code) ?? prevClose ?? 0;
    if (this.client) {
      try {
        const rows = await this.client.dailyCandles(code, shiftDate(this.today, -365), this.today, true);
        const candles = rows
          .filter((c) => c.date < this.today && c.close && c.open && c.high && c.low)
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          // 富果日 K 的成交量單位是股，換成張
          .map((c) => ({ date: c.date, open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: Math.round((c.volume ?? 0) / 1000) }));
        if (candles.length >= 30) return { candles, source: 'fugle' };
      } catch {
        /* 改用示意資料 */
      }
    }
    return { candles: prev ? mockDailyCandles(code, prev, this.today) : [], source: 'mock' };
  }

  subscribe(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    this.start();
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: LiveStatus) => void): void {
    this.statusListeners.add(listener);
    listener(this.status);
  }

  /** 選取的股票會佔用第 5 個 WebSocket 訂閱，變成逐筆即時。 */
  setFocus(code: string | null): void {
    if (this.mode !== 'fugle') return;
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
    if (this.mode === 'fugle') this.connectWs();
    this.barTimer = setInterval(() => {
      this.recordBar();
      void this.pollFutures();
    }, 15_000);
    void this.pollFutures();
  }

  private stopAll(): void {
    this.fatal = true;
    this.client?.stop();
    this.mis?.stop();
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
      const minimum = this.mode === 'twse' ? Math.max(0, MIS_ROUND_MS - this.roundMs) : 0;
      const wait = clock === 'closed' ? 10 * 60_000 : clock === 'pre' || this.session() !== 'open' ? 60_000 : minimum;
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async round(): Promise<void> {
    if (this.mis) return this.misRound(this.mis);
    if (!this.client) return;
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

  /** 證交所：上市、上櫃代號分批查詢；還不知道市場別的代號兩邊都查一次。 */
  private async misRound(mis: MisClient): Promise<void> {
    const channels = [misChannel('tse', MIS_TAIEX)];
    for (const code of this.symbols) {
      if (this.missing.has(code)) continue;
      const ex = this.exchange[code];
      if (ex) channels.push(misChannel(ex, code));
      else channels.push(misChannel('tse', code), misChannel('otc', code));
    }
    const seen = new Set<string>();
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < channels.length; i += MIS_BATCH) {
      jobs.push(
        mis.fetch(channels.slice(i, i + MIS_BATCH)).then(
          (items) => {
            for (const item of items) {
              const q = parseMis(item);
              if (!q.symbol) continue;
              seen.add(q.symbol);
              if (q.symbol === MIS_TAIEX) {
                // 指數的成交量欄位不是成交額，改用股票池加總
                this.applyIndex({ ...q, turnover: 0 });
                continue;
              }
              if (q.ex) this.exchange[q.symbol] = q.ex;
              this.applyQuote(q);
            }
          },
          (e) => this.onError(e),
        ),
      );
    }
    await Promise.all(jobs);
    if (this.fatal) return;
    // 上市、上櫃都查不到的代號就不再查
    if (seen.size > 0) for (const code of this.symbols) if (!seen.has(code)) this.missing.add(code);
    save(EX_KEY, this.exchange);
  }

  /** 台指期：每 30 秒最多查一次；失敗不影響股票行情。 */
  private async pollFutures(): Promise<void> {
    if (!this.client || this.futNote || Date.now() - this.futLastPoll < 30_000) return;
    // 收盤後只需要查到一次收盤價
    if (this.fut && sessionAt(Date.now()) !== 'open') return;
    this.futLastPoll = Date.now();
    const { symbol } = nearMonthContract(this.today);
    try {
      const q = await this.client.futQuote(symbol);
      const price = q.price ?? this.fut?.price ?? q.prevClose;
      if (!price) return;
      const prev = this.fut;
      const series = prev?.series ?? [];
      const t = Date.now();
      if (sessionAt(t) === 'open' && (!series.length || t - series[series.length - 1].t >= 30_000)) series.push({ t, v: price });
      this.fut = {
        symbol,
        name: '台指期近月',
        price,
        prevClose: q.prevClose ?? prev?.prevClose ?? price,
        high: Math.max(q.high ?? price, prev?.high ?? price),
        low: Math.min(q.low ?? price, prev?.low ?? price),
        volume: q.volume,
        series,
      };
      this.scheduleEmit();
    } catch (e) {
      if (e instanceof FugleError && e.kind !== 'network' && e.kind !== 'rate') {
        this.futNote = e.kind === 'auth' ? '富果方案沒有開放期貨行情' : `查不到 ${symbol}（${e.message}）`;
        this.updateStatus();
      }
    }
  }

  private onError(e: unknown, code?: string): void {
    if (e instanceof MisError) {
      if (e.kind === 'network' && this.okCount === 0) {
        this.setStatus({
          state: 'error',
          message: '無法連線轉接服務',
          detail: '連不到證交所轉接服務。請確認選單裡的轉接網址正確，且 Cloudflare Worker 已部署、允許這個網站的網址。',
        });
        this.stopAll();
      } else if (e.kind === 'format') {
        // 多半是查太快被暫時封鎖，停一下再查
        this.mis?.pause(30_000);
        this.setStatus({ ...this.status, detail: `${e.message}，30 秒後重試` });
      }
      return;
    }
    if (!(e instanceof FugleError)) return;
    if (e.kind === 'not-found' && code) {
      this.missing.add(code);
      return;
    }
    if (this.mode === 'twse') {
      // 證交所模式的富果金鑰只用來算 20 日常態，失敗不影響報價
      if (e.kind === 'auth' || e.kind === 'network') {
        this.client?.stop();
        this.baseNote = e.kind === 'auth' ? '富果金鑰無效，20 日常態改用內建估計值' : '連不到富果，20 日常態改用內建估計值';
        this.baseTotal = this.baseDone;
        this.updateStatus();
      }
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
    if (q.price) {
      this.index.value = q.price;
      // 證交所模式沒有分 K，自己記每輪的指數畫走勢線
      if (this.mode === 'twse' && sessionAt(Date.now()) === 'open') {
        const t = Date.now();
        const last = this.index.series[this.index.series.length - 1];
        if (!last || t - last.t >= 30_000) this.index.series = [...this.index.series, { t, v: q.price }];
      }
    }
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
    const old = this.quotes[code];
    // 沒有新成交價時（證交所顯示 '-'）沿用上一筆
    const price = q.price ?? old?.price ?? this.prevOf(code);
    if (!price) return;
    this.quotes[code] = {
      code,
      price,
      high: q.high ?? price,
      low: q.low ?? price,
      volume: Math.max(old?.volume ?? 0, q.volume),
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
    const client = this.client;
    if (!client) return;
    const codes = this.symbols.filter((c) => !(cache?.date === this.today && cache.byCode[c]));
    this.baseTotal = this.symbols.length;
    this.baseDone = this.baseTotal - codes.length;
    if (codes.length === 0) return;
    const from = shiftDate(this.today, -365);
    await Promise.all(
      codes.map((code) =>
        client
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
      futures: this.fut ? { ...this.fut, series: this.fut.series.slice() } : undefined,
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
    const name = this.sourceName;
    const round = this.roundMs >= 60_000 ? `${(this.roundMs / 60_000).toFixed(1)} 分鐘` : `${Math.round(this.roundMs / 1000)} 秒`;
    const lines = [`報價：${loaded} / ${total} 檔${this.roundMs ? `，每輪約 ${round}` : ''}`];
    if (this.mode === 'twse') lines.push('成交額為成交量 × 均價的估計值');
    if (this.client) lines.push(`20 日常態：${this.baseDone} / ${this.baseTotal} 檔（富果日 K）`);
    else lines.push('20 日常態：內建估計值（選單填富果金鑰可改用真實資料）');
    if (this.baseNote) lines.push(this.baseNote);
    if (this.mode === 'fugle') lines.push(`WebSocket：${this.wsReady ? `已連線，${this.wsChannels.size} 檔逐筆即時` : '未連線'}`);
    lines.push(
      `台指期：${this.fut ? `${this.fut.symbol} 每 30 秒更新` : this.futNote || (this.client ? '載入中' : '需要富果金鑰')}`,
    );
    if (this.missing.size) lines.push(`${name}查無：${[...this.missing].join('、')}`);
    lines.push('基本面、籌碼、ETF 成分股仍為模擬資料');
    const s = this.session();
    if (loaded === 0) {
      this.setStatus({ state: 'connecting', message: `${name}連線中`, detail: lines.join('\n') });
    } else if (loaded < total || this.baseDone < this.baseTotal) {
      const parts = [loaded / total, ...(this.baseTotal ? [this.baseDone / this.baseTotal] : [])];
      const pct = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
      this.setStatus({ state: 'connecting', message: `${name}載入 ${pct}%`, detail: lines.join('\n') });
    } else {
      this.setStatus({ state: s === 'open' ? 'live' : 'closed', message: s === 'open' ? `${name}即時` : `${name}・休市`, detail: lines.join('\n') });
    }
  }

  private setStatus(s: LiveStatus): void {
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
