/**
 * 模擬盤的資料層：日 K、除權息、行情（Market）、交易日曆、股票名稱、加權指數、新聞、
 * 分析分頁用的基本面與籌碼。只負責「載入與查詢」，不碰畫面與帳戶狀態。
 */
import { loadOfficialCandles } from '../../data/candles';
import { loadChipSeries, loadTaiex, type ChipSeries } from '../../data/chipSeries';
import { loadNames, loadNews, loadSimFund, type NewsItem, type SimFund } from '../../data/simData';
import { loadPatternStats, type PatternStats } from '../../data/patternStats';
import { loadStockDirectory, searchDirectory, type DirEntry } from '../../data/stockDirectory';
import { SESSION_MINUTES } from '../../domain/intraday';
import { benchValue, buildMarket, type ExRight, type Market, type SimState } from '../../domain/sim';
import { adjustForSplits } from '../../domain/splits';
import { type Candle } from '../../domain/technicals';
import { investedAt, type SimCtx } from './util';

/** 交易日曆用這一檔的日 K（上市最久、每天都有成交）。 */
const CALENDAR_CODE = '0050';

export class SimData implements SimCtx {
  readonly candles = new Map<string, Candle[] | null>();
  private readonly loading = new Map<string, Promise<Candle[] | null>>();
  calendar: string[] | null | undefined;
  private calIndex = new Map<string, number>();
  dir: DirEntry[] = [];
  /** 代號 → 名稱（股票目錄＋已下市的名稱），查名稱 O(1)。 */
  private names = new Map<string, string>();
  taiex: Map<string, number> | null = null;
  /** 型態歷史勝率（全市場回測）。 */
  patStats: PatternStats | null = null;
  private readonly ex: ExRight[] = [];
  private readonly exYears = new Set<number>();
  market: Market = buildMarket(new Map());
  news: NewsItem[] = [];
  private readonly newsYears = new Set<string>();
  /** 分析分頁用的資料（undefined＝載入中，null＝沒有）。 */
  readonly funds = new Map<string, SimFund | null | undefined>();
  readonly chipData = new Map<string, ChipSeries | null | undefined>();
  /** 觀看中股票的可見 K 棒（同一分鐘內重複使用）。 */
  private barsCache: { key: string; bars: Candle[] | null } | null = null;

  /** 交易日曆、股票目錄、名稱、加權指數（進模擬盤前就先載入）。 */
  loadBasics(): Promise<void> {
    return Promise.all([
      this.fetchCandles(CALENDAR_CODE).then((c) => {
        this.calendar = c?.map((x) => x.date) ?? null;
        this.calIndex = new Map((this.calendar ?? []).map((d, i) => [d, i]));
      }),
      loadStockDirectory().then((d) => {
        this.dir = d?.stocks ?? [];
        for (const e of this.dir) if (!this.names.has(e.code)) this.names.set(e.code, e.name);
      }),
      // 已下市的名稱優先（names.json 是完整的歷史名稱）
      loadNames().then((n) => {
        for (const [code, name] of Object.entries(n)) this.names.set(code, name);
      }),
      loadTaiex().then((t) => {
        this.taiex = t;
      }),
      loadPatternStats().then((p) => {
        this.patStats = p;
      }),
    ]).then(() => undefined);
  }

  fetchCandles(code: string): Promise<Candle[] | null> {
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

  async fetchExRights(fromYear: number, toYear: number): Promise<void> {
    const todo: number[] = [];
    for (let y = fromYear; y <= toYear; y++) if (!this.exYears.has(y)) todo.push(y);
    if (!todo.length) return;
    for (const y of todo) this.exYears.add(y);
    const rows = await Promise.all(
      todo.map((y) =>
        fetch(`data/exrights/${y}.json`, { cache: 'no-cache' })
          .then((r) => (r.ok ? (r.json() as Promise<ExRight[]>) : []))
          .catch(() => [] as ExRight[]),
      ),
    );
    this.ex.push(...rows.flat().filter((r) => Array.isArray(r)));
    this.rebuildMarket();
  }

  private rebuildMarket(): void {
    const series = new Map<string, Candle[]>();
    for (const [code, c] of this.candles) if (c) series.set(code, c);
    this.market = buildMarket(series, this.ex);
    this.barsCache = null;
  }

  async loadNewsFor(date: string): Promise<void> {
    const years = [String(Number(date.slice(0, 4)) - 1), date.slice(0, 4)];
    const todo = years.filter((y) => !this.newsYears.has(y));
    if (!todo.length) return;
    for (const y of todo) this.newsYears.add(y);
    const lists = await Promise.all(todo.map((y) => loadNews(y)));
    this.news = [...this.news, ...lists.flat()].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  }

  nameOf(code: string): string {
    return this.names.get(code) ?? '';
  }

  /** d 之前最後一個交易日（d 不是交易日也可以）。 */
  prevDay = (d: string): string | undefined => {
    const cal = this.calendar;
    if (!cal?.length || cal[0] >= d) return undefined;
    const i = this.calIndex.get(d);
    if (i != null) return i > 0 ? cal[i - 1] : undefined;
    let lo = 0;
    let hi = cal.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cal[mid] < d) lo = mid;
      else hi = mid - 1;
    }
    return cal[lo];
  };

  /** 加權指數某天的收盤。 */
  indexAt = (d: string): number | undefined => this.taiex?.get(d);

  /** 名稱已經載入（交易紀錄、報告要顯示名稱）。 */
  get hasNames(): boolean {
    return this.names.size > 0;
  }

  /** 由輸入（代號或名稱）找到股票代號：股票目錄 → 歷史名稱（含已下市）→ 看起來像代號就直接用。 */
  findCode(q: string): string | undefined {
    const text = q.trim();
    const token = text.split(/\s+/)[0].toUpperCase();
    const hit = searchDirectory(this.dir, q)?.code;
    if (hit) return hit;
    if (this.names.has(token)) return token;
    for (const [code, name] of this.names) if (name === text) return code;
    return /^\d{4,6}[A-Z]?$/.test(token) ? token : undefined;
  }

  /** 同額投入大盤的對照組在 date 收盤的價值。 */
  benchAt(s: SimState, date: string): number | null {
    if (!this.taiex || !this.calendar) return null;
    return benchValue(s, this.indexAt, this.prevDay, date);
  }

  /** 對照組報酬：到最近一個已收盤的交易日（盤中不看今天，避免偷看）。 */
  benchOf(s: SimState): number | null {
    const lastDone = s.minute >= SESSION_MINUTES ? s.date : this.prevDay(s.date);
    if (!lastDone || lastDone < s.settings.start) return s.equity.length ? null : 0;
    const b = this.benchAt(s, lastDone);
    return b == null ? null : b / investedAt(s, lastDone) - 1;
  }

  /**
   * 觀看中股票：到昨天為止的日 K（已經發生的分割／減資還原成現在的基準），加上今天到現在為止的 K 棒。
   * 同一檔、同一分鐘重複呼叫時直接用上次的結果（畫面每秒會重畫好幾次）。
   */
  visibleBars(s: SimState): Candle[] | null {
    const all = this.candles.get(s.watch);
    if (!all) return null;
    const t = s.pre ? -1 : Math.min(SESSION_MINUTES, Math.floor(s.minute));
    const key = `${s.watch}|${s.date}|${t}|${all.length}`;
    if (this.barsCache?.key === key) return this.barsCache.bars;
    const past = adjustForSplits(
      all.filter((c) => c.date < s.date),
      this.market.splitsOf(s.watch),
      s.date,
    );
    const path = this.market.path(s.watch, s.date);
    let bars = past;
    if (path && t >= 0) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i <= t; i++) {
        hi = Math.max(hi, path.price[i]);
        lo = Math.min(lo, path.price[i]);
      }
      bars = [...past, { date: s.date, open: path.price[0], high: hi, low: lo, close: path.price[t], volume: Math.round(path.cumVolume[t]) }];
    }
    this.barsCache = { key, bars };
    return bars;
  }

  /** 分析分頁：載入某檔的基本面與籌碼（載入完呼叫 onLoad 重畫）。 */
  ensureAnalysis(code: string, onLoad: () => void): void {
    if (!this.funds.has(code)) {
      this.funds.set(code, undefined);
      void loadSimFund(code).then((f) => {
        this.funds.set(code, f);
        onLoad();
      });
    }
    if (!this.chipData.has(code)) {
      this.chipData.set(code, undefined);
      void loadChipSeries(code).then((c) => {
        this.chipData.set(code, c);
        onLoad();
      });
    }
  }
}
