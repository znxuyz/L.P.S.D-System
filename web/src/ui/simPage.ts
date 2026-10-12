/**
 * 拉普拉斯模擬盤頁面：回到過去的某一天，用模擬帳戶在「偽即時」盤中行情裡練習交易。
 *
 * - 時間：每個交易日 09:00～13:30，現實 1 秒＝盤中 1 分鐘（可選 1／3／5 倍），不能倒帶；
 *   暫停時不能交易；收盤後自動進入下一個交易日；也可以直接跳到隔天。
 * - 為了不讓玩家想起真實事件，畫面上看不到年月日：只顯示星期幾、時間與「第幾天」，日期一律顯示成亂碼；
 *   一局結束時才在結束報告裡揭曉真實日期。
 * - 新聞欄、今日排行、現股／當沖／融資／融券下單、停損停利、資金（薪資、信貸、質押）、收盤結算、朋友排行榜。
 *
 * 這個檔案是控制器（狀態、時鐘、雲端同步、事件）；各畫面的 HTML 在 ui/sim/ 底下：
 * lobby.ts（登入、大廳、排行榜、開新局）、panels.ts（遊戲中的面板）、report.ts（結束報告）、admin.ts（管理員）、charts.ts（圖表）。
 */
import { loadOfficialCandles } from '../data/candles';
import { loadTaiex } from '../data/chipSeries';
import { loadNames, loadNews, loadSimMonth, type NewsItem, type SimMonth } from '../data/simData';
import { loadStockDirectory, searchDirectory, type DirEntry } from '../data/stockDirectory';
import { SESSION_MINUTES, clock, intradayPath, type IntradayPath } from '../domain/intraday';
import { detectPatterns } from '../domain/patterns';
import {
  KIND_NAME,
  LOT,
  MARGIN_LOAN,
  SHORT_DEPOSIT,
  beginDay,
  benchValue,
  buildMarket,
  cancelOrder,
  closeDay,
  debtOf,
  equityOf,
  feeOf,
  investedOf,
  maintenance,
  migrate,
  newSim,
  openDay,
  placeOrder,
  pledgeBorrow,
  pledgeRelease,
  pledgeRepay,
  pledgedShares,
  priceNow,
  repayLoan,
  reservedCash,
  setDca,
  setStop,
  takeLoan,
  toggleFav,
  taxOf,
  tickTo,
  type ExRight,
  type Kind,
  type Market,
  type Side,
  type SimState,
} from '../domain/sim';
import { boardStats, type Window } from '../domain/simRank';
import {
  loadCodes,
  loadSave,
  openVault,
  rememberPlayers,
  rememberSyncId,
  rememberUser,
  rememberedPlayers,
  rememberedSyncId,
  rememberedUser,
  syncIdFor,
  trimSave,
  verifyCode,
  writeSave,
  type CodeEntry,
  type CodeList,
  type PlayerRef,
  type SimSave,
} from '../data/simAccount';
import { pullBoard, pushBoard, type BoardEntry } from '../data/simBoard';
import { loadSyncConfig, pullSave, pushSave, type SyncConfig } from '../data/simSync';
import { type Candle } from '../domain/technicals';
import { escapeHtml as esc, num, pct, price } from './format';
import { adminHtml, playerDetailHtml, type PlayerSave } from './sim/admin';
import { candleSvg, tickSvg } from './sim/charts';
import { WARMUP, boardHtml, gateHtml, lobbyHtml, setupHtml, type BoardRow } from './sim/lobby';
import { bankHtml, dayReportHtml, equityHtml, holdHtml, logHtml, newsHtml, stopHtml } from './sim/panels';
import { recordOf, reportHtml, verdict } from './sim/report';
import { askGuide, runGuide } from './sim/guide';
import { simGuideSteps } from './sim/guideSteps';
import { pickRandomStart } from '../domain/simScenarios';
import { adjustForSplits } from '../domain/splits';
import { renderLearnPage } from './learnPage';
import { fundHtml, techHtml } from './sim/analysis';
import { loadChipSeries, type ChipSeries } from '../data/chipSeries';
import { loadSimFund, type SimFund } from '../data/simData';
import { BIAS, actionName, cls, garble, investedAt, money, pctOrDash, setHtml, weekday, type SimCtx } from './sim/util';

/** 上次在模擬盤的哪個畫面（大廳／遊戲中），重新打開時用。 */
const VIEW_KEY = 'lplc.sim.view';
/** 交易日曆：0050 從 2003 年起每個交易日都有成交。 */
const CALENDAR_CODE = '0050';
/** 新手指引：問過（或看過）就記下來，不會每次都問。 */
const GUIDE_KEY = 'lplc.sim.guide';
/** 每天要不要先停在盤前（關掉的話收盤後直接進入下一天的盤中）。 */
const PRESTOP_KEY = 'lplc.sim.prestop';
/** 盤中畫面最多多久重畫一次（毫秒）：3×、5× 時每秒會走好幾分鐘，不用每一分鐘都重畫整個畫面。 */
const RENDER_MS = 250;
/** 盤中每隔幾分鐘自動存檔一次（收盤、暫停、離開時也會存）。 */
const SAVE_EVERY_MIN = 60;
/** 收盤後停留幾秒再進入下一個交易日。 */
const CLOSE_PAUSE_MS = 2500;
/** 排行榜：收盤後等這麼久才上傳（連續跳好幾天時只傳最後一次）；大廳裡的排行榜多久重新讀一次。 */
const BOARD_PUSH_MS = 20_000;
const BOARD_STALE_MS = 60_000;

type RankKey = 'up' | 'down' | 'vol' | 'high' | 'low' | 'fav';
const RANK_NAME: Record<RankKey, string> = { up: '漲幅', down: '跌幅', vol: '成交量', high: '高價', low: '低價', fav: '自選' };

interface RankRow {
  code: string;
  pc: number;
  path: IntradayPath;
}

type View = 'gate' | 'lobby' | 'setup' | 'play' | 'admin' | 'report';

/** 手機版分頁：一次只看一類，不用一路往下滑。 */
const SIM_TABS = [
  { id: 'trade', icon: '📈', title: '交易' },
  { id: 'hold', icon: '💼', title: '持股' },
  { id: 'money', icon: '💰', title: '資金' },
  { id: 'analysis', icon: '🔍', title: '分析' },
  { id: 'rank', icon: '🏆', title: '排行' },
  { id: 'news', icon: '📰', title: '新聞' },
  { id: 'learn', icon: '📘', title: '入門' },
] as const;
type SimTab = (typeof SIM_TABS)[number]['id'];
const TAB_KEY = 'lplc.sim.tab';

export class SimPage implements SimCtx {
  private state: SimState | null = null;
  private codeList: CodeList | null | undefined;
  private user: CodeEntry | null = null;
  private save: SimSave = { current: null, history: [] };
  private view: View = 'gate';
  /** 結束報告：看哪一份（sync = null 是自己的，否則是管理員在看某位玩家的）。 */
  private reportRef: { sync: string | null; i: number } | null = null;
  /** 管理員（玩家 0）：解開的玩家清單、讀到的各玩家存檔、正在看的玩家。 */
  private players: PlayerRef[] | null = null;
  private playerSaves = new Map<string, PlayerSave>();
  private adminLoading = false;
  private adminPick: string | null = null;
  /** 網頁一打開就在模擬盤、而且上次正在玩：登入後直接回到那一局。 */
  private resumePlay = false;
  private gateMsg = '';
  /** 雲端同步：設定（null = 沒設定）、這個玩家的同步 ID、狀態。 */
  private sync: SyncConfig | null | undefined;
  private syncId: string | null = null;
  private syncState: 'off' | 'syncing' | 'ok' | 'error' = 'off';
  private syncNote = '';
  /** 上次和雲端一致時的存檔時間；雲端比它新代表別台裝置改過。 */
  private syncedAt = 0;
  private pushTimer = 0;
  // 朋友排行榜
  private boardTab: Window = 'd5';
  private boardRows: BoardRow[] | null = null;
  private boardLoadedAt = 0;
  private boardLoading = false;
  private boardTimer = 0;
  private readonly candles = new Map<string, Candle[] | null>();
  private readonly loading = new Map<string, Promise<Candle[] | null>>();
  calendar: string[] | null | undefined;
  private calIndex = new Map<string, number>();
  private dir: DirEntry[] = [];
  private names: Record<string, string> = {};
  taiex: Map<string, number> | null = null;
  private ex: ExRight[] = [];
  private exYears = new Set<number>();
  market: Market = buildMarket(new Map());
  private started = false;
  // 下單面板與資金面板
  private side: Side = 'buy';
  private kind: Kind = 'cash';
  private unit: 'lot' | 'share' = 'lot';
  private msg = '';
  private bankMsg = '';
  private hints = true;
  /** 新手指引進行中（期間時鐘暫停）。 */
  private guiding = false;
  /** 每天先停在盤前。 */
  private preStop = (() => {
    try {
      return localStorage.getItem(PRESTOP_KEY) !== '0';
    } catch {
      return true;
    }
  })();
  // 時鐘
  private running = false;
  /** 打開股市入門時自動暫停的（回到看盤時自動繼續）。 */
  private pausedForLearn = false;

  /** 模擬盤正在播放（這時候不自動更新網頁）。 */
  get busy(): boolean {
    return !!this.state && this.view === 'play' && this.running;
  }
  private speed: 1 | 3 | 5 = 1;
  private raf = 0;
  private lastTs = 0;
  /** 收盤後要等到這個時間（performance.now）才進入下一天。 */
  private closedUntil = 0;
  private lastSavedMinute = -1;
  /** 上次重畫盤中畫面的時間，與是否有還沒畫上去的變化。 */
  private lastRender = 0;
  private dirty = false;
  /** 圖表大小：只在視窗大小改變時量（每次重畫都去讀寬度會強迫整頁重新排版）。 */
  private sizes = { kw: 0, kh: 0, ew: 0 };
  /** 分析分頁用的資料（undefined＝載入中，null＝沒有）。 */
  private readonly funds = new Map<string, SimFund | null | undefined>();
  private readonly chipData = new Map<string, ChipSeries | null | undefined>();
  /** 手機版目前的分頁。 */
  private tab: SimTab = (() => {
    try {
      // 股市入門不記：重新打開時回到看盤
      const t = localStorage.getItem(TAB_KEY) as SimTab | null;
      return t && t !== 'learn' ? t : 'trade';
    } catch {
      return 'trade';
    }
  })();
  /** K 線與分時圖每秒最多重畫一次（換股票、換日立即重畫）。 */
  private chartKey = '';
  private chartAt = 0;
  /** 不常變的面板快取（交易紀錄、資產曲線、新聞）：內容沒變就不重算。 */
  private panelCache = new Map<string, { key: string; html: string }>();
  /** 剛收盤的那一天（收盤結算面板閃一下提示）。 */
  private freshDay = '';
  // 排行與新聞
  private rankKey: RankKey = 'up';
  private rankCache: { date: string; rows: RankRow[] } | null = null;
  private rankLoading = '';
  private news: NewsItem[] = [];
  /** 表格列在 pointerdown 時已處理，忽略接著來的 click。 */
  private rowDown = 0;
  private newsYears = new Set<string>();

  constructor(private readonly root: HTMLElement) {}

  /** 網頁一打開就在模擬盤時呼叫（例如從手機主畫面重新打開）。 */
  resumeOnLaunch(): void {
    try {
      this.resumePlay = localStorage.getItem(VIEW_KEY) === 'play';
    } catch {
      this.resumePlay = false;
    }
  }

  /** 登入或進入模擬盤時要顯示的畫面：剛重新打開而且上次在玩就回到那一局，否則到大廳。 */
  private entryView(): 'lobby' | 'play' {
    const resume = this.resumePlay && !!this.state;
    this.resumePlay = false;
    if (resume) this.running = true;
    return resume ? 'play' : 'lobby';
  }

  /** 切到模擬盤時呼叫。 */
  show(): void {
    this.build();
    // 每次進來先到大廳，讓玩家選「接續」或「開新的模擬」
    if (this.user) {
      this.view = this.entryView();
      void this.pull();
    }
    this.preload();
    this.render();
    this.startLoop();
  }

  /** 離開模擬盤（回到其他頁面）時呼叫：停止時鐘並存檔。 */
  hide(): void {
    this.stopLoop();
    if (this.state && this.view === 'play') this.persist();
    this.flushBoard();
  }

  /**
   * 先在背景下載模擬盤要用的資料（開通碼、交易日曆、股票目錄、名稱、加權指數）。
   * 網頁閒置時就呼叫，進模擬盤時資料多半已經處理好。
   */
  preload(): void {
    if (this.started) return;
    this.started = true;
    void Promise.all([loadCodes(), loadSyncConfig()]).then(([list, sync]) => {
      this.codeList = list;
      this.sync = sync;
      const id = rememberedUser();
      const entry = id ? list?.codes.find((c) => c.id === id) : undefined;
      if (entry) this.login(entry);
      else this.render();
    });
    void Promise.all([
      this.fetchCandles(CALENDAR_CODE).then((c) => {
        this.calendar = c?.map((x) => x.date) ?? null;
        this.calIndex = new Map((this.calendar ?? []).map((d, i) => [d, i]));
      }),
      loadStockDirectory().then((d) => (this.dir = d?.stocks ?? [])),
      loadNames().then((n) => (this.names = n)),
      loadTaiex().then((t) => (this.taiex = t)),
    ]).then(() => this.prepare());
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

  private async fetchExRights(fromYear: number, toYear: number): Promise<void> {
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
  }

  /** 目前用到的股票（觀看中、有部位、委託中、質押中）都要有日 K。 */
  private neededCodes(): string[] {
    const s = this.state;
    if (!s) return [];
    return [...new Set([s.watch, ...s.pos.map((p) => p.code), ...s.orders.map((o) => o.code), ...s.pledges.map((p) => p.code), ...s.dca.map((p) => p.code)])];
  }

  private async prepare(): Promise<void> {
    const s = this.state;
    if (s) {
      const y = Number(s.date.slice(0, 4));
      await Promise.all([
        ...this.neededCodes().map((c) => this.fetchCandles(c)),
        this.fetchExRights(Number(s.settings.start.slice(0, 4)), y + 1),
        this.loadNewsFor(s.date),
      ]);
    }
    this.render();
  }

  private async loadNewsFor(date: string): Promise<void> {
    const years = [String(Number(date.slice(0, 4)) - 1), date.slice(0, 4)];
    const todo = years.filter((y) => !this.newsYears.has(y));
    if (!todo.length) return;
    for (const y of todo) this.newsYears.add(y);
    const lists = await Promise.all(todo.map((y) => loadNews(y)));
    this.news = [...this.news, ...lists.flat()].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  }

  nameOf(code: string): string {
    return this.names[code] ?? this.dir.find((d) => d.code === code)?.name ?? '';
  }

  private prevDay = (d: string): string | undefined => {
    const cal = this.calendar;
    if (!cal) return undefined;
    const i = this.calIndex.get(d);
    if (i != null) return i > 0 ? cal[i - 1] : undefined;
    // 不是交易日：找它之前最後一個交易日
    let lo = 0;
    let hi = cal.length - 1;
    if (!cal.length || cal[0] >= d) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cal[mid] < d) lo = mid;
      else hi = mid - 1;
    }
    return cal[lo];
  };

  private index = (d: string): number | undefined => this.taiex?.get(d);

  /** 同額投入大盤的對照組在 date 收盤的價值。 */
  benchAt(s: SimState, date: string): number | null {
    if (!this.taiex || !this.calendar) return null;
    return benchValue(s, this.index, this.prevDay, date);
  }

  /** 對照組報酬：到最近一個已收盤的交易日（盤中不看今天，避免偷看）。 */
  benchOf(s: SimState): number | null {
    const lastDone = s.minute >= SESSION_MINUTES ? s.date : this.prevDay(s.date);
    if (!lastDone || lastDone < s.settings.start) return s.equity.length ? null : 0;
    const b = this.benchAt(s, lastDone);
    return b == null ? null : b / investedAt(s, lastDone) - 1;
  }

  // ------------------------------------------------------------ 帳號

  private login(entry: CodeEntry, syncId?: string, players?: PlayerRef[]): void {
    this.user = entry;
    if (entry.admin) {
      if (players) rememberPlayers(players);
      this.players = players ?? rememberedPlayers();
    } else this.players = null;
    rememberUser(entry.id);
    if (syncId) rememberSyncId(entry.id, syncId);
    this.syncId = syncId ?? rememberedSyncId(entry.id);
    this.save = loadSave(entry.id);
    this.state = this.save.current;
    this.syncedAt = 0;
    this.view = this.entryView();
    this.gateMsg = '';
    this.boardRows = null;
    this.boardLoadedAt = 0;
    void this.prepare();
    void this.pull();
  }

  // ------------------------------------------------------------ 雲端同步

  private canSync(): boolean {
    return !!(this.sync && this.syncId && this.user);
  }

  private adopt(remote: SimSave, note: string): void {
    this.save = { current: migrate(remote.current), history: remote.history, updatedAt: remote.updatedAt };
    this.state = this.save.current;
    writeSave(this.user!.id, this.save);
    this.syncedAt = remote.updatedAt ?? 0;
    this.syncNote = note;
    if (this.view === 'play' && !this.state) this.view = 'lobby';
    void this.prepare();
  }

  /** 從雲端拉存檔：雲端比較新就用雲端的，本機比較新就推上去。 */
  private async pull(): Promise<void> {
    if (!this.canSync()) {
      this.syncState = 'off';
      return;
    }
    const user = this.user;
    this.syncState = 'syncing';
    this.render();
    try {
      const remote = await pullSave(this.sync!, this.syncId!);
      if (this.user !== user) return;
      const local = this.save.updatedAt ?? 0;
      if (remote && (remote.updatedAt ?? 0) > local && !(this.view === 'play' && this.running)) this.adopt(remote, '已載入雲端上最新的進度');
      else if (!remote || local > (remote.updatedAt ?? 0)) {
        this.syncedAt = remote?.updatedAt ?? 0;
        if (this.save.current || this.save.history.length) await this.push();
      } else this.syncedAt = local;
      this.syncState = 'ok';
    } catch {
      this.syncState = 'error';
    }
    this.render();
  }

  /** 推到雲端前先確認雲端沒有被別台裝置改過；改過就以雲端為準。 */
  private async push(): Promise<void> {
    if (!this.canSync()) return;
    window.clearTimeout(this.pushTimer);
    this.pushTimer = 0;
    this.syncState = 'syncing';
    try {
      const remote = await pullSave(this.sync!, this.syncId!);
      if (remote && (remote.updatedAt ?? 0) > this.syncedAt && (remote.updatedAt ?? 0) !== this.save.updatedAt) {
        this.adopt(remote, '另一台裝置有比較新的進度，已改用雲端上的進度');
      } else {
        const save = { ...this.save };
        await pushSave(this.sync!, this.syncId!, save);
        this.syncedAt = save.updatedAt ?? 0;
      }
      this.syncState = 'ok';
    } catch {
      this.syncState = 'error';
    }
  }

  private schedulePush(): void {
    if (!this.canSync()) return;
    window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => void this.push(), 1500);
  }

  /** 關閉或切走網頁時，把還沒送出的進度送出去。 */
  private flush(): void {
    if (!this.pushTimer || !this.canSync()) return;
    window.clearTimeout(this.pushTimer);
    this.pushTimer = 0;
    void pushSave(this.sync!, this.syncId!, { ...this.save }, true).then(
      () => (this.syncedAt = this.save.updatedAt ?? 0),
      () => (this.syncState = 'error'),
    );
  }

  private syncBadge(): string {
    if (!this.sync) return '<span class="sim-sync is-off">未設定雲端同步，紀錄只存在這台裝置</span>';
    if (!this.syncId) return '<span class="sim-sync is-off">請重新輸入一次開通碼以開啟雲端同步</span>';
    const label = { off: '', syncing: '同步中⋯⋯', ok: '已同步到雲端', error: '暫時連不上雲端，進度先存在這台裝置' }[this.syncState];
    return `<span class="sim-sync is-${this.syncState}">☁ ${label}</span>`;
  }

  // ------------------------------------------------------------ 朋友排行榜

  /** 收盤後過一陣子上傳自己的成績（連續跳好幾天只傳最後一次）。 */
  private scheduleBoard(): void {
    if (!this.canSync() || !this.user?.board) return;
    window.clearTimeout(this.boardTimer);
    this.boardTimer = window.setTimeout(() => this.flushBoard(), BOARD_PUSH_MS);
  }

  private flushBoard(): void {
    if (!this.boardTimer) return;
    window.clearTimeout(this.boardTimer);
    this.boardTimer = 0;
    const s = this.state;
    if (!s || !s.equity.length || !this.canSync() || !this.taiex || !this.calendar) return;
    const stats = boardStats(s, this.index, this.prevDay);
    void pushBoard(this.sync!, this.syncId!, stats).then(
      () => (this.boardLoadedAt = 0),
      () => undefined,
    );
  }

  private async loadBoard(): Promise<void> {
    const list = this.codeList;
    if (!this.sync || !list || this.boardLoading) return;
    this.boardLoading = true;
    const entries = list.codes.filter((c) => c.board);
    const rows: BoardRow[] = entries.map((c) => ({ label: c.label, self: c.id === this.user?.id, entry: this.boardRows?.find((r) => r.label === c.label)?.entry }));
    this.boardRows = rows;
    this.renderLobbyBoard();
    await Promise.all(
      entries.map((c, i) =>
        pullBoard(this.sync!, c.board!)
          .then((e: BoardEntry | null) => (rows[i].entry = e))
          .catch(() => (rows[i].entry = 'error')),
      ),
    );
    this.boardLoading = false;
    this.boardLoadedAt = Date.now();
    this.renderLobbyBoard();
  }

  private boardSection(): string {
    if (this.sync && Date.now() - this.boardLoadedAt > BOARD_STALE_MS && !this.boardLoading) queueMicrotask(() => void this.loadBoard());
    return `<div id="sim-board">${boardHtml(this.sync ? this.boardRows ?? [] : null, this.boardTab, this.boardLoading)}</div>`;
  }

  private renderLobbyBoard(): void {
    const el = this.root.querySelector<HTMLElement>('#sim-board');
    if (el && this.view === 'lobby') setHtml(el, boardHtml(this.sync ? this.boardRows ?? [] : null, this.boardTab, this.boardLoading));
  }

  // ------------------------------------------------------------ 登入、登出、存檔

  private logout(): void {
    this.stopLoop();
    this.flush();
    this.flushBoard();
    this.user = null;
    this.syncId = null;
    this.syncNote = '';
    this.state = null;
    this.save = { current: null, history: [] };
    rememberUser(null);
    rememberPlayers(null);
    this.players = null;
    this.playerSaves.clear();
    this.adminPick = null;
    this.boardRows = null;
    this.view = 'gate';
    this.render();
  }

  private async unlock(form: HTMLFormElement): Promise<void> {
    const code = String(new FormData(form).get('code') ?? '');
    if (!this.codeList) {
      this.gateMsg = '開通碼清單還沒載入，請稍後再試';
      return this.render();
    }
    const entry = await verifyCode(code, this.codeList);
    if (!entry) {
      this.gateMsg = '開通碼不正確';
      return this.render();
    }
    // 管理員：用開通碼解開所有玩家的雲端同步 ID
    let players: PlayerRef[] | undefined;
    if (entry.admin) {
      try {
        players = await openVault(code, this.codeList);
      } catch {
        players = [];
      }
    }
    this.login(entry, await syncIdFor(code, this.codeList.salt), players);
  }

  private persist(): void {
    if (!this.user) return;
    this.save.current = this.state;
    this.save.updatedAt = Date.now();
    // 歷史紀錄的容量檢查（要把整份存檔轉成文字）只在封存一局時做，平常存檔不做
    writeSave(this.user.id, this.save);
    this.schedulePush();
    if (this.state) this.lastSavedMinute = this.state.minute;
  }

  /** 把目前這一局存進歷史紀錄（含完整明細，至少玩過一天才記）。回傳是否有存。 */
  private archive(): boolean {
    const s = this.state;
    if (!s || !s.equity.length) return false;
    // 結束前把最後的成績傳到排行榜
    if (this.canSync() && this.user?.board) {
      this.boardTimer ||= -1;
      this.flushBoard();
    }
    this.save.history.unshift(recordOf(s, this));
    trimSave(this.save);
    return true;
  }

  // ------------------------------------------------------------ 時鐘

  private startLoop(): void {
    if (this.raf) return;
    this.lastTs = 0;
    const loop = (ts: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(ts);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 每個畫面影格：時間往前走，到收盤時結算並進入下一天。 */
  private frame(ts: number): void {
    const s = this.state;
    const prevTs = this.lastTs;
    this.lastTs = ts;
    if (!s || this.view !== 'play' || !this.running || s.pre || document.hidden || !document.querySelector('.app.page-sim')) return;
    if (!prevTs) return;
    const dt = Math.min(1000, ts - prevTs);
    if (this.dirty && ts - this.lastRender >= RENDER_MS) this.renderNow(ts);
    if (s.minute >= SESSION_MINUTES) {
      // 收盤：停留一下再進入下一個交易日
      if (!this.closedUntil) this.closedUntil = ts + CLOSE_PAUSE_MS;
      if (ts >= this.closedUntil) {
        this.closedUntil = 0;
        void this.nextDay();
      }
      return;
    }
    const before = Math.floor(s.minute);
    const target = s.minute + (dt / 1000) * this.speed;
    if (Math.floor(target) > before) {
      tickTo(s, this.market, Math.floor(target));
      s.minute = Math.min(SESSION_MINUTES, target);
      if (Math.floor(s.minute) >= SESSION_MINUTES) {
        this.closeToday();
        this.renderNow(ts);
      } else {
        if (Math.floor(s.minute) - this.lastSavedMinute >= SAVE_EVERY_MIN) this.persist();
        if (ts - this.lastRender >= RENDER_MS) this.renderNow(ts);
        else this.dirty = true;
      }
    } else s.minute = target;
  }

  private renderNow(ts: number): void {
    this.lastRender = ts;
    this.dirty = false;
    this.renderPlay();
  }

  private measure(): void {
    const k = this.root.querySelector<HTMLElement>('#sim-k');
    const e = this.root.querySelector<HTMLElement>('#sim-equity');
    // 手機上切到別的分頁時圖表是隱藏的（寬度 0），沿用上次量到的大小
    this.sizes = { kw: k?.clientWidth || this.sizes.kw, kh: k?.clientHeight || this.sizes.kh, ew: e?.clientWidth || this.sizes.ew };
  }

  /** 手機版的分頁（桌機版全部並排，分頁列不顯示）。 */
  private setTab(tab: SimTab, scroll: boolean): void {
    if (!SIM_TABS.some((t) => t.id === tab)) tab = 'trade';
    const wasLearn = this.tab === 'learn';
    this.tab = tab;
    if (tab === 'learn') {
      renderLearnPage(this.root.querySelector<HTMLElement>('#sim-learn .learn')!, 'sim-learn');
      // 看股市入門時先暫停，回到看盤再繼續
      if (scroll && this.running) {
        this.running = false;
        this.pausedForLearn = true;
        this.persist();
      }
    } else if (wasLearn && this.pausedForLearn) {
      this.pausedForLearn = false;
      if (this.state && this.view === 'play' && !this.isEnd(this.state)) this.running = true;
    }
    this.root.dataset.tab = tab;
    const bar = this.root.querySelector<HTMLElement>('#sim-tabs');
    // 電腦版的 K 線與下單一直都在，「交易」分頁時下面顯示持股
    const shown = tab === 'trade' && matchMedia('(min-width: 981px)').matches ? 'hold' : tab;
    for (const b of bar?.querySelectorAll<HTMLElement>('[data-sim-tab]') ?? []) {
      const on = b.dataset.simTab === shown;
      b.setAttribute('aria-selected', String(on));
      if (on && bar) bar.scrollLeft = b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2;
    }
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* 存不了就算了 */
    }
    if (!scroll) return;
    // 分頁列已經黏在上面（往下捲過了）時，回到這個分頁的開頭
    const head = this.root.querySelector<HTMLElement>('#sim-head');
    const top = head ? head.getBoundingClientRect().bottom + window.scrollY : 0;
    if (window.scrollY > top) window.scrollTo({ top });
    this.measure();
    this.chartKey = '';
    this.panelCache.clear();
    this.render();
  }

  /** 內容的關鍵值沒變就沿用上次產生的 HTML。 */
  private cached(id: string, key: string, build: () => string): string {
    const c = this.panelCache.get(id);
    if (c && c.key === key) return c.html;
    const html = build();
    this.panelCache.set(id, { key, html });
    return html;
  }

  private closeToday(): void {
    const s = this.state;
    if (!s || s.equity.at(-1)?.[0] === s.date) return;
    closeDay(s, this.market);
    this.freshDay = s.date;
    if (s.bankrupt) {
      // 破產：這一局結束，時間停住，等玩家看結束報告
      this.running = false;
      this.msg = '';
    }
    this.persist();
    this.scheduleBoard();
  }

  /** 進入下一個交易日（若今天還沒收盤就先收盤）。 */
  private async nextDay(): Promise<void> {
    const s = this.state;
    const cal = this.calendar;
    if (!s || !cal || s.bankrupt) return;
    await Promise.all(this.neededCodes().map((c) => this.fetchCandles(c)));
    // 盤前直接跳到隔天：先開盤撮合盤前委託，再走完今天
    if (s.pre) openDay(s, this.market);
    if (s.minute < SESSION_MINUTES || s.equity.at(-1)?.[0] !== s.date) {
      tickTo(s, this.market, SESSION_MINUTES);
      this.closeToday();
    }
    const i = cal.indexOf(s.date);
    const next = i >= 0 ? cal[i + 1] : cal.find((d) => d > s.date);
    if (!next) {
      this.running = false;
      this.msg = '';
      this.render();
      return;
    }
    beginDay(s, this.market, next, this.preStop);
    this.closedUntil = 0;
    this.freshDay = '';
    this.msg = '';
    this.bankMsg = '';
    this.persist();
    await this.prepare();
  }

  /** 新手指引：暫停時鐘，一步一步框出畫面上的區塊；結束後恢復。 */
  private startGuide(): void {
    if (this.guiding || this.view !== 'play') return;
    this.guiding = true;
    try {
      localStorage.setItem(GUIDE_KEY, 'seen');
    } catch {
      /* 存不了就算了 */
    }
    const wasRunning = this.running;
    this.running = false;
    this.render();
    const tabBefore = this.tab;
    runGuide(simGuideSteps(this.root, (tab) => this.setTab(tab as SimTab, false)), () => {
      this.setTab(tabBefore, false);
      this.guiding = false;
      this.running = wasRunning;
      this.render();
    });
  }

  /** 第一次進到遊戲畫面時問要不要看新手指引（只問一次）。 */
  private maybeAskGuide(): void {
    if (this.guiding || this.view !== 'play') return;
    try {
      if (localStorage.getItem(GUIDE_KEY)) return;
      localStorage.setItem(GUIDE_KEY, 'asked');
    } catch {
      return;
    }
    this.guiding = true;
    const wasRunning = this.running;
    this.running = false;
    this.render();
    // 等畫面排好再問
    setTimeout(
      () =>
        askGuide(
          () => {
            this.guiding = false;
            this.running = wasRunning;
            this.startGuide();
          },
          () => {
            this.guiding = false;
            this.running = wasRunning;
            this.render();
          },
        ),
      400,
    );
  }

  /** 開盤：盤前委託、定期定額以開盤價撮合，時間開始從 09:00 往前走。 */
  private async open(): Promise<void> {
    const s = this.state;
    if (!s?.pre || s.bankrupt) return;
    await Promise.all(this.neededCodes().map((c) => this.fetchCandles(c)));
    if (!s.pre) return;
    const before = s.trades.length;
    openDay(s, this.market);
    const filled = s.trades.length - before;
    this.msg = filled ? `開盤：${filled} 筆盤前委託以開盤價成交` : '';
    this.running = true;
    this.lastSavedMinute = 0;
    this.persist();
    this.render();
  }

  /** 這一局不能再往前走了：玩到最新資料，或破產。 */
  private isEnd(s: SimState): boolean {
    if (s.bankrupt) return true;
    const cal = this.calendar ?? [];
    return cal.length > 0 && s.date >= cal[cal.length - 1] && s.minute >= SESSION_MINUTES;
  }

  // ------------------------------------------------------------ 操作

  private start(dateWanted: string | null, form: HTMLFormElement): void {
    const cal = this.calendar;
    if (!cal?.length) return;
    const fd = new FormData(form);
    const capital = Math.max(10_000, Number(fd.get('capital')) || 1_000_000);
    const monthly = Math.max(0, Math.round(Number(fd.get('monthly')) || 0));
    const ruinRaw = Number(fd.get('ruin'));
    const ruinLoss = [0, 0.5, 0.8, 1].includes(ruinRaw) ? ruinRaw : 1;
    const discount = Math.min(1, Math.max(0.1, Number(fd.get('discount')) || 0.6));
    const minIdx = Math.min(WARMUP, cal.length - 1);
    let idx: number;
    let scenario: string | undefined;
    // 隨機：從值得練習的行情裡抽，或抽一個至少一年前的日期
    if (dateWanted == null) ({ idx, scenario } = pickRandomStart(cal, minIdx));
    else {
      idx = cal.findIndex((d) => d >= dateWanted);
      if (idx < 0) idx = cal.length - 1;
      idx = Math.max(idx, minIdx);
    }
    this.archive();
    this.state = newSim({ start: cal[idx], capital, discount, monthly, ruinLoss, scenario }, this.state?.watch ?? '2330', this.preStop);
    this.msg = '';
    this.bankMsg = '';
    this.view = 'play';
    this.running = true;
    this.rankCache = null;
    this.persist();
    void this.prepare();
  }

  private async watch(q: string): Promise<void> {
    const s = this.state;
    if (!s || !q.trim()) return;
    const token = q.trim().split(/\s+/)[0].toUpperCase();
    const hit =
      searchDirectory(this.dir, q)?.code ??
      (this.names[token] ? token : Object.entries(this.names).find(([, n]) => n === q.trim())?.[0]) ??
      (/^\d{4,6}[A-Z]?$/.test(token) ? token : undefined);
    if (!hit) {
      this.msg = `找不到「${q}」`;
      return this.render();
    }
    s.watch = hit;
    this.msg = '';
    this.render();
    await this.fetchCandles(hit);
    this.render();
  }

  private order(form: HTMLFormElement): void {
    const s = this.state;
    if (!s) return;
    if (!this.running && !s.pre) {
      this.msg = '暫停中不能交易，請先按「繼續」';
      return this.render();
    }
    const fd = new FormData(form);
    const qty = Number(fd.get('qty'));
    const shares = Math.round(qty * (this.unit === 'lot' ? LOT : 1));
    const limitRaw = String(fd.get('limit') ?? '').trim();
    const limit = fd.get('type') === 'limit' && limitRaw ? Number(limitRaw) : undefined;
    if (fd.get('type') === 'limit' && !limitRaw) {
      this.msg = '限價單要填價格';
      return this.render();
    }
    const before = s.trades.length;
    const err = placeOrder(s, this.market, { code: s.watch, side: this.side, kind: this.kind, shares, limit });
    const filled = s.trades.length > before;
    this.msg =
      err ??
      `${actionName(this.kind, this.side)} ${s.watch} ${num(shares)} 股${
        s.pre ? `${limit ? `，限價 ${limit}` : '，市價'}，開盤時以開盤價撮合` : filled ? `，已成交 @ ${price(s.trades[s.trades.length - 1].price)}` : `，限價 ${limit} 掛單中`
      }`;
    if (!err) this.persist();
    this.render();
  }

  /** 停損／停利的表單。 */
  private stop(form: HTMLFormElement, clear = false): void {
    const s = this.state;
    if (!s) return;
    const fd = new FormData(form);
    const val = (k: string) => {
      const v = String(fd.get(k) ?? '').trim();
      return v && !clear ? Number(v) : undefined;
    };
    const kind = form.dataset.kind as Kind;
    const dir = form.dataset.dir as 'long' | 'short';
    const loss = val('loss');
    const profit = val('profit');
    const err = setStop(s, this.market, s.watch, kind, dir, loss, profit);
    this.msg = err ?? (loss == null && profit == null ? `已取消 ${s.watch} 的停損／停利` : `已設定 ${s.watch} ${KIND_NAME[kind]}${loss != null ? `停損 ${loss}` : ''}${loss != null && profit != null ? '、' : ''}${profit != null ? `停利 ${profit}` : ''}`);
    if (!err) this.persist();
    this.render();
  }

  /** 資金面板的表單（信貸、質押）。 */
  private bank(form: HTMLFormElement): void {
    const s = this.state;
    if (!s) return;
    const fd = new FormData(form);
    const n = (k: string) => Math.round(Number(fd.get(k)) || 0);
    let err: string | null = null;
    let ok = '';
    switch (form.dataset.form) {
      case 'loan':
        err = takeLoan(s, n('amount'), n('months'));
        ok = '信貸已入帳';
        break;
      case 'loan-repay':
        err = repayLoan(s, Number(form.dataset.id), n('amount'));
        ok = '已還款';
        break;
      case 'pledge':
        err = pledgeBorrow(s, this.market, String(fd.get('code')), n('shares'), n('amount'));
        ok = '質押完成';
        break;
      case 'pledge-repay':
        err = pledgeRepay(s, form.dataset.code!, n('amount'));
        ok = '已還款';
        break;
      case 'pledge-release':
        err = pledgeRelease(s, this.market, form.dataset.code!, n('shares'));
        ok = '已解除質押';
        break;
      case 'dca': {
        const code = String(fd.get('code'));
        err = setDca(s, code, n('amount'));
        ok = `已設定 ${code} 每月定期定額 ${n('amount').toLocaleString()} 元`;
        if (!err) void this.fetchCandles(code);
        break;
      }
    }
    this.bankMsg = err ?? ok;
    if (!err) this.persist();
    this.render();
  }

  private reset(): void {
    if (!this.state?.bankrupt && !confirm('結束這一局？會揭曉這一局的真實日期，成績存進歷史紀錄。')) return;
    if (this.state && this.state.minute > 0 && this.state.equity.at(-1)?.[0] !== this.state.date) this.closeToday();
    const saved = this.archive();
    this.state = null;
    this.running = false;
    this.msg = '';
    this.persist();
    this.reportRef = saved ? { sync: null, i: 0 } : null;
    this.view = saved ? 'report' : 'lobby';
    this.render();
    this.root.scrollIntoView({ block: 'start' });
  }

  // ------------------------------------------------------------ 畫面

  private build(): void {
    const root = this.root;
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="sim-head glass" id="sim-head"></div>
      <div class="sim-main">
        <nav class="sim-tabs glass" id="sim-tabs" role="tablist" aria-label="模擬盤畫面">
          ${SIM_TABS.map((t) => `<button type="button" role="tab" data-sim-tab="${t.id}" aria-selected="false"><span aria-hidden="true">${t.icon}</span>${t.title}</button>`).join('')}
        </nav>
        <div class="sim-chart glass" id="sim-chart" data-pane="trade"></div>
        <div class="sim-panes">
          <div class="sim-dayrep-panel glass" id="sim-dayrep" data-pane="hold"></div>
          <div class="sim-hold glass" id="sim-hold" data-pane="hold"></div>
          <div class="sim-log glass" id="sim-log" data-pane="hold"></div>
          <div class="sim-bank glass" id="sim-bank" data-pane="money"></div>
          <div class="sim-equity glass" id="sim-equity" data-pane="money"></div>
          <div class="sim-fund glass" id="sim-fund" data-pane="analysis"></div>
          <div class="sim-tech glass" id="sim-tech" data-pane="analysis"></div>
          <div class="sim-rank glass" id="sim-rank" data-pane="rank"></div>
          <div class="sim-news glass" id="sim-news" data-pane="news"></div>
        </div>
      </div>
      <div class="sim-aside">
        <div class="sim-order glass" id="sim-order" data-pane="trade"></div>
      </div>
      <div class="sim-learn" id="sim-learn" data-pane="learn"><div class="learn"></div></div>
      <div class="sim-setup glass" id="sim-setup"></div>`;
    // 頂端列「離開」旁邊顯示玩家名稱
    document.querySelector('#sim-who')?.addEventListener('click', () => {
      if (this.user) {
        this.hide();
        this.view = 'lobby';
        this.render();
      }
    });
    // 排行、部位的表格每分鐘都會重畫：按下去的當下就切換，不等放開（放開時那一列可能已經換掉了）
    root.addEventListener('pointerdown', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('tr[data-sim="watch"]');
      if (!row || e.button !== 0) return;
      this.rowDown = Date.now();
      void this.watch(row.dataset.code!);
    });
    this.setTab(this.tab, false);
    root.addEventListener('click', (e) => {
      const tab = (e.target as Element).closest<HTMLElement>('[data-sim-tab]');
      if (tab) return this.setTab(tab.dataset.simTab as SimTab, true);
      const el = (e.target as Element).closest<HTMLElement>('[data-sim]');
      if (!el) return;
      if (el.matches('tr[data-sim="watch"]') && Date.now() - this.rowDown < 800) return;
      this.action(el.dataset.sim!, el);
    });
    root.addEventListener('keydown', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('tr[data-sim="report"], tr[data-sim="pick"]');
      if (el && e.key === 'Enter') this.action(el.dataset.sim!, el);
    });
    root.addEventListener('submit', (e) => {
      const form = e.target as HTMLFormElement;
      e.preventDefault();
      if (form.id === 'sim-gate-form') void this.unlock(form);
      else if (form.id === 'sim-setup-form') this.start(String(new FormData(form).get('start') || ''), form);
      else if (form.id === 'sim-search') void this.watch(new FormData(form).get('q') as string);
      else if (form.id === 'sim-order-form') this.order(form);
      else if (form.classList.contains('sim-stop')) this.stop(form);
      else if (form.dataset.form) this.bank(form);
    });
    root.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).closest('#sim-order-form')) this.renderEstimate();
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'type') {
        const lim = root.querySelector<HTMLInputElement>('#sim-limit');
        if (lim) {
          lim.disabled = t.value !== 'limit';
          if (t.value === 'limit' && !lim.value && this.state) lim.value = String(priceNow(this.state, this.market, this.state.watch) ?? '');
        }
        this.renderEstimate();
      }
    });
    // 視窗寬度改變時重畫圖表
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 在這一格還沒改任何東西之前量，不會強迫重新排版
        this.measure();
        this.chartKey = '';
        this.render();
      });
    }).observe(root);
    window.addEventListener('pagehide', () => {
      if (this.state && this.view === 'play') this.persist();
      this.flush();
      this.flushBoard();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (this.state && this.view === 'play') this.persist();
        this.flush();
        this.flushBoard();
      }
      // 回到這個分頁時看看別台裝置有沒有新進度（玩到一半不打斷）
      else if (this.user && this.view !== 'play') void this.pull();
    });
    // 空白鍵暫停／繼續、→ 直接到隔天（不在輸入框時）
    window.addEventListener('keydown', (e) => {
      if (!document.querySelector('.app.page-sim') || !this.state || this.view !== 'play' || this.guiding) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,button') || document.querySelector('.laplace-intro')) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (this.state.pre) void this.open();
        else {
          this.running = !this.running;
          this.render();
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        void this.nextDay();
      }
    });
  }

  private action(a: string, el: HTMLElement): void {
    if (a === 'guide') this.startGuide();
    else if (a === 'open') void this.open();
    else if (a === 'prestop') {
      this.preStop = !this.preStop;
      try {
        localStorage.setItem(PRESTOP_KEY, this.preStop ? '1' : '0');
      } catch {
        /* 存不了就只在這次有效 */
      }
      this.render();
    } else if (a === 'play') {
      this.running = !this.running;
      if (!this.running) this.persist();
      this.msg = '';
      this.render();
    } else if (a.startsWith('speed')) {
      this.speed = Number(a.slice(5)) as 1 | 3 | 5;
      this.render();
    } else if (a === 'nextday') void this.nextDay();
    else if (a === 'reset') this.reset();
    else if (a === 'lobby') {
      if (this.state && this.view === 'play') this.persist();
      this.view = 'lobby';
      this.render();
    } else if (a === 'resume') {
      this.syncNote = '';
      this.view = 'play';
      this.running = true;
      void this.prepare();
    } else if (a === 'new') {
      this.syncNote = '';
      this.view = 'setup';
      this.render();
    } else if (a === 'logout') this.logout();
    else if (a === 'admin' || a === 'admin-refresh') {
      this.view = 'admin';
      this.adminPick = null;
      if (a === 'admin-refresh' || !this.playerSaves.size) void this.loadPlayers();
      else this.render();
    } else if (a === 'pick') {
      this.adminPick = el.dataset.sync ?? null;
      this.render();
      this.root.scrollIntoView({ block: 'start' });
    } else if (a === 'report') {
      this.reportRef = { sync: el.dataset.sync ?? null, i: Number(el.dataset.i) };
      this.view = 'report';
      this.render();
      this.root.scrollIntoView({ block: 'start' });
    } else if (a === 'report-back') {
      if (this.reportRef?.sync) {
        this.adminPick = this.reportRef.sync;
        this.view = 'admin';
      } else this.view = 'lobby';
      this.render();
    } else if (a.startsWith('board-')) {
      this.boardTab = a.slice(6) as Window;
      this.renderLobbyBoard();
    } else if (a === 'buy' || a === 'sell') {
      this.side = a;
      this.render();
    } else if (a.startsWith('kind-')) {
      this.kind = a.slice(5) as Kind;
      this.render();
    } else if (a === 'lot' || a === 'share') {
      this.unit = a;
      this.render();
    } else if (a === 'cancel') {
      cancelOrder(this.state!, Number(el.dataset.id));
      this.persist();
      this.render();
    } else if (a === 'stop-clear') {
      const form = el.closest<HTMLFormElement>('form.sim-stop');
      if (form) this.stop(form, true);
    } else if (a === 'loan-payoff') {
      const s = this.state;
      const l = s?.loans.find((x) => x.id === Number(el.dataset.id));
      if (s && l) {
        this.bankMsg = repayLoan(s, l.id, l.balance) ?? '信貸已全部還清';
        this.persist();
        this.render();
      }
    } else if (a === 'dca-off') {
      const s = this.state;
      if (s) {
        setDca(s, el.dataset.code!, 0);
        this.bankMsg = `已取消 ${el.dataset.code} 的定期定額`;
        this.persist();
        this.render();
      }
    } else if (a === 'fav') {
      const s = this.state;
      if (s) {
        const on = toggleFav(s, s.watch);
        this.msg = on ? `已把 ${s.watch} 加入自選股（今日排行的「自選」分頁）` : `已把 ${s.watch} 移出自選股`;
        this.persist();
        this.render();
      }
    } else if (a === 'watch') void this.watch(el.dataset.code!);
    else if (a.startsWith('rank-')) {
      this.rankKey = a.slice(5) as RankKey;
      this.renderPlay();
    } else if (a === 'learn') {
      this.setTab(this.tab === 'learn' ? 'trade' : 'learn', true);
    } else if (a === 'hints') {
      this.hints = !this.hints;
      this.render();
    } else if (a === 'random-start') {
      const form = this.root.querySelector<HTMLFormElement>('#sim-setup-form');
      if (form) this.start(null, form);
    } else if (a === 'all') this.fillMax();
  }

  /** 「最多／全部」：依類別算出可以下的最大數量。 */
  private fillMax(): void {
    const s = this.state;
    const qty = this.root.querySelector<HTMLInputElement>('#sim-qty');
    if (!s || !qty) return;
    const px = priceNow(s, this.market, s.watch) ?? 0;
    const holding = (kind: Kind, dir: 'long' | 'short') => s.pos.find((p) => p.code === s.watch && p.kind === kind && p.dir === dir)?.shares ?? 0;
    let sh = 0;
    const closing =
      (this.kind === 'cash' && this.side === 'sell') ||
      (this.kind === 'margin' && this.side === 'sell') ||
      (this.kind === 'short' && this.side === 'buy') ||
      (this.kind === 'day' && holding('day', this.side === 'buy' ? 'short' : 'long') > 0);
    if (closing) {
      sh = holding(this.kind, this.kind === 'short' || (this.kind === 'day' && this.side === 'buy') ? 'short' : 'long');
      if (this.kind === 'cash') sh -= pledgedShares(s, s.watch);
    } else if (px) {
      const cash = s.cash - reservedCash(s, this.market);
      const per = this.kind === 'margin' ? px * (1 - MARGIN_LOAN) : this.kind === 'short' ? px * SHORT_DEPOSIT : px;
      sh = Math.floor(cash / (per * 1.002));
    }
    sh = Math.max(0, sh);
    qty.value = String(this.unit === 'lot' ? Math.floor(sh / LOT) : sh);
    this.renderEstimate();
  }

  render(): void {
    if (!this.root.dataset.ready) return;
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    const s = this.state;
    if (this.view === 'play' && !s) this.view = 'lobby';
    if (this.user) {
      try {
        localStorage.setItem(VIEW_KEY, this.view);
      } catch {
        /* 存不了就算了 */
      }
    }
    const who = document.querySelector<HTMLElement>('#sim-who');
    if (who) {
      who.hidden = !this.user;
      who.textContent = this.user ? `👤 ${this.user.label}` : '';
    }
    this.root.classList.toggle('is-setup', this.view !== 'play');
    if (this.view !== 'play' || !s) {
      setHtml($('sim-setup'), this.setupView());
      if (this.view === 'gate') this.root.querySelector<HTMLInputElement>('#sim-code')?.focus({ preventScroll: true });
      return;
    }
    this.renderPlay();
  }

  private setupView(): string {
    switch (this.view) {
      case 'gate':
        return gateHtml(this.codeList !== undefined, this.gateMsg, !!this.sync);
      case 'lobby':
        return lobbyHtml({
          user: this.user!,
          state: this.state,
          save: this.save,
          note: this.syncNote,
          players: this.players?.length ?? 0,
          board: this.boardSection(),
          syncBadge: this.syncBadge(),
        });
      case 'admin': {
        const synced = !!this.sync;
        const pick = this.adminPick ? this.players?.find((p) => p.sync === this.adminPick) : null;
        if (pick) return playerDetailHtml(this, pick, this.playerSaves.get(pick.sync));
        return adminHtml(this, { synced, players: this.players, saves: this.playerSaves, loading: this.adminLoading });
      }
      case 'report':
        return this.reportView();
      default:
        return setupHtml(this.calendar);
    }
  }

  private reportView(): string {
    const ref = this.reportRef;
    const back = `<button type="button" class="btn" data-sim="report-back">← ${ref?.sync ? '回到玩家紀錄' : '回大廳'}</button>`;
    const sv = ref?.sync ? this.playerSaves.get(ref.sync) : this.save;
    const rec = sv && sv !== 'error' ? sv.history[ref?.i ?? -1] : undefined;
    if (!rec) return `<p class="muted">找不到這一局的紀錄。</p><p class="sim-lobby-foot">${back}</p>`;
    const who = ref?.sync ? this.players?.find((p) => p.sync === ref.sync)?.label ?? '' : '';
    const w = Math.max(240, (this.root.querySelector<HTMLElement>('#sim-setup')?.clientWidth ?? 720) - 48);
    return reportHtml(rec, w, back, who);
  }

  /** 遊戲中的各個面板（時鐘每走一分鐘就重畫一次）。 */
  private renderPlay(): void {
    const s = this.state;
    if (!s || this.view !== 'play' || !this.root.dataset.ready) return;
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    this.renderHead($('sim-head'), s);
    this.renderChart($('sim-chart'), s);
    this.renderOrder($('sim-order'), s);
    this.renderBank($('sim-bank'), s);
    this.renderRank($('sim-rank'), s);
    setHtml($('sim-dayrep'), dayReportHtml(s, this.freshDay === s.date));
    // 新聞只在新的一則出現時才會變；以「看得到幾則」當關鍵值
    const newsKey = `${s.date}|${s.pre}|${this.news.length}|${this.news.filter(([d]) => d === s.date).length}|${Math.floor(s.minute / 30)}`;
    setHtml($('sim-news'), this.cached('news', newsKey, () => newsHtml(s, this.news)));
    setHtml($('sim-hold'), holdHtml(s, this));
    // 資產曲線每天收盤才變、交易紀錄有新的一筆才變
    const ew = Math.max(240, (this.sizes.ew || 640) - 36);
    const named = Object.keys(this.names).length > 0;
    setHtml($('sim-equity'), this.cached('equity', `${s.settings.start}|${s.equity.length}|${s.trades.length}|${ew}|${!!this.taiex}|${!!this.calendar}`, () => equityHtml(s, this, ew)));
    setHtml($('sim-log'), this.cached('log', `${s.settings.start}|${s.trades.length}|${s.notes.length}|${named}`, () => logHtml(s, this)));
    if (this.tab === 'analysis') this.renderAnalysis(s);
    if (!this.guiding) this.maybeAskGuide();
  }

  /** 分析分頁：基本面（當時已公布的）與技術分析（到現在為止的價格）。 */
  private renderAnalysis(s: SimState): void {
    const code = s.watch;
    if (!this.funds.has(code)) {
      this.funds.set(code, undefined);
      void loadSimFund(code).then((f) => {
        this.funds.set(code, f);
        this.render();
      });
    }
    if (!this.chipData.has(code)) {
      this.chipData.set(code, undefined);
      void loadChipSeries(code).then((c) => {
        this.chipData.set(code, c);
        this.render();
      });
    }
    const fund = this.funds.get(code);
    const chips = this.chipData.get(code);
    const prevClose = this.market.prevClose(code, s.date) ?? null;
    const q = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    setHtml(
      q('sim-fund'),
      this.cached('fund', `${code}|${s.date}|${fund === undefined ? 'l' : fund ? 'y' : 'n'}|${prevClose}`, () => fundHtml({ code, etf: /^00/.test(code), fund, date: s.date, prevClose })),
    );
    // 盤中今天的成交量還沒累積完：換算成全天的「預估量」再跟均量比
    const bars = [...(this.visibleBars(s) ?? [])];
    const today = bars[bars.length - 1];
    if (today?.date === s.date && !s.pre && s.minute < SESSION_MINUTES) bars[bars.length - 1] = { ...today, volume: (today.volume * SESSION_MINUTES) / Math.max(30, s.minute) };
    setHtml(
      q('sim-tech'),
      this.cached('tech', `${code}|${s.date}|${bars.length}|${Math.floor(s.minute / 5)}|${chips === undefined ? 'l' : chips ? 'y' : 'n'}`, () => techHtml({ candles: bars, chips, date: s.date })),
    );
  }

  /** 標頭：時鐘與數字每分鐘更新，按鈕只在狀態改變時重畫（避免按到一半按鈕被換掉）。 */
  private renderHead(el: HTMLElement, s: SimState): void {
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = `<div class="sim-date" id="sim-date"></div><dl class="sim-kpis" id="sim-kpis"></dl><div class="sim-steps" id="sim-steps"></div><div class="sim-endbox" id="sim-endbox"></div>`;
    }
    const q = (id: string) => el.querySelector<HTMLElement>(`#${id}`)!;
    const m = this.market;
    const eq = equityOf(s, m);
    const ret = eq / investedOf(s) - 1;
    const bench = this.benchOf(s);
    const closed = s.minute >= SESSION_MINUTES;
    const end = this.isEnd(s);
    const status = s.bankrupt ? '💥 破產' : end ? '資料已到最新' : s.pre ? '盤前・可以先掛單' : closed ? '收盤' : this.running ? '盤中' : '暫停中・無法交易';
    const ratio = maintenance(s, m);
    const debt = debtOf(s);
    setHtml(
      q('sim-date'),
      `<p class="eyebrow">Laplace Replay · 第 ${s.day} 天</p>
        <p class="sim-day num">星期${weekday(s.date)} <b class="sim-clock">${s.pre ? '08:30' : clock(s.minute)}</b>
          <span class="sim-status sim-status-${s.bankrupt ? 'ruin' : end ? 'end' : s.pre ? 'pre' : closed ? 'closed' : this.running ? 'run' : 'pause'}">${status}</span></p>
        <p class="sim-garble num" title="日期已隱藏">${garble(s.date)}</p>`,
    );
    setHtml(
      q('sim-kpis'),
      `<div><dt>總資產</dt><dd class="num">${money(eq)}</dd></div>
        <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pctOrDash(ret)}</dd></div>
        <div><dt>同額買大盤</dt><dd class="num ${bench == null ? 'muted' : cls(bench)}">${pctOrDash(bench)}</dd></div>
        <div><dt>可用現金</dt><dd class="num">${money(s.cash - reservedCash(s, m))}</dd></div>
        ${debt ? `<div><dt>負債</dt><dd class="num">${money(debt)}</dd></div>` : ''}
        ${ratio != null ? `<div><dt>整戶維持率</dt><dd class="num ${ratio < 1.3 ? 'down' : ''}">${Math.round(ratio * 100)}%</dd></div>` : ''}`,
    );
    setHtml(
      q('sim-steps'),
      `${
        s.pre
          ? `<button type="button" class="btn btn-accent" data-sim="open" ${end ? 'disabled' : ''} title="快捷鍵：空白鍵">🔔 開盤</button>`
          : `<button type="button" class="btn ${this.running ? '' : 'btn-accent'}" data-sim="play" ${end ? 'disabled' : ''} title="快捷鍵：空白鍵">${this.running ? '⏸ 暫停' : '▶ 繼續'}</button>`
      }
        <div class="seg sim-speed" role="group" aria-label="時間流速">${([1, 3, 5] as const)
          .map((v) => `<button type="button" data-sim="speed${v}" aria-pressed="${this.speed === v}">${v}×</button>`)
          .join('')}</div>
        <button type="button" class="btn" data-sim="nextday" ${end ? 'disabled' : ''} title="快捷鍵：→">⏭ 直接到隔天</button>
        <button type="button" class="btn" data-sim="prestop" aria-pressed="${this.preStop}" title="開啟時每天先停在盤前（08:30），可以先掛單，按「開盤」才開始">盤前停留：${this.preStop ? '開' : '關'}</button>
        <button type="button" class="btn" data-sim="lobby">大廳</button>
        <button type="button" class="btn" data-sim="reset">結束這局</button>
        <button type="button" class="btn" data-sim="guide" title="一步一步介紹每個區塊與下單方式">❓ 新手指引</button>
        <button type="button" class="btn" data-sim="learn" title="K 棒、K 線、均線、成交量等基本知識（打開時自動暫停）">${this.tab === 'learn' ? '📈 回到看盤' : '📘 股市入門'}</button>`,
    );
    setHtml(
      q('sim-endbox'),
      s.bankrupt
        ? `<div class="sim-end sim-ruin"><b>💥 破產了</b>
            <p>第 ${s.bankrupt.day} 天收盤，${(s.settings.ruinLoss ?? 1) >= 1 ? '總資產歸零' : `虧損超過累計投入的 ${Math.round((s.settings.ruinLoss ?? 1) * 100)}%`}。所有部位已用收盤價強制了結並償還借款，剩下 ${money(s.bankrupt.equity)} 元，這一局到這裡結束。</p>
            <button type="button" class="btn btn-accent" data-sim="reset">看結束報告（揭曉日期）</button></div>`
        : end
          ? `<p class="sim-end">已經玩到最新的資料。${verdict(s, m, bench)} <button type="button" class="btn btn-sm btn-accent" data-sim="reset">結束並看報告</button></p>`
          : '',
    );
  }

  /** 觀看中股票：到昨天為止的日 K，加上今天到現在為止的 K 棒。 */
  private visibleBars(s: SimState): Candle[] | null {
    const all = this.candles.get(s.watch);
    if (!all) return null;
    // 已經發生的分割／減資：以前的 K 棒還原成現在的基準（未來的不能用，否則等於偷看）
    const past = adjustForSplits(
      all.filter((c) => c.date < s.date),
      this.market.splitsOf(s.watch),
      s.date,
    );
    const path = this.market.path(s.watch, s.date);
    if (!path || s.pre) return past;
    const t = Math.min(SESSION_MINUTES, Math.floor(s.minute));
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i <= t; i++) {
      hi = Math.max(hi, path.price[i]);
      lo = Math.min(lo, path.price[i]);
    }
    return [...past, { date: s.date, open: path.price[0], high: hi, low: lo, close: path.price[t], volume: Math.round(path.cumVolume[t]) }];
  }

  private renderChart(el: HTMLElement, s: SimState): void {
    const all = this.candles.get(s.watch);
    const name = this.nameOf(s.watch);
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = `
        <div class="sim-chart-head">
          <div class="sim-stock" id="sim-stock"></div>
          <button type="button" class="sim-fav" id="sim-fav" data-sim="fav" aria-pressed="false" title="加入自選股">☆ 自選</button>
          <form class="sim-search" id="sim-search" role="search">
            <input name="q" id="sim-q" list="sim-dir" placeholder="代號或名稱" autocomplete="off" aria-label="查詢股票" />
            <button type="submit" class="btn">看這檔</button>
            <datalist id="sim-dir"></datalist>
          </form>
        </div>
        <div class="sim-k" id="sim-k"></div>
        <div class="sim-tick" id="sim-tick"></div>
        <p class="sim-note muted sim-tick-note">分時走勢是<b>模擬</b>的：每天的開、高、低、收是真實資料，中間每分鐘的跳動依這四個價格推算，不是當天真正的走勢。</p>
        <div class="sim-hints" id="sim-hints"></div>`;
    }
    // 股票清單（約 2,000 筆）等瀏覽器有空時才建立，不卡住畫面
    const dl = el.querySelector<HTMLElement>('#sim-dir')!;
    if (this.dir.length && !dl.dataset.filled) {
      dl.dataset.filled = '1';
      const fill = () => (dl.innerHTML = this.dir.map((d) => `<option value="${esc(`${d.code} ${d.name}`)}"></option>`).join(''));
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fill, { timeout: 3000 });
      else setTimeout(fill, 500);
    }
    const fav = el.querySelector<HTMLButtonElement>('#sim-fav')!;
    const isFav = s.fav.includes(s.watch);
    if (fav.getAttribute('aria-pressed') !== String(isFav)) {
      fav.setAttribute('aria-pressed', String(isFav));
      fav.textContent = isFav ? '★ 自選' : '☆ 自選';
      fav.title = isFav ? '移出自選股' : '加入自選股';
    }
    const visible = this.visibleBars(s) ?? [];
    const path = this.market.path(s.watch, s.date);
    const pc = this.market.prevClose(s.watch, s.date);
    const now = priceNow(s, this.market, s.watch);
    const chg = now != null && pc ? now / pc - 1 : 0;
    const today = path && !s.pre ? visible[visible.length - 1] : null;
    setHtml(
      el.querySelector<HTMLElement>('#sim-stock')!,
      `<b>${esc(s.watch)}</b> ${esc(name)}
       ${now != null ? `<span class="num sim-px ${cls(chg)}">${price(now)}</span> <span class="num ${cls(chg)}">${chg >= 0 ? '▲' : '▼'} ${pct(chg * 100)}</span>` : ''}
       ${
         s.pre
           ? '<small class="muted">盤前・價格為昨收，09:00 開盤後才有今天的行情</small>'
           : today
             ? `<small class="muted num">開 ${price(today.open)} 高 ${price(today.high)} 低 ${price(today.low)} 量 ${num(today.volume)} 張</small>`
             : all
               ? '<small class="muted">今天沒有交易</small>'
               : ''
       }`,
    );
    const k = el.querySelector<HTMLElement>('#sim-k')!;
    // 同一檔同一天時，K 線與分時圖每秒最多重畫一次
    const chartKey = `${s.watch}|${s.date}|${!!s.pre}|${this.sizes.kw}|${this.sizes.kh}|${all ? all.length : -1}`;
    const tNow = performance.now();
    const chartDue = chartKey !== this.chartKey || tNow - this.chartAt >= 1000 || s.minute >= SESSION_MINUTES;
    if (chartDue) {
      this.chartKey = chartKey;
      this.chartAt = tNow;
    }
    if (all === undefined) setHtml(k, `<p class="muted sim-empty">下載 ${esc(s.watch)} 的日 K⋯⋯</p>`);
    else if (visible.length < 2) setHtml(k, `<p class="muted sim-empty">${esc(s.watch)} 在這一天以前沒有日 K（可能還沒上市）。</p>`);
    else if (chartDue) setHtml(k, candleSvg(visible, Math.max(240, this.sizes.kw || 640), Math.max(220, this.sizes.kh || 300)));
    setHtml(
      el.querySelector<HTMLElement>('#sim-tick')!,
      s.pre
        ? '<p class="muted sim-pre-note">盤前（08:30～09:00）：可以先下市價或限價單，按「🔔 開盤」後以開盤價集合競價撮合。</p>'
        : path && pc
          ? chartDue
            ? tickSvg(path, pc, s.minute, Math.max(240, this.sizes.kw || 640))
            : (el.querySelector<HTMLElement>('#sim-tick')!.dataset.html ?? '')
          : '',
    );
    // 型態只用到昨天收盤為止的資料，一天只要算一次（每分鐘重算整份歷史在手機上很卡）
    setHtml(
      el.querySelector<HTMLElement>('#sim-hints')!,
      visible.length >= 30 ? this.cached('hints', `${s.watch}|${s.date}|${this.hints}|${visible.length}`, () => this.hintsHtml(visible)) : '',
    );
  }

  private hintsHtml(visible: Candle[]): string {
    const toggle = `<button type="button" class="btn btn-sm" data-sim="hints" aria-pressed="${this.hints}">${this.hints ? '隱藏' : '顯示'}型態提示</button>`;
    if (!this.hints) return `<div class="sim-hints-row">${toggle}</div>`;
    // 型態只用到昨天收盤為止的日 K（今天還沒收完）
    const { patterns } = detectPatterns(visible.slice(0, -1));
    const list = patterns.slice(0, 5).map((p) => `<li><span class="tilt tilt-${p.bias}">${BIAS[p.bias]}</span> <b>${esc(p.name)}</b> <span class="muted">${esc(p.status)}</span></li>`).join('');
    return `<div class="sim-hints-row">${toggle}<small class="muted">只用到昨天收盤為止的資料判斷</small></div>
      ${list ? `<ul class="sim-pat">${list}</ul>` : '<p class="muted">目前沒有明顯的型態。</p>'}`;
  }

  /** 結構改變才整個重畫，避免輸入到一半的值被蓋掉。 */
  private keyed(el: HTMLElement, key: string, html: () => string, keep: string[]): boolean {
    if (el.dataset.key === key) return false;
    const vals = keep.map((sel) => {
      const i = el.querySelector<HTMLInputElement>(sel);
      return i ? i.value : null;
    });
    el.dataset.key = key;
    el.innerHTML = html();
    keep.forEach((sel, i) => {
      const inp = el.querySelector<HTMLInputElement>(sel);
      if (inp && vals[i]) inp.value = vals[i]!;
    });
    return true;
  }

  private renderOrder(el: HTMLElement, s: SimState): void {
    const mine = s.pos.filter((p) => p.code === s.watch);
    const have = mine.map((p) => `${KIND_NAME[p.kind]}${p.dir === 'short' ? '空' : ''} ${num(p.shares)} 股`).join('、') || '沒有部位';
    const closed = s.minute >= SESSION_MINUTES;
    const disabled = (!this.running && !s.pre) || closed;
    const pend = s.orders
      .map(
        (o) => `<li><span class="${o.side === 'buy' ? 'up' : 'down'}">${actionName(o.kind, o.side)}</span>
          <b>${esc(o.code)}</b> ${esc(this.nameOf(o.code))} <span class="num">${num(o.shares)} 股</span>
          <span class="muted">${o.limit != null ? `限價 ${o.limit}` : '市價（開盤撮合）'}</span>
          <button type="button" class="btn btn-sm" data-sim="cancel" data-id="${o.id}">取消</button></li>`,
      )
      .join('');
    const kinds: Kind[] = ['cash', 'day', 'margin', 'short'];
    const sideLabel = (side: Side) => (this.kind === 'short' ? (side === 'sell' ? '融券賣出' : '融券回補') : this.kind === 'margin' ? (side === 'buy' ? '融資買進' : '融資賣出') : side === 'buy' ? '買進' : '賣出');
    const html = () => `
      <h2 class="panel-title">下單 <small>${s.pre ? '盤前委託・開盤時以開盤價撮合' : closed ? '已收盤' : this.running ? '盤中即時成交' : '暫停中不能交易'}</small></h2>
      <form class="sim-order-form" id="sim-order-form">
        <div class="seg sim-kinds" role="group" aria-label="交易類別">${kinds
          .map((k) => `<button type="button" data-sim="kind-${k}" aria-pressed="${this.kind === k}">${KIND_NAME[k]}</button>`)
          .join('')}</div>
        <div class="seg seg-2" role="group" aria-label="買賣">
          <button type="button" data-sim="buy" aria-pressed="${this.side === 'buy'}">${sideLabel('buy')}</button>
          <button type="button" data-sim="sell" aria-pressed="${this.side === 'sell'}">${sideLabel('sell')}</button>
        </div>
        <p class="sim-target"><b>${esc(s.watch)}</b> ${esc(this.nameOf(s.watch))}<span class="muted">　${esc(have)}</span></p>
        <div class="sim-qty-row">
          <input type="number" name="qty" id="sim-qty" min="1" step="1" value="1" aria-label="數量" required />
          <div class="seg seg-2 sim-unit" role="group" aria-label="單位">
            <button type="button" data-sim="lot" aria-pressed="${this.unit === 'lot'}">張</button>
            <button type="button" data-sim="share" aria-pressed="${this.unit === 'share'}">股</button>
          </div>
          <button type="button" class="btn btn-sm" data-sim="all">最多</button>
        </div>
        <div class="sim-type">
          <label><input type="radio" name="type" value="market" checked /> 市價（現在的價格）</label>
          <label><input type="radio" name="type" value="limit" /> 限價 <input type="number" name="limit" id="sim-limit" step="0.01" min="0" disabled aria-label="限價" /></label>
        </div>
        <p class="sim-est num" id="sim-est"></p>
        <button type="submit" class="btn ${this.side === 'buy' ? 'btn-buy' : 'btn-sell'} btn-block" ${disabled ? 'disabled' : ''}>${actionName(this.kind, this.side)}</button>
      </form>
      <p class="sim-msg" role="status">${esc(this.msg)}</p>
      ${stopHtml(s)}
      <h3 class="sim-sub">委託中（${s.pre ? '開盤時撮合；限價沒碰到的留到盤中' : '限價單，收盤未成交自動取消'}）</h3>
      ${pend ? `<ul class="sim-orders">${pend}</ul>` : '<p class="muted">沒有委託。</p>'}`;
    const stops = s.stops.filter((x) => x.code === s.watch).map((x) => `${x.kind}${x.dir}${x.loss}/${x.profit}`).join(',');
    const key = `${s.watch}|${!!s.pre}|${this.side}|${this.kind}|${this.unit}|${have}|${disabled}|${this.msg}|${s.orders.map((o) => o.id).join(',')}|${stops}`;
    const form = el.querySelector<HTMLFormElement>('#sim-order-form');
    const type = form ? new FormData(form).get('type') : null;
    if (this.keyed(el, key, html, ['#sim-qty', '#sim-limit']) && type === 'limit') {
      el.querySelector<HTMLInputElement>('input[name=type][value=limit]')!.checked = true;
      el.querySelector<HTMLInputElement>('#sim-limit')!.disabled = false;
    }
    this.renderEstimate();
  }

  private renderBank(el: HTMLElement, s: SimState): void {
    // 金額（市值、利息）每分鐘都在變，但只在結構改變時重畫，輸入框才不會被清掉
    const key = JSON.stringify([
      s.loans.map((l) => [l.id, Math.round(l.balance), l.left]),
      s.pledges.map((p) => [p.code, p.shares, Math.round(p.loan)]),
      s.pos.filter((p) => p.kind === 'cash').map((p) => [p.code, p.shares]),
      s.watch,
      this.bankMsg,
      s.day,
    ]);
    this.keyed(el, key, () => bankHtml(s, this, this.bankMsg), []);
  }

  private renderEstimate(): void {
    const s = this.state;
    const out = this.root.querySelector<HTMLElement>('#sim-est');
    const form = this.root.querySelector<HTMLFormElement>('#sim-order-form');
    if (!s || !out || !form) return;
    const fd = new FormData(form);
    const shares = Math.round(Number(fd.get('qty')) * (this.unit === 'lot' ? LOT : 1));
    const limit = fd.get('type') === 'limit' ? Number(fd.get('limit')) : NaN;
    const px = limit > 0 ? limit : priceNow(s, this.market, s.watch);
    if (!px || !(shares > 0)) {
      out.textContent = '';
      return;
    }
    const amt = px * shares;
    const fee = feeOf(amt, s.settings.discount, shares);
    const sellTax = this.side === 'sell' ? taxOf(amt, s.watch, this.kind === 'day') : 0;
    let extra = '';
    if (this.kind === 'margin' && this.side === 'buy') extra = `，自備 ${money(amt * (1 - MARGIN_LOAN))}、融資 ${money(amt * MARGIN_LOAN)}`;
    if (this.kind === 'short' && this.side === 'sell') extra = `，保證金 ${money(amt * SHORT_DEPOSIT)}`;
    out.textContent = `${limit > 0 ? '限價' : '現價'} ${price(px)} × ${num(shares)} 股 ≈ ${money(amt)} 元，手續費 ${money(fee)}${sellTax ? `、證交稅 ${money(sellTax)}` : ''}${extra}`;
  }

  // ------------------------------------------------------------ 排行

  /** 今天全市場每一檔的盤中路徑（換日時算一次）。 */
  private async ensureRank(date: string): Promise<void> {
    if (this.rankCache?.date === date || this.rankLoading === date) return;
    this.rankLoading = date;
    const month = await loadSimMonth(date.slice(0, 7));
    if (this.rankLoading !== date) return;
    this.rankLoading = '';
    if (!month) {
      this.rankCache = { date, rows: [] };
      return this.renderPlay();
    }
    this.rankCache = { date, rows: this.rankRows(month, date) };
    this.renderPlay();
  }

  private rankRows(month: SimMonth, date: string): RankRow[] {
    const rows: RankRow[] = [];
    const day = month.days[date];
    if (!day) return rows;
    day.forEach((r, i) => {
      if (!r) return;
      const [open, high, low, close, volume, pc] = r;
      const code = month.codes[i];
      rows.push({ code, pc, path: intradayPath(code, date, { open, high, low, close, volume }) });
    });
    return rows;
  }

  private renderRank(el: HTMLElement, s: SimState): void {
    void this.ensureRank(s.date);
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = `<h2 class="panel-title">今日排行 <small>點一下看這檔</small></h2><div class="seg sim-rank-tabs" role="group" aria-label="排行" id="sim-rank-tabs"></div><div id="sim-rank-body"></div>`;
    }
    setHtml(
      el.querySelector<HTMLElement>('#sim-rank-tabs')!,
      (Object.keys(RANK_NAME) as RankKey[]).map((k) => `<button type="button" data-sim="rank-${k}" aria-pressed="${this.rankKey === k}">${RANK_NAME[k]}</button>`).join(''),
    );
    const body = el.querySelector<HTMLElement>('#sim-rank-body')!;
    const cache = this.rankCache;
    if (s.pre) return setHtml(body, '<p class="muted">盤前，09:00 開盤後才有今日排行。</p>');
    if (!cache || cache.date !== s.date) return setHtml(body, '<p class="muted">計算今日排行⋯⋯</p>');
    if (!cache.rows.length) return setHtml(body, '<p class="muted">這一天沒有全市場資料。</p>');
    const t = Math.min(SESSION_MINUTES, Math.floor(s.minute));
    const list = cache.rows.map((r) => {
      const p = r.path.price[t];
      return { code: r.code, p, chg: r.pc ? p / r.pc - 1 : 0, vol: r.path.cumVolume[t] };
    });
    const key = this.rankKey;
    if (key === 'fav' && !s.fav.length) return setHtml(body, '<p class="muted">還沒有自選股。看一檔股票時按圖表上方的「☆ 自選」加入。</p>');
    const sorted =
      key === 'fav'
        ? s.fav.map((c) => list.find((r) => r.code === c)).filter((r): r is (typeof list)[number] => !!r)
        : key === 'up'
        ? list.sort((a, b) => b.chg - a.chg)
        : key === 'down'
          ? list.sort((a, b) => a.chg - b.chg)
          : key === 'vol'
            ? list.sort((a, b) => b.vol - a.vol)
            : key === 'high'
              ? list.sort((a, b) => b.p - a.p)
              : list.sort((a, b) => a.p - b.p);
    const rows = sorted
      .slice(0, key === 'fav' ? 100 : 20)
      .map(
        (r, i) => `<tr data-sim="watch" data-code="${esc(r.code)}" class="${r.code === s.watch ? 'is-watch' : ''}">
          <td class="num muted">${i + 1}</td><td><b>${esc(r.code)}</b> ${esc(this.nameOf(r.code))}</td>
          <td class="num">${price(r.p)}</td><td class="num ${cls(r.chg)}">${pct(r.chg * 100)}</td><td class="num muted">${num(Math.round(r.vol))}</td></tr>`,
      )
      .join('');
    setHtml(
      body,
      `<div class="sim-table-wrap"><table class="sim-table sim-rank-table"><thead><tr><th>#</th><th>股票</th><th>現價</th><th>漲跌</th><th>量（張）</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted sim-note">共 ${cache.rows.length} 檔（上市、上櫃、ETF），價格是依當天開高低收模擬的盤中走勢。</p>`,
    );
  }

  // ------------------------------------------------------------ 管理員

  /** 讀取所有玩家的雲端存檔（唯讀）。 */
  private async loadPlayers(): Promise<void> {
    if (!this.players || !this.sync || this.adminLoading) return;
    this.adminLoading = true;
    this.render();
    await Promise.all(
      this.players.map((p) =>
        pullSave(this.sync!, p.sync)
          .then((save) => this.playerSaves.set(p.sync, save ? { ...save, current: migrate(save.current) } : null))
          .catch(() => this.playerSaves.set(p.sync, 'error')),
      ),
    );
    this.adminLoading = false;
    this.render();
  }
}
