/**
 * 富果行情 API（Fugle MarketData v1.0）的最小用戶端。
 *
 * 基本用戶的限制：
 * - Intraday API、Historical API 各自每分鐘 60 次。
 * - WebSocket 1 條連線、最多 5 個訂閱。
 *
 * 這裡每個 API 各用一條佇列，預設每分鐘最多送 55 次，留一點餘裕避免撞到上限。
 * 回應格式只取用到的欄位，並且容忍欄位缺漏（例如盤前還沒有成交價）。
 */

export const FUGLE_REST = 'https://api.fugle.tw/marketdata/v1.0/stock';
/** 期貨選擇權的行情（台指期等）。 */
export const FUGLE_FUTOPT = 'https://api.fugle.tw/marketdata/v1.0/futopt';
export const FUGLE_WS = 'wss://api.fugle.tw/marketdata/v1.0/stock/streaming';
/** 加權指數在富果的代號。 */
export const TAIEX = 'IX0001';

export type FugleErrorKind = 'auth' | 'rate' | 'not-found' | 'network' | 'http';

export class FugleError extends Error {
  constructor(
    readonly kind: FugleErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 富果 intraday/quote 與 WebSocket aggregates 共用的欄位（只列用到的）。 */
export interface FugleQuoteRaw {
  date?: string;
  symbol?: string;
  name?: string;
  referencePrice?: number;
  previousClose?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  closePrice?: number;
  lastPrice?: number;
  total?: { tradeValue?: number; tradeVolume?: number };
  lastUpdated?: number;
}

export interface FugleCandleRaw {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  turnover?: number;
}

/** 轉換後的報價：金額單位為億元，成交量為張。 */
export interface ParsedQuote {
  symbol: string;
  date?: string;
  prevClose?: number;
  price?: number;
  high?: number;
  low?: number;
  volume: number;
  turnover: number;
}

const YI = 1e8;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

export function parseQuote(raw: FugleQuoteRaw, symbol = raw.symbol ?? ''): ParsedQuote {
  const prevClose = num(raw.previousClose) ?? num(raw.referencePrice);
  const price = num(raw.lastPrice) ?? num(raw.closePrice);
  return {
    symbol,
    date: raw.date,
    prevClose,
    price,
    high: num(raw.highPrice) ?? price,
    low: num(raw.lowPrice) ?? price,
    volume: num(raw.total?.tradeVolume) ?? 0,
    turnover: (num(raw.total?.tradeValue) ?? 0) / YI,
  };
}

/** 由日 K 算出的盤前資料（不含今天）。 */
export interface Baseline {
  /** 計算時的最後一個交易日。 */
  asOf: string;
  /** 近 20 日平均成交額（億元）。 */
  avgTurnover20: number;
  /** 最後一個交易日的收盤價。 */
  lastClose: number;
  high52w: number;
  low52w: number;
  /** 近 20 日最高價。 */
  high20: number;
  ma5: number;
  ma20: number;
  ma60: number;
}

/** 由日 K 計算 20 日均額、均線與高低點。today 當天的 K 棒會被排除（盤中還在變動）。 */
export function computeBaseline(candles: FugleCandleRaw[], today: string): Baseline | null {
  const rows = candles
    .filter((c) => c.date < today && num(c.close) !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length === 0) return null;
  const last = <T>(arr: T[], n: number) => arr.slice(Math.max(0, arr.length - n));
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  const closes = rows.map((c) => c.close!);
  const turnovers = last(rows, 20)
    .map((c) => num(c.turnover) ?? (num(c.volume) && num(c.close) ? c.volume! * c.close! : 0))
    .filter((v) => v > 0);
  const highs = rows.map((c) => num(c.high) ?? c.close!);
  const lows = rows.map((c) => num(c.low) ?? c.close!);
  return {
    asOf: rows[rows.length - 1].date,
    avgTurnover20: mean(turnovers) / YI,
    lastClose: closes[closes.length - 1],
    high52w: Math.max(...highs),
    low52w: Math.min(...lows),
    high20: Math.max(...last(highs, 20)),
    ma5: mean(last(closes, 5)),
    ma20: mean(last(closes, 20)),
    ma60: mean(last(closes, 60)),
  };
}

/** 依固定間隔送出請求的佇列，避免超過每分鐘次數上限。 */
export class RateQueue {
  private readonly jobs: Array<() => Promise<void>> = [];
  private running = false;
  private pausedUntil = 0;
  private stopped = false;

  constructor(private readonly intervalMs: number) {}

  get size(): number {
    return this.jobs.length;
  }

  /** front = true 時插隊到最前面（例如台指期，不想排在上百檔股票後面）。 */
  push<T>(task: () => Promise<T>, front = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = () => task().then(resolve, reject);
      if (front) this.jobs.unshift(job);
      else this.jobs.push(job);
      void this.run();
    });
  }

  /** 被限流時暫停一段時間。 */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  stop(): void {
    this.stopped = true;
    this.jobs.length = 0;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length && !this.stopped) {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const job = this.jobs.shift()!;
      const started = Date.now();
      await job().catch(() => undefined);
      const rest = this.intervalMs - (Date.now() - started);
      if (rest > 0) await sleep(rest);
    }
    this.running = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FugleClient {
  readonly intraday: RateQueue;
  readonly historical: RateQueue;

  constructor(
    private readonly apiKey: string,
    perMinute = 55,
  ) {
    const interval = Math.ceil(60_000 / perMinute);
    this.intraday = new RateQueue(interval);
    this.historical = new RateQueue(interval);
  }

  quote(symbol: string, front = false): Promise<ParsedQuote> {
    return this.intraday.push(async () => parseQuote(await this.get<FugleQuoteRaw>(`/intraday/quote/${symbol}`, this.intraday), symbol), front);
  }

  /** 期貨報價（例如台指期近月 TXFJ6）。 */
  futQuote(symbol: string): Promise<ParsedQuote> {
    return this.intraday.push(async () =>
      parseQuote(await this.get<FugleQuoteRaw>(`/intraday/quote/${symbol}`, this.intraday, FUGLE_FUTOPT), symbol),
      true,
    );
  }

  /** 當日 1 分 K（給大盤走勢線用）。 */
  async intradayCandles(symbol: string): Promise<FugleCandleRaw[]> {
    const res = await this.intraday.push(() => this.get<{ data?: FugleCandleRaw[] }>(`/intraday/candles/${symbol}?timeframe=1`, this.intraday));
    return res.data ?? [];
  }

  /** 日 K（富果單次最多查一年）。 */
  async dailyCandles(symbol: string, from: string, to: string): Promise<FugleCandleRaw[]> {
    const q = `from=${from}&to=${to}&timeframe=D&fields=open,high,low,close,volume,turnover`;
    const res = await this.historical.push(() => this.get<{ data?: FugleCandleRaw[] }>(`/historical/candles/${symbol}?${q}`, this.historical));
    return res.data ?? [];
  }

  stop(): void {
    this.intraday.stop();
    this.historical.stop();
  }

  private async get<T>(path: string, queue: RateQueue, base = FUGLE_REST): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { headers: { 'X-API-KEY': this.apiKey } });
    } catch {
      throw new FugleError('network', '無法連線到富果 API');
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 || res.status === 403) throw new FugleError('auth', 'API 金鑰無效或沒有權限', res.status);
    if (res.status === 429) {
      queue.pauseFor(30_000);
      throw new FugleError('rate', '超過每分鐘次數上限，暫停 30 秒', res.status);
    }
    if (res.status === 404) throw new FugleError('not-found', '查無此代號', res.status);
    throw new FugleError('http', `富果 API 回應 ${res.status}`, res.status);
  }
}
