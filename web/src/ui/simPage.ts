/**
 * 拉普拉斯模擬盤頁面：回到過去的某一天，用模擬帳戶在「偽即時」盤中行情裡練習交易。
 *
 * - 時間：每個交易日 09:00～13:30，現實 1 秒＝盤中 1 分鐘（可選 1／3／5 倍），不能倒帶；
 *   暫停時不能交易；收盤後自動進入下一個交易日；也可以直接跳到隔天。
 * - 為了不讓玩家想起真實事件，畫面上看不到年月日：只顯示星期幾、時間與「第幾天」，日期一律顯示成亂碼。
 * - 新聞欄（亂碼日期＋標題）、今日排行（漲幅、跌幅、成交量、高價、低價）、現股／當沖／融資／融券下單。
 * 帳號、雲端同步、管理員檢視和之前一樣；狀態存在瀏覽器並同步到雲端。
 */
import { scaleBand, scaleLinear } from 'd3';
import { loadOfficialCandles } from '../data/candles';
import { loadTaiex } from '../data/chipSeries';
import { loadNames, loadNews, loadSimMonth, newsMinute, type NewsItem, type SimMonth } from '../data/simData';
import { loadStockDirectory, searchDirectory, type DirEntry } from '../data/stockDirectory';
import { SESSION_MINUTES, clock, intradayPath, type IntradayPath } from '../domain/intraday';
import { detectPatterns, type Bias } from '../domain/patterns';
import {
  KIND_NAME,
  LOT,
  MARGIN_LOAN,
  SHORT_DEPOSIT,
  beginDay,
  buildMarket,
  cancelOrder,
  closeDay,
  equityOf,
  feeOf,
  maintenance,
  migrate,
  newSim,
  placeOrder,
  priceNow,
  reservedCash,
  summarize,
  taxOf,
  tickTo,
  type ExRight,
  type Kind,
  type Market,
  type Position,
  type Side,
  type SimState,
} from '../domain/sim';
import { loadCodes, loadSave, openVault, rememberPlayers, rememberSyncId, rememberUser, rememberedPlayers, rememberedSyncId, rememberedUser, syncIdFor, verifyCode, writeSave, type CodeEntry, type CodeList, type PlayerRef, type SimSave } from '../data/simAccount';
import { loadSyncConfig, pullSave, pushSave, type SyncConfig } from '../data/simSync';
import { sma, type Candle } from '../domain/technicals';
import { escapeHtml as esc, num, pct, price } from './format';

/** 上次在模擬盤的哪個畫面（大廳／遊戲中），重新打開時用。 */
const VIEW_KEY = 'lplc.sim.view';
/** 交易日曆：0050 從 2003 年起每個交易日都有成交。 */
const CALENDAR_CODE = '0050';
/** 起點之前至少要有這麼多根日 K 給圖表與型態判斷用。 */
const WARMUP = 60;
const BARS = 120;
/** 收盤後停留幾秒再進入下一個交易日。 */
const CLOSE_PAUSE_MS = 2500;

type RankKey = 'up' | 'down' | 'vol' | 'high' | 'low';
const RANK_NAME: Record<RankKey, string> = { up: '漲幅', down: '跌幅', vol: '成交量', high: '高價', low: '低價' };

function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const money = (v: number) => num(Math.round(v));
const BIAS: Record<Bias, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };
const weekday = (date: string) => '日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()];

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** 日期的亂碼：同一天每次一樣，但看不出是哪一天（不是逐字替換，沒辦法解回去）。 */
function garble(date: string): string {
  const glyphs = '▓▒░▚▞▙▛▜▟▖▗▘▝◩◪⌧';
  let h = hash(`lplc-garble|${date}`);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += glyphs[h % glyphs.length];
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    if (i === 3 || i === 5) out += '-';
  }
  return out;
}

/** 交易動作的名稱（依類別與買賣）。 */
function actionName(kind: Kind, side: Side): string {
  if (kind === 'margin') return side === 'buy' ? '融資買進' : '融資賣出';
  if (kind === 'short') return side === 'sell' ? '融券賣出' : '融券回補';
  return `${KIND_NAME[kind]}${side === 'buy' ? '買進' : '賣出'}`;
}

interface RankRow {
  code: string;
  pc: number;
  path: IntradayPath;
}

export class SimPage {
  private state: SimState | null = null;
  private codeList: CodeList | null | undefined;
  private user: CodeEntry | null = null;
  private save: SimSave = { current: null, history: [] };
  private view: 'gate' | 'lobby' | 'setup' | 'play' | 'admin' = 'gate';
  /** 管理員（玩家 0）：解開的玩家清單、讀到的各玩家存檔、正在看的玩家。 */
  private players: PlayerRef[] | null = null;
  private playerSaves = new Map<string, SimSave | null | 'error'>();
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
  private readonly candles = new Map<string, Candle[] | null>();
  private readonly loading = new Map<string, Promise<Candle[] | null>>();
  private calendar: string[] | null | undefined;
  private dir: DirEntry[] = [];
  private names: Record<string, string> = {};
  private taiex: Map<string, number> | null = null;
  private ex: ExRight[] = [];
  private exYears = new Set<number>();
  private market: Market = buildMarket(new Map());
  private started = false;
  // 下單面板
  private side: Side = 'buy';
  private kind: Kind = 'cash';
  private unit: 'lot' | 'share' = 'lot';
  private msg = '';
  private hints = true;
  // 時鐘
  private running = false;
  private speed: 1 | 3 | 5 = 1;
  private raf = 0;
  private lastTs = 0;
  /** 收盤後要等到這個時間（performance.now）才進入下一天。 */
  private closedUntil = 0;
  private lastSavedMinute = -1;
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
      this.fetchCandles(CALENDAR_CODE).then((c) => (this.calendar = c?.map((x) => x.date) ?? null)),
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

  /** 目前用到的股票（觀看中、有部位、委託中）都要有日 K。 */
  private neededCodes(): string[] {
    const s = this.state;
    if (!s) return [];
    return [...new Set([s.watch, ...s.pos.map((p) => p.code), ...s.orders.map((o) => o.code)])];
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

  private nameOf(code: string): string {
    return this.names[code] ?? this.dir.find((d) => d.code === code)?.name ?? '';
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

  private logout(): void {
    this.stopLoop();
    this.flush();
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
    writeSave(this.user.id, this.save);
    this.schedulePush();
    if (this.state) this.lastSavedMinute = this.state.minute;
  }

  /** 把目前這一局的成績存進歷史紀錄（至少玩過一天才記）。 */
  private archive(): void {
    const s = this.state;
    if (!s || !s.equity.length) return;
    this.save.history.unshift({
      start: s.settings.start,
      end: s.equity[s.equity.length - 1][0],
      days: s.equity.length,
      capital: s.settings.capital,
      equity: s.equity[s.equity.length - 1][1],
      bench: this.benchOf(s),
      trades: s.trades.length,
      endedAt: new Date().toISOString(),
    });
    this.save.history = this.save.history.slice(0, 30);
  }

  /** 同期大盤：起始日前一天收盤 → 最近一個已收盤的交易日（盤中不看今天，避免偷看）。 */
  private benchOf(s: SimState): number | null {
    const cal = this.calendar;
    const t = this.taiex;
    if (!cal || !t) return null;
    const i0 = cal.indexOf(s.settings.start);
    const base = i0 > 0 ? t.get(cal[i0 - 1]) : undefined;
    const lastDone = s.minute >= SESSION_MINUTES ? s.date : cal[cal.indexOf(s.date) - 1];
    const end = lastDone ? t.get(lastDone) : undefined;
    return base && end && lastDone >= s.settings.start ? end / base - 1 : s.equity.length ? null : 0;
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
    if (!s || this.view !== 'play' || !this.running || document.hidden || !document.querySelector('.app.page-sim')) return;
    if (!prevTs) return;
    const dt = Math.min(1000, ts - prevTs);
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
      if (Math.floor(s.minute) >= SESSION_MINUTES) this.closeToday();
      else if (Math.floor(s.minute) - this.lastSavedMinute >= 30) this.persist();
      this.renderPlay();
    } else s.minute = target;
  }

  private closeToday(): void {
    const s = this.state;
    if (!s || s.equity.at(-1)?.[0] === s.date) return;
    closeDay(s, this.market);
    this.persist();
  }

  /** 進入下一個交易日（若今天還沒收盤就先收盤）。 */
  private async nextDay(): Promise<void> {
    const s = this.state;
    const cal = this.calendar;
    if (!s || !cal) return;
    await Promise.all(this.neededCodes().map((c) => this.fetchCandles(c)));
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
    beginDay(s, this.market, next);
    this.closedUntil = 0;
    this.msg = '';
    this.persist();
    await this.prepare();
  }

  private isEnd(s: SimState): boolean {
    const cal = this.calendar ?? [];
    return cal.length > 0 && s.date >= cal[cal.length - 1] && s.minute >= SESSION_MINUTES;
  }

  // ------------------------------------------------------------ 操作

  private start(dateWanted: string | null, form: HTMLFormElement): void {
    const cal = this.calendar;
    if (!cal?.length) return;
    const fd = new FormData(form);
    const capital = Math.max(10_000, Number(fd.get('capital')) || 1_000_000);
    const discount = Math.min(1, Math.max(0.1, Number(fd.get('discount')) || 0.6));
    const minIdx = Math.min(WARMUP, cal.length - 1);
    const maxIdx = Math.max(minIdx, cal.length - 21);
    let idx: number;
    if (dateWanted == null) idx = minIdx + Math.floor(Math.random() * (maxIdx - minIdx + 1));
    else {
      idx = cal.findIndex((d) => d >= dateWanted);
      if (idx < 0) idx = cal.length - 1;
      idx = Math.max(idx, minIdx);
    }
    this.archive();
    this.state = newSim({ start: cal[idx], capital, discount }, this.state?.watch ?? '2330');
    this.msg = '';
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
    if (!this.running) {
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
    this.msg = err ?? `${actionName(this.kind, this.side)} ${s.watch} ${num(shares)} 股${filled ? `，已成交 @ ${price(s.trades[s.trades.length - 1].price)}` : `，限價 ${limit} 掛單中`}`;
    if (!err) this.persist();
    this.render();
  }

  private reset(): void {
    if (!confirm('結束這一局？成績會存進歷史紀錄。')) return;
    if (this.state && this.state.minute > 0 && this.state.equity.at(-1)?.[0] !== this.state.date) this.closeToday();
    this.archive();
    this.state = null;
    this.running = false;
    this.msg = '';
    this.persist();
    this.view = 'lobby';
    this.render();
  }

  // ------------------------------------------------------------ 畫面

  private build(): void {
    const root = this.root;
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="sim-head glass" id="sim-head"></div>
      <div class="sim-main">
        <div class="sim-chart glass" id="sim-chart"></div>
        <div class="sim-hold glass" id="sim-hold"></div>
        <div class="sim-news glass" id="sim-news"></div>
        <div class="sim-equity glass" id="sim-equity"></div>
      </div>
      <div class="sim-aside">
        <div class="sim-order glass" id="sim-order"></div>
        <div class="sim-rank glass" id="sim-rank"></div>
        <div class="sim-log glass" id="sim-log"></div>
      </div>
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
    root.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-sim]');
      if (!el) return;
      if (el.matches('tr[data-sim="watch"]') && Date.now() - this.rowDown < 800) return;
      const a = el.dataset.sim!;
      if (a === 'play') {
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
      } else if (a === 'watch') void this.watch(el.dataset.code!);
      else if (a.startsWith('rank-')) {
        this.rankKey = a.slice(5) as RankKey;
        this.renderPlay();
      } else if (a === 'hints') {
        this.hints = !this.hints;
        this.render();
      } else if (a === 'random-start') {
        const form = root.querySelector<HTMLFormElement>('#sim-setup-form');
        if (form) this.start(null, form);
      } else if (a === 'all') this.fillMax();
    });
    root.addEventListener('submit', (e) => {
      const form = e.target as HTMLFormElement;
      e.preventDefault();
      if (form.id === 'sim-gate-form') void this.unlock(form);
      else if (form.id === 'sim-setup-form') this.start(String(new FormData(form).get('start') || ''), form);
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
      raf = requestAnimationFrame(() => this.render());
    }).observe(root);
    window.addEventListener('pagehide', () => {
      if (this.state && this.view === 'play') this.persist();
      this.flush();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (this.state && this.view === 'play') this.persist();
        this.flush();
      }
      // 回到這個分頁時看看別台裝置有沒有新進度（玩到一半不打斷）
      else if (this.user && this.view !== 'play') void this.pull();
    });
    // 空白鍵暫停／繼續、→ 直接到隔天（不在輸入框時）
    window.addEventListener('keydown', (e) => {
      if (!document.querySelector('.app.page-sim') || !this.state || this.view !== 'play') return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,button') || document.querySelector('.laplace-intro')) return;
      if (e.key === ' ') {
        e.preventDefault();
        this.running = !this.running;
        this.render();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        void this.nextDay();
      }
    });
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
    if (closing) sh = holding(this.kind, this.kind === 'short' || (this.kind === 'day' && this.side === 'buy') ? 'short' : 'long');
    else if (px) {
      const cash = s.cash - reservedCash(s, this.market);
      const per = this.kind === 'margin' ? px * (1 - MARGIN_LOAN) : this.kind === 'short' ? px * SHORT_DEPOSIT : px;
      sh = Math.floor(cash / (per * 1.002));
    }
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
      setHtml($('sim-setup'), this.view === 'gate' ? this.gateHtml() : this.view === 'lobby' ? this.lobbyHtml() : this.view === 'admin' ? this.adminHtml() : this.setupHtml());
      if (this.view === 'gate') this.root.querySelector<HTMLInputElement>('#sim-code')?.focus({ preventScroll: true });
      return;
    }
    this.renderPlay();
  }

  /** 遊戲中的各個面板（時鐘每走一分鐘就重畫一次）。 */
  private renderPlay(): void {
    const s = this.state;
    if (!s || this.view !== 'play' || !this.root.dataset.ready) return;
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    this.renderHead($('sim-head'), s);
    this.renderChart($('sim-chart'), s);
    this.renderOrder($('sim-order'), s);
    this.renderRank($('sim-rank'), s);
    setHtml($('sim-news'), this.newsHtml(s));
    setHtml($('sim-hold'), this.holdHtml(s));
    setHtml($('sim-equity'), this.equityHtml(s, Math.max(280, $('sim-equity').clientWidth - 36)));
    setHtml($('sim-log'), this.logHtml(s));
  }

  private gateHtml(): string {
    if (this.codeList === undefined) return `<p class="muted">載入中⋯⋯</p>`;
    return `
      <p class="eyebrow">Laplace Replay</p>
      <h2 class="sim-title">拉普拉斯模擬盤</h2>
      <p class="sim-lead">請輸入開通碼。每個開通碼有自己的模擬帳戶與紀錄，下次用同一個開通碼就能接著玩。</p>
      <form class="sim-form sim-gate" id="sim-gate-form" autocomplete="off">
        <label>開通碼<input type="text" name="code" id="sim-code" placeholder="LPLC-XXXX-XXXX-…（共 40 碼）" spellcheck="false" autocapitalize="characters" required /></label>
        <button type="submit" class="btn btn-accent">開通</button>
      </form>
      <p class="sim-msg" role="alert">${esc(this.gateMsg)}</p>
      <p class="muted sim-note">${this.sync ? '紀錄會同步到雲端：換手機或電腦，用同一個開通碼登入就能接著玩。' : '紀錄存在這台裝置的瀏覽器；換手機、電腦或清除瀏覽器資料後不會跟著過去。'}</p>`;
  }

  private lobbyHtml(): string {
    const s = this.state;
    const label = esc(this.user?.label ?? '');
    let resume = `<div class="sim-card sim-card-empty"><p class="muted">目前沒有進行中的模擬。</p></div>`;
    if (s) {
      const eq = s.equity.at(-1)?.[1] ?? s.settings.capital;
      const ret = eq / s.settings.capital - 1;
      resume = `<div class="sim-card">
          <p class="eyebrow">接續上次</p>
          <p class="sim-card-date num">第 ${s.day} 天・星期${weekday(s.date)} ${clock(s.minute)}</p>
          <p class="muted num">${garble(s.date)}</p>
          <p class="num">總資產 ${money(eq)}　<span class="${cls(ret)}">${pct(ret * 100)}</span></p>
          <button type="button" class="btn btn-accent btn-block" data-sim="resume">接續上次的模擬 ▸</button>
        </div>`;
    }
    const hist = this.save.history
      .map((r) => {
        const ret = r.equity / r.capital - 1;
        return `<tr><td class="num">${r.days} 個交易日</td><td class="num">${money(r.capital)}</td><td class="num ${cls(ret)}">${pct(ret * 100)}</td>
          <td class="num ${r.bench == null ? 'muted' : cls(r.bench)}">${r.bench == null ? '—' : pct(r.bench * 100)}</td><td class="num">${r.trades}</td></tr>`;
      })
      .join('');
    return `
      <p class="eyebrow">Laplace Replay</p>
      <h2 class="sim-title">歡迎，${label}${this.user?.admin ? '<span class="sim-admin-tag">管理員</span>' : ''}</h2>
      ${this.syncNote ? `<p class="sim-msg" role="status">${esc(this.syncNote)}</p>` : ''}
      <div class="sim-lobby">
        ${resume}
        <div class="sim-card">
          <p class="eyebrow">開新的模擬</p>
          <p class="muted">選一個起始日期（或隨機）與本金重新開始。${s ? '目前這局的成績會存進下面的歷史紀錄。' : ''}</p>
          <button type="button" class="btn btn-block" data-sim="new">開新的模擬</button>
        </div>
      </div>
      ${
        this.user?.admin
          ? `<div class="sim-card sim-card-admin"><p class="eyebrow">管理員</p><p class="muted">查看所有玩家的持股、交易紀錄與練習紀錄（唯讀）。</p>
              <button type="button" class="btn btn-block" data-sim="admin">查看玩家紀錄（${this.players?.length ?? 0} 位）</button></div>`
          : ''
      }
      <h3 class="sim-sub">歷史紀錄</h3>
      ${hist ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>期間</th><th>本金</th><th>報酬</th><th>同期大盤</th><th>成交筆數</th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="muted">還沒有完成的模擬。</p>'}
      <p class="sim-lobby-foot">${this.syncBadge()}<button type="button" class="btn btn-sm" data-sim="logout">換開通碼／登出</button></p>`;
  }

  private setupHtml(): string {
    const cal = this.calendar;
    if (cal === undefined) return `<p class="muted">正在下載交易日曆⋯⋯</p>`;
    if (!cal?.length) return `<p>還沒有歷史日 K 資料，暫時不能開始模擬盤。</p>`;
    const min = cal[Math.min(WARMUP, cal.length - 1)];
    const max = cal[Math.max(0, cal.length - 21)];
    const def = cal[Math.max(WARMUP, cal.length - 250)];
    return `
      <p class="eyebrow">Laplace Replay</p>
      <h2 class="sim-title">拉普拉斯模擬盤</h2>
      <p class="sim-lead">回到過去的某一天，用模擬帳戶在盤中行情裡交易。時間會自己往前走（現實 1 秒＝盤中 1 分鐘），
        你只看得到「現在」為止的走勢；進入之後畫面上不會出現年月日，只有星期幾和時間 —— 不靠記憶，你能贏過大盤嗎？</p>
      <form class="sim-form" id="sim-setup-form">
        <label>本金（元）<input type="number" name="capital" min="10000" step="10000" value="1000000" /></label>
        <label>手續費折扣<input type="number" name="discount" min="0.1" max="1" step="0.01" value="0.6" /></label>
        <button type="button" class="btn btn-accent" data-sim="random-start" title="隨機抽一個過去的日期，不會告訴你是哪一天">🎲 隨機日期開始</button>
        <label>或指定起始日期<input type="date" name="start" id="sim-start" min="${min}" max="${max}" value="${def}" /></label>
        <button type="submit" class="btn">從指定日期開始</button>
        <button type="button" class="btn" data-sim="lobby">返回</button>
      </form>
      <ul class="sim-rules">
        <li>每天 09:00 開盤、13:30 收盤，可選 1×／3×／5× 速度，可以暫停（暫停時不能交易）或直接跳到隔天，不能倒帶。</li>
        <li>盤中走勢是依當天真實的開、高、低、收產生的模擬走勢；開高低收是真的，中間的跳動是模擬的。</li>
        <li>市價單立刻以當下價格成交；限價單在價格碰到時成交，收盤前沒成交就取消。</li>
        <li>交易類別：現股、現股當沖（證交稅減半，收盤未沖銷自動沖銷）、融資（自備 40%，年息 6.5%）、融券（保證金 90%，借券費 0.08%）；
          整戶維持率低於 130% 提醒、低於 120% 收盤強制了結。</li>
        <li>手續費 0.1425% × 折扣（整股最低 20 元、零股 1 元），賣出證交稅 0.3%（ETF 0.1%）；一價鎖漲停買不到、鎖跌停賣不掉；除權息自動處理。</li>
      </ul>`;
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
    const ret = eq / s.settings.capital - 1;
    const bench = this.benchOf(s);
    const closed = s.minute >= SESSION_MINUTES;
    const end = this.isEnd(s);
    const status = end ? '資料已到最新' : closed ? '收盤' : this.running ? '盤中' : '暫停中・無法交易';
    const ratio = maintenance(s, m);
    setHtml(
      q('sim-date'),
      `<p class="eyebrow">Laplace Replay · 第 ${s.day} 天</p>
        <p class="sim-day num">星期${weekday(s.date)} <b class="sim-clock">${clock(s.minute)}</b>
          <span class="sim-status sim-status-${end ? 'end' : closed ? 'closed' : this.running ? 'run' : 'pause'}">${status}</span></p>
        <p class="sim-garble num" title="日期已隱藏">${garble(s.date)}</p>`,
    );
    setHtml(
      q('sim-kpis'),
      `<div><dt>總資產</dt><dd class="num">${money(eq)}</dd></div>
        <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pct(ret * 100)}</dd></div>
        <div><dt>同期大盤</dt><dd class="num ${bench == null ? 'muted' : cls(bench)}">${bench == null ? '—' : pct(bench * 100)}</dd></div>
        <div><dt>可用現金</dt><dd class="num">${money(s.cash - reservedCash(s, m))}</dd></div>
        ${ratio != null ? `<div><dt>整戶維持率</dt><dd class="num ${ratio < 1.3 ? 'down' : ''}">${Math.round(ratio * 100)}%</dd></div>` : ''}`,
    );
    setHtml(
      q('sim-steps'),
      `<button type="button" class="btn ${this.running ? '' : 'btn-accent'}" data-sim="play" ${end ? 'disabled' : ''} title="快捷鍵：空白鍵">${this.running ? '⏸ 暫停' : '▶ 繼續'}</button>
        <div class="seg sim-speed" role="group" aria-label="時間流速">${([1, 3, 5] as const)
          .map((v) => `<button type="button" data-sim="speed${v}" aria-pressed="${this.speed === v}">${v}×</button>`)
          .join('')}</div>
        <button type="button" class="btn" data-sim="nextday" ${end ? 'disabled' : ''} title="快捷鍵：→">⏭ 直接到隔天</button>
        <button type="button" class="btn" data-sim="lobby">大廳</button>
        <button type="button" class="btn" data-sim="reset">結束這局</button>`,
    );
    setHtml(q('sim-endbox'), end ? `<p class="sim-end">已經玩到最新的資料。${this.verdict(s)}</p>` : '');
  }

  private verdict(s: SimState): string {
    const sum = summarize(s, this.market);
    const bench = this.benchOf(s);
    const vs = bench == null ? '' : sum.ret > bench ? `，贏過大盤 ${num((sum.ret - bench) * 100, 2)} 個百分點` : `，落後大盤 ${num((bench - sum.ret) * 100, 2)} 個百分點`;
    return `${sum.days} 個交易日報酬 ${pct(sum.ret * 100)}${vs}；最大回檔 ${num(sum.maxDrawdown * 100, 1)}%，了結 ${sum.wins + sum.losses} 次、賺 ${sum.wins} 次，手續費＋稅 ${money(sum.fees)} 元。`;
  }

  /** 觀看中股票：到昨天為止的日 K，加上今天到現在為止的 K 棒。 */
  private visibleBars(s: SimState): Candle[] | null {
    const all = this.candles.get(s.watch);
    if (!all) return null;
    const past = all.filter((c) => c.date < s.date);
    const path = this.market.path(s.watch, s.date);
    if (!path) return past;
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
          <form class="sim-search" id="sim-search" role="search">
            <input name="q" id="sim-q" list="sim-dir" placeholder="代號或名稱，例如 2330" autocomplete="off" aria-label="查詢股票" />
            <button type="submit" class="btn">看這檔</button>
            <datalist id="sim-dir"></datalist>
          </form>
        </div>
        <div class="sim-k" id="sim-k"></div>
        <div class="sim-tick" id="sim-tick"></div>
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
    const visible = this.visibleBars(s) ?? [];
    const path = this.market.path(s.watch, s.date);
    const pc = this.market.prevClose(s.watch, s.date);
    const now = priceNow(s, this.market, s.watch);
    const chg = now != null && pc ? now / pc - 1 : 0;
    const today = path ? visible[visible.length - 1] : null;
    setHtml(
      el.querySelector<HTMLElement>('#sim-stock')!,
      `<b>${esc(s.watch)}</b> ${esc(name)}
       ${now != null ? `<span class="num sim-px ${cls(chg)}">${price(now)}</span> <span class="num ${cls(chg)}">${chg >= 0 ? '▲' : '▼'} ${pct(chg * 100)}</span>` : ''}
       ${today ? `<small class="muted num">開 ${price(today.open)} 高 ${price(today.high)} 低 ${price(today.low)} 量 ${num(today.volume)} 張</small>` : all ? '<small class="muted">今天沒有交易</small>' : ''}`,
    );
    const k = el.querySelector<HTMLElement>('#sim-k')!;
    if (all === undefined) setHtml(k, `<p class="muted sim-empty">下載 ${esc(s.watch)} 的日 K⋯⋯</p>`);
    else if (visible.length < 2) setHtml(k, `<p class="muted sim-empty">${esc(s.watch)} 在這一天以前沒有日 K（可能還沒上市）。</p>`);
    else setHtml(k, this.chartSvg(visible, Math.max(320, k.clientWidth || 640), Math.max(240, k.clientHeight || 300)));
    setHtml(el.querySelector<HTMLElement>('#sim-tick')!, path && pc ? this.tickSvg(path, pc, s.minute, Math.max(320, k.clientWidth || 640)) : '');
    setHtml(el.querySelector<HTMLElement>('#sim-hints')!, visible.length >= 30 ? this.hintsHtml(visible) : '');
  }

  private chartSvg(visible: Candle[], w: number, h: number): string {
    const n = Math.min(BARS, visible.length);
    const off = visible.length - n;
    const c = visible.slice(off);
    const closes = visible.map((x) => x.close);
    const ma20 = sma(closes, 20).slice(off);
    const ma60 = sma(closes, 60).slice(off);
    const pad = { l: 6, r: 52, t: 8, b: 10 };
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
      const today = i === c.length - 1 ? ' sim-today' : '';
      body += `<line class="${k}${today}" x1="${cx(i).toFixed(1)}" x2="${cx(i).toFixed(1)}" y1="${y(b.high).toFixed(1)}" y2="${y(b.low).toFixed(1)}"></line>`;
      body += `<rect class="${k}${today}" x="${x(i)!.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`;
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
    const lastC = c[c.length - 1].close;
    // 不畫月份刻度（會洩漏日期）
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="日 K 線（只到現在）">
      ${ticks}${body}
      <path class="sim-ma20" d="${path(ma20)}"></path><path class="sim-ma60" d="${path(ma60)}"></path>
      <line class="sim-last" x1="${pad.l}" x2="${w - pad.r}" y1="${y(lastC).toFixed(1)}" y2="${y(lastC).toFixed(1)}"></line>
      <text class="sim-legend" x="${pad.l + 4}" y="${pad.t + 10}"><tspan class="sim-ma20t">— 月線 MA20</tspan>  <tspan class="sim-ma60t">— 季線 MA60</tspan></text>
    </svg>`;
  }

  /** 今天的分時走勢（09:00～現在），虛線是昨收。 */
  private tickSvg(path: IntradayPath, pc: number, minute: number, w: number): string {
    const h = 120;
    const pad = { l: 6, r: 52, t: 8, b: 16 };
    const t = Math.min(SESSION_MINUTES, Math.floor(minute));
    const pts = [...path.price.slice(0, t + 1)];
    // 以昨收為中線、上下對稱（和看盤軟體的分時圖一樣）
    const span = Math.max(pc * 0.01, ...pts.map((p) => Math.abs(p - pc)));
    const y = scaleLinear().domain([pc - span, pc + span]).range([h - pad.b, pad.t]);
    const x = (i: number) => pad.l + (i / SESSION_MINUTES) * (w - pad.l - pad.r);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join('');
    const now = pts[pts.length - 1];
    const marks = (w < 560 ? [0, 90, 180, 270] : [0, 60, 120, 180, 240, 270]).map((m) => `<text class="sim-axis" x="${x(m).toFixed(1)}" y="${h - 3}" text-anchor="${m === 0 ? 'start' : m === 270 ? 'end' : 'middle'}">${clock(m)}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="今日分時走勢">
      <line class="sim-pc" x1="${pad.l}" x2="${w - pad.r}" y1="${y(pc).toFixed(1)}" y2="${y(pc).toFixed(1)}"></line>
      <text class="sim-axis" x="${w - pad.r + 6}" y="${(y(pc) + 4).toFixed(1)}">昨收</text>
      <path class="sim-tickline ${now >= pc ? 'sim-up-line' : 'sim-down-line'}" d="${d}"></path>
      <circle class="${now >= pc ? 'sim-up' : 'sim-down'}" cx="${x(t).toFixed(1)}" cy="${y(now).toFixed(1)}" r="3"></circle>
      ${marks}
    </svg>`;
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

  private renderOrder(el: HTMLElement, s: SimState): void {
    const mine = s.pos.filter((p) => p.code === s.watch);
    const have = mine.map((p) => `${KIND_NAME[p.kind]}${p.dir === 'short' ? '空' : ''} ${num(p.shares)} 股`).join('、') || '沒有部位';
    const closed = s.minute >= SESSION_MINUTES;
    const disabled = !this.running || closed;
    const pend = s.orders
      .map(
        (o) => `<li><span class="${o.side === 'buy' ? 'up' : 'down'}">${actionName(o.kind, o.side)}</span>
          <b>${esc(o.code)}</b> ${esc(this.nameOf(o.code))} <span class="num">${num(o.shares)} 股</span>
          <span class="muted">限價 ${o.limit}</span>
          <button type="button" class="btn btn-sm" data-sim="cancel" data-id="${o.id}">取消</button></li>`,
      )
      .join('');
    const kinds: Kind[] = ['cash', 'day', 'margin', 'short'];
    const sideLabel = (side: Side) => (this.kind === 'short' ? (side === 'sell' ? '融券賣出' : '融券回補') : this.kind === 'margin' ? (side === 'buy' ? '融資買進' : '融資賣出') : side === 'buy' ? '買進' : '賣出');
    const html = `
      <h2 class="panel-title">下單 <small>${closed ? '已收盤' : this.running ? '盤中即時成交' : '暫停中不能交易'}</small></h2>
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
      <h3 class="sim-sub">委託中（限價單，收盤未成交自動取消）</h3>
      ${pend ? `<ul class="sim-orders">${pend}</ul>` : '<p class="muted">沒有委託。</p>'}`;
    // 輸入框的值不要被重畫蓋掉：只在結構改變時整個重畫
    const key = `${s.watch}|${this.side}|${this.kind}|${this.unit}|${have}|${disabled}|${this.msg}|${s.orders.map((o) => o.id).join(',')}`;
    if (el.dataset.key !== key) {
      const form = el.querySelector<HTMLFormElement>('#sim-order-form');
      const qty = el.querySelector<HTMLInputElement>('#sim-qty')?.value;
      const type = form ? new FormData(form).get('type') : null;
      const lim = el.querySelector<HTMLInputElement>('#sim-limit')?.value;
      el.dataset.key = key;
      el.innerHTML = html;
      if (qty) el.querySelector<HTMLInputElement>('#sim-qty')!.value = qty;
      if (type === 'limit') {
        el.querySelector<HTMLInputElement>('input[name=type][value=limit]')!.checked = true;
        const li = el.querySelector<HTMLInputElement>('#sim-limit')!;
        li.disabled = false;
        if (lim) li.value = lim;
      }
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
    if (!cache || cache.date !== s.date) return setHtml(body, '<p class="muted">計算今日排行⋯⋯</p>');
    if (!cache.rows.length) return setHtml(body, '<p class="muted">這一天沒有全市場資料。</p>');
    const t = Math.min(SESSION_MINUTES, Math.floor(s.minute));
    const list = cache.rows.map((r) => {
      const p = r.path.price[t];
      return { code: r.code, p, chg: r.pc ? p / r.pc - 1 : 0, vol: r.path.cumVolume[t] };
    });
    const key = this.rankKey;
    const sorted =
      key === 'up'
        ? list.sort((a, b) => b.chg - a.chg)
        : key === 'down'
          ? list.sort((a, b) => a.chg - b.chg)
          : key === 'vol'
            ? list.sort((a, b) => b.vol - a.vol)
            : key === 'high'
              ? list.sort((a, b) => b.p - a.p)
              : list.sort((a, b) => a.p - b.p);
    const rows = sorted
      .slice(0, 20)
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

  // ------------------------------------------------------------ 新聞

  private newsHtml(s: SimState): string {
    const head = '<h2 class="panel-title">新聞 <small>日期已隱藏</small></h2>';
    // 今天的新聞要等到發布時間（開盤前 09:00、收盤後 13:30）才看得到
    const visible = this.news.filter(([d, time]) => d < s.date || (d === s.date && newsMinute(time) <= s.minute));
    const items = visible.slice(-40).reverse();
    if (!items.length) return `${head}<p class="muted">還沒有新聞。</p>`;
    return `${head}<ol class="sim-newslist">${items
      .map(
        ([d, , level, title]) => `<li class="sim-news-${level}"><span class="sim-news-date num">${garble(d)}・${weekday(d)}</span><span class="sim-news-title">${esc(title)}</span></li>`,
      )
      .join('')}</ol>`;
  }

  // ------------------------------------------------------------ 部位、資產、紀錄

  private posPnl(p: Position, s: SimState): { now: number | undefined; pnl: number; base: number } {
    const now = priceNow(s, this.market, p.code);
    if (now == null) return { now, pnl: 0, base: p.cost };
    const mv = now * p.shares;
    const fee = feeOf(mv, s.settings.discount, p.shares);
    if (p.dir === 'long') {
      const tax = taxOf(mv, p.code, p.kind === 'day');
      return { now, pnl: mv - fee - tax - p.cost - (p.interest ?? 0), base: p.kind === 'margin' ? p.cost * (1 - MARGIN_LOAN) : p.cost };
    }
    return { now, pnl: p.cost - mv - fee, base: p.kind === 'short' ? p.deposit ?? p.cost : p.cost };
  }

  private holdHtml(s: SimState): string {
    const rows = s.pos
      .map((p) => {
        const { now, pnl, base } = this.posPnl(p, s);
        const avg = p.dir === 'long' ? p.cost / p.shares : p.cost / p.shares;
        return `<tr data-sim="watch" data-code="${esc(p.code)}" tabindex="0">
          <td><b>${esc(p.code)}</b> ${esc(this.nameOf(p.code))}</td>
          <td><span class="sim-kind sim-kind-${p.kind}">${KIND_NAME[p.kind]}${p.dir === 'short' && p.kind === 'day' ? '空' : ''}</span></td>
          <td class="num">${num(p.shares)}</td>
          <td class="num">${price(avg)}</td>
          <td class="num">${now != null ? price(now) : '—'}</td>
          <td class="num ${cls(pnl)}">${money(pnl)}<br /><small>${pct((pnl / Math.max(1, base)) * 100)}</small></td>
        </tr>`;
      })
      .join('');
    return `<h2 class="panel-title">部位 <small>損益已扣掉了結時的手續費與稅${s.pos.some((p) => p.kind === 'margin') ? '、融資利息' : ''}</small></h2>
      ${rows ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>類別</th><th>股數</th><th>成本</th><th>現價</th><th>損益</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">還沒有部位。看看排行或搜尋一檔股票，盤中下單吧。</p>'}`;
  }

  private equityHtml(s: SimState, w: number): string {
    const sum = summarize(s, this.market);
    const head = `<h2 class="panel-title">資產曲線 <small>每天收盤，對照同期加權指數</small></h2>
      <dl class="sim-stats">
        <div><dt>最大回檔</dt><dd class="num">${num(sum.maxDrawdown * 100, 1)}%</dd></div>
        <div><dt>已實現損益</dt><dd class="num ${cls(sum.realized)}">${money(sum.realized)}</dd></div>
        <div><dt>勝 / 敗</dt><dd class="num">${sum.wins} / ${sum.losses}</dd></div>
        <div><dt>手續費＋稅</dt><dd class="num">${money(sum.fees)}</dd></div>
      </dl>`;
    const pts = s.equity;
    if (pts.length < 2) return `${head}<p class="muted">收盤兩天以上就會畫出資產曲線。</p>`;
    const h = 180;
    const pad = { l: 4, r: 46, t: 8, b: 16 };
    const cal = this.calendar ?? [];
    const i0 = cal.indexOf(s.settings.start);
    const t0 = i0 > 0 ? this.taiex?.get(cal[i0 - 1]) : undefined;
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
      <text class="sim-axis" x="${pad.l}" y="${h - 3}">第 1 天</text><text class="sim-axis" x="${w - pad.r}" y="${h - 3}" text-anchor="end">第 ${pts.length} 天</text>
    </svg>
    <p class="sim-eq-legend"><span class="sim-mine-t">━ 我的帳戶</span>　<span class="sim-bench-t">━ 加權指數</span></p>`;
  }

  private logHtml(s: SimState): string {
    const items = [
      ...s.trades.map((t) => ({
        k: t.day * 1000 + t.minute,
        when: `第 ${t.day} 天 ${clock(t.minute)}`,
        html: `<span class="${t.side === 'buy' ? 'up' : 'down'}">${actionName(t.kind, t.side)}</span> <b>${esc(t.code)}</b> ${esc(this.nameOf(t.code))}
          <span class="num">${num(t.shares)} 股 @ ${price(t.price)}</span>
          ${t.pnl != null ? `<span class="num ${cls(t.pnl)}">損益 ${money(t.pnl)}</span>` : ''}
          <small class="muted num">費 ${money(t.fee)}${t.tax ? `／稅 ${money(t.tax)}` : ''}</small>`,
      })),
      ...s.notes.map((n) => ({ k: n.day * 1000 + n.minute + 0.5, when: `第 ${n.day} 天 ${clock(n.minute)}`, html: `${n.code ? `<b>${esc(n.code)}</b> ${esc(this.nameOf(n.code))} ` : ''}<span class="muted">${esc(n.text)}</span>` })),
    ]
      .sort((a, b) => b.k - a.k)
      .slice(0, 80);
    return `<h2 class="panel-title">交易紀錄</h2>
      ${items.length ? `<ol class="sim-logs">${items.map((i) => `<li><time class="num muted">${i.when}</time> ${i.html}</li>`).join('')}</ol>` : '<p class="muted">還沒有交易。</p>'}`;
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

  private adminHtml(): string {
    const back = `<button type="button" class="btn btn-sm" data-sim="lobby">← 回大廳</button>`;
    const head = `<p class="eyebrow">Laplace Replay · 管理員</p><h2 class="sim-title">玩家紀錄</h2>`;
    if (!this.sync) return `${head}<p>還沒有設定雲端同步，看不到其他玩家的紀錄。</p>${back}`;
    if (!this.players?.length) return `${head}<p>沒有可以查看的玩家（請重新輸入管理員開通碼登入一次）。</p>${back}`;
    const pick = this.adminPick ? this.players.find((p) => p.sync === this.adminPick) : null;
    if (pick) return this.playerDetailHtml(pick);
    const rows = this.players
      .map((p) => {
        const sv = this.playerSaves.get(p.sync);
        if (sv === undefined) return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">${this.adminLoading ? '讀取中⋯⋯' : '—'}</td></tr>`;
        if (sv === 'error') return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">讀取失敗</td></tr>`;
        if (!sv || (!sv.current && !sv.history.length)) return `<tr><td><b>${esc(p.label)}</b></td><td colspan="6" class="muted">還沒有玩過</td></tr>`;
        const c = sv.current;
        const eq = c ? c.equity.at(-1)?.[1] ?? c.settings.capital : null;
        const ret = c && eq != null ? eq / c.settings.capital - 1 : null;
        const bench = c ? this.benchOf(c) : null;
        const updated = sv.updatedAt ? new Date(sv.updatedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        return `<tr data-sim="pick" data-sync="${esc(p.sync)}" tabindex="0">
          <td><b>${esc(p.label)}</b></td>
          <td class="num">${c ? `${esc(c.settings.start)} → ${esc(c.date)} ${clock(c.minute)}<br /><small class="muted">第 ${c.day} 天</small>` : '<span class="muted">沒有進行中</span>'}</td>
          <td class="num">${eq != null ? money(eq) : '—'}</td>
          <td class="num ${ret == null ? '' : cls(ret)}">${ret == null ? '—' : pct(ret * 100)}</td>
          <td class="num ${bench == null ? 'muted' : cls(bench)}">${bench == null ? '—' : pct(bench * 100)}</td>
          <td class="num">${c?.trades.length ?? 0} 筆／${sv.history.length} 局</td>
          <td class="num muted">${esc(updated)}</td></tr>`;
      })
      .join('');
    return `${head}
      <p class="sim-lead">所有玩家的雲端存檔（唯讀，管理員看得到真實日期）。點一位玩家可以看他的部位、每一筆交易與過去每一局的成績。</p>
      <div class="sim-table-wrap"><table class="sim-table sim-admin-table"><thead><tr><th>玩家</th><th>進行中的模擬</th><th>總資產</th><th>報酬</th><th>同期大盤</th><th>交易／完成</th><th>最後更新</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="sim-lobby-foot">${back}<button type="button" class="btn btn-sm" data-sim="admin-refresh" ${this.adminLoading ? 'disabled' : ''}>重新讀取</button></p>`;
  }

  private playerDetailHtml(p: PlayerRef): string {
    const sv = this.playerSaves.get(p.sync);
    const back = `<button type="button" class="btn btn-sm" data-sim="admin">← 所有玩家</button>`;
    if (!sv || sv === 'error') return `<h2 class="sim-title">${esc(p.label)}</h2><p class="muted">沒有資料。</p>${back}`;
    const c = sv.current;
    let current = '<p class="muted">目前沒有進行中的模擬。</p>';
    if (c) {
      const eq = c.equity.at(-1)?.[1] ?? c.settings.capital;
      const ret = eq / c.settings.capital - 1;
      const bench = this.benchOf(c);
      const holds = c.pos
        .map((h) => `<tr><td><b>${esc(h.code)}</b> ${esc(this.nameOf(h.code))}</td><td>${KIND_NAME[h.kind]}${h.dir === 'short' && h.kind === 'day' ? '空' : ''}</td><td class="num">${num(h.shares)}</td><td class="num">${price(h.cost / h.shares)}</td><td class="num">${money(h.cost)}</td></tr>`)
        .join('');
      const log = [
        ...c.trades.map((t) => ({
          k: t.day * 1000 + t.minute,
          when: `${t.date} ${clock(t.minute)}`,
          html: `<span class="${t.side === 'buy' ? 'up' : 'down'}">${actionName(t.kind, t.side)}</span> <b>${esc(t.code)}</b> ${esc(this.nameOf(t.code))}
            <span class="num">${num(t.shares)} 股 @ ${price(t.price)}</span>${t.pnl != null ? ` <span class="num ${cls(t.pnl)}">損益 ${money(t.pnl)}</span>` : ''}`,
        })),
        ...c.notes.map((n) => ({ k: n.day * 1000 + n.minute + 0.5, when: `${n.date} ${clock(n.minute)}`, html: `${n.code ? `<b>${esc(n.code)}</b> ${esc(this.nameOf(n.code))} ` : ''}<span class="muted">${esc(n.text)}</span>` })),
      ].sort((a, b) => b.k - a.k);
      const pending = c.orders.map((o) => `<li>${actionName(o.kind, o.side)} <b>${esc(o.code)}</b> ${num(o.shares)} 股 限價 ${o.limit}</li>`).join('');
      current = `
        <dl class="sim-kpis">
          <div><dt>期間</dt><dd class="num">${esc(c.settings.start)} → ${esc(c.date)}</dd></div>
          <div><dt>總資產（上次收盤）</dt><dd class="num">${money(eq)}</dd></div>
          <div><dt>報酬率</dt><dd class="num ${cls(ret)}">${pct(ret * 100)}</dd></div>
          <div><dt>同期大盤</dt><dd class="num ${bench == null ? 'muted' : cls(bench)}">${bench == null ? '—' : pct(bench * 100)}</dd></div>
          <div><dt>現金</dt><dd class="num">${money(c.cash)}</dd></div>
        </dl>
        <h3 class="sim-sub">部位</h3>
        ${holds ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>股票</th><th>類別</th><th>股數</th><th>成本均價</th><th>成本合計</th></tr></thead><tbody>${holds}</tbody></table></div>` : '<p class="muted">沒有部位。</p>'}
        ${pending ? `<h3 class="sim-sub">委託中</h3><ul class="sim-orders">${pending}</ul>` : ''}
        <h3 class="sim-sub">交易紀錄（${c.trades.length} 筆）</h3>
        ${log.length ? `<ol class="sim-logs sim-admin-log">${log.map((i) => `<li><time class="num muted">${esc(i.when)}</time> ${i.html}</li>`).join('')}</ol>` : '<p class="muted">還沒有交易。</p>'}`;
    }
    const hist = sv.history
      .map((r) => {
        const ret = r.equity / r.capital - 1;
        return `<tr><td class="num">${esc(r.start)} → ${esc(r.end)}</td><td class="num">${r.days}</td><td class="num">${money(r.capital)}</td><td class="num ${cls(ret)}">${pct(ret * 100)}</td>
          <td class="num ${r.bench == null ? 'muted' : cls(r.bench)}">${r.bench == null ? '—' : pct(r.bench * 100)}</td><td class="num">${r.trades}</td></tr>`;
      })
      .join('');
    return `<p class="eyebrow">Laplace Replay · 管理員</p><h2 class="sim-title">${esc(p.label)}</h2>
      <h3 class="sim-sub">進行中的模擬</h3>${current}
      <h3 class="sim-sub">練習紀錄（完成 ${sv.history.length} 局）</h3>
      ${hist ? `<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>期間</th><th>交易日</th><th>本金</th><th>報酬</th><th>同期大盤</th><th>成交筆數</th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="muted">還沒有完成的模擬。</p>'}
      <p class="sim-lobby-foot">${back}</p>`;
  }
}
