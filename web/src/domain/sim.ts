/**
 * 拉普拉斯模擬盤：用歷史日 K 加上「偽即時」盤中走勢，以模擬帳戶練習交易。
 *
 * 時間：每個交易日 09:00～13:30（第 0～270 分鐘），盤中價格由當天開高低收產生（domain/intraday.ts）。
 * 下單：市價單用當下價格立刻成交；限價單在價格碰到時以限價成交，收盤還沒成交就取消（當日有效）。
 * 交易類別：
 * - 現股：全額付款；當天買的也可以賣。
 * - 現股當沖：先買後賣或先賣後買，當天沖銷，賣出證交稅減半（0.15%，ETF 0.1%）；收盤還沒沖銷的部位以收盤價自動沖銷。
 * - 融資：自備 40%、融資 60%，利率年 6.5%（每個交易日計息），賣出時還款。
 * - 融券：繳 90% 保證金，賣出價款留作擔保，借券費 0.08%；買回時結清。
 * - 整戶維持率（融資＋融券）收盤低於 130% 提醒追繳，低於 120% 以收盤價強制了結全部融資融券部位（簡化，不給兩天補繳期）。
 * 其他：手續費 0.1425% × 折扣（整股最低 20 元、零股 1 元）、一般賣出證交稅 0.3%（ETF 0.1%）；
 * 一價鎖漲停買不到、一價鎖跌停賣不掉；當天沒有成交資料（暫停交易）不能交易；
 * 除權息在開盤前處理：現股與融資領現金股利／配股，融券要付現金股利、配股則要多還股票。
 */
import { SESSION_MINUTES, intradayPath, type IntradayPath } from './intraday';
import type { Candle } from './technicals';

export const LOT = 1000;
export const FEE_RATE = 0.001425;
export const MARGIN_LOAN = 0.6;
export const MARGIN_RATE = 0.065;
export const SHORT_DEPOSIT = 0.9;
export const SHORT_FEE = 0.0008;
export const MAINT_CALL = 1.3;
export const MAINT_FORCE = 1.2;

export type Side = 'buy' | 'sell';
export type Kind = 'cash' | 'day' | 'margin' | 'short';
export const KIND_NAME: Record<Kind, string> = { cash: '現股', day: '當沖', margin: '融資', short: '融券' };

export interface SimOrder {
  id: number;
  code: string;
  side: Side;
  kind: Kind;
  shares: number;
  /** 沒有 = 市價單。 */
  limit?: number;
}

/** 一個部位：同一檔、同一種類別、同一個方向合併成一筆。 */
export interface Position {
  code: string;
  kind: Kind;
  dir: 'long' | 'short';
  shares: number;
  /** 多方：付出的總成本（含手續費）。空方：賣出淨得（扣掉費用與稅）。 */
  cost: number;
  /** 融資借款。 */
  loan?: number;
  /** 融資累計利息。 */
  interest?: number;
  /** 融券保證金。 */
  deposit?: number;
}

export interface Trade {
  date: string;
  /** 第幾個交易日（畫面上不顯示真實日期，用這個）。 */
  day: number;
  minute: number;
  code: string;
  side: Side;
  kind: Kind;
  shares: number;
  price: number;
  fee: number;
  tax: number;
  /** 了結部位時的實現損益（扣掉費用、稅、利息）。 */
  pnl?: number;
}

export interface SimNote {
  date: string;
  day: number;
  minute: number;
  code: string;
  text: string;
}

export interface SimSettings {
  /** 第一個交易日。 */
  start: string;
  capital: number;
  /** 手續費折扣（0.6 = 6 折）。 */
  discount: number;
}

export interface SimState {
  v: 2;
  settings: SimSettings;
  /** 目前的交易日。 */
  date: string;
  /** 目前是第幾分鐘（0 = 09:00，270 = 13:30 收盤）。 */
  minute: number;
  /** 這是第幾個交易日（從 1 開始）。 */
  day: number;
  cash: number;
  pos: Position[];
  /** 今天還沒成交的限價單。 */
  orders: SimOrder[];
  trades: Trade[];
  notes: SimNote[];
  /** 每天收盤的 [日期, 總資產]。 */
  equity: Array<[string, number]>;
  nextId: number;
  watch: string;
}

/** 除權息：[日期, 代號, 除權息前收盤, 參考價, 權值+息值, 權/息] */
export type ExRight = [string, string, number, number, number, string];

export interface Market {
  bar(code: string, date: string): Candle | undefined;
  /** date 之前（不含）最後一根日 K 的收盤。 */
  prevClose(code: string, date: string): number | undefined;
  exRights(date: string): ExRight[];
  /** 某檔某天的盤中路徑（沒有成交資料時 null）。 */
  path(code: string, date: string): IntradayPath | null;
}

export const isEtf = (code: string) => code.startsWith('00');

export function feeOf(amount: number, discount: number, shares: number): number {
  const min = shares % LOT === 0 ? 20 : 1;
  return Math.max(min, Math.floor(amount * FEE_RATE * discount));
}

export function taxOf(amount: number, code: string, dayTrade = false): number {
  return Math.floor(amount * (isEtf(code) ? 0.001 : dayTrade ? 0.0015 : 0.003));
}

/** 一價到底（開高低收都一樣）且漲跌超過 9%：1 = 漲停鎖死、-1 = 跌停鎖死、0 = 不是。 */
export function lockedLimit(bar: Candle, prevClose: number | undefined): -1 | 0 | 1 {
  if (!prevClose || bar.open !== bar.high || bar.high !== bar.low || bar.low !== bar.close) return 0;
  const r = bar.close / prevClose - 1;
  return r >= 0.09 ? 1 : r <= -0.09 ? -1 : 0;
}

export function newSim(settings: SimSettings, watch = '2330'): SimState {
  return {
    v: 2,
    settings,
    date: settings.start,
    minute: 0,
    day: 1,
    cash: settings.capital,
    pos: [],
    orders: [],
    trades: [],
    notes: [],
    equity: [],
    nextId: 1,
    watch,
  };
}

/** 舊版（每天收盤後下單、隔天開盤成交）的存檔轉成新版：視為那一天已收盤。 */
export function migrate(raw: unknown): SimState | null {
  const s = raw as Partial<SimState> & { v?: number; holdings?: Record<string, { shares: number; cost: number }>; trades?: Array<Partial<Trade>>; notes?: Array<Partial<SimNote>> };
  if (!s || typeof s !== 'object') return null;
  if (s.v === 2) return s as SimState;
  if (s.v !== 1 || !s.settings || !s.date) return null;
  const dates = (s.equity ?? []).map((e) => e[0]);
  const dayOf = (d?: string) => Math.max(1, dates.indexOf(d ?? '') + 1);
  return {
    v: 2,
    settings: s.settings,
    date: s.date,
    minute: SESSION_MINUTES,
    day: Math.max(1, dates.length),
    cash: s.cash ?? s.settings.capital,
    pos: Object.entries(s.holdings ?? {}).map(([code, h]) => ({ code, kind: 'cash' as const, dir: 'long' as const, shares: h.shares, cost: h.cost })),
    orders: [],
    trades: (s.trades ?? []).map((t) => ({ ...(t as Trade), kind: 'cash' as const, day: dayOf(t.date), minute: 0 })),
    notes: (s.notes ?? []).map((n) => ({ ...(n as SimNote), day: dayOf(n.date), minute: 0 })),
    equity: s.equity ?? [],
    nextId: s.nextId ?? 1,
    watch: s.watch ?? '2330',
  };
}

// ------------------------------------------------------------ 價格與市值

/** 現在的價格：今天有成交用盤中路徑，否則用最近收盤。 */
export function priceNow(s: SimState, m: Market, code: string): number | undefined {
  const p = m.path(code, s.date);
  if (p) return p.price[Math.min(SESSION_MINUTES, Math.max(0, Math.floor(s.minute)))];
  return m.prevClose(code, s.date);
}

function posValue(p: Position, price: number): number {
  const mv = p.shares * price;
  switch (p.kind) {
    case 'margin':
      return mv - (p.loan ?? 0) - (p.interest ?? 0);
    case 'short':
      return (p.deposit ?? 0) + p.cost - mv;
    default:
      // 現股、當沖多方算市值；當沖空方的賣出價款已經在現金裡，這裡扣掉要買回的錢
      return p.dir === 'long' ? mv : -mv;
  }
}

export function equityOf(s: SimState, m: Market): number {
  let v = s.cash;
  for (const p of s.pos) v += posValue(p, priceNow(s, m, p.code) ?? p.cost / Math.max(1, p.shares));
  return v;
}

/** 整戶擔保維持率（只算融資、融券），沒有信用部位時 null。 */
export function maintenance(s: SimState, m: Market): number | null {
  let assets = 0;
  let debts = 0;
  for (const p of s.pos) {
    const price = priceNow(s, m, p.code) ?? 0;
    if (p.kind === 'margin') {
      assets += p.shares * price;
      debts += p.loan ?? 0;
    } else if (p.kind === 'short') {
      assets += (p.deposit ?? 0) + p.cost;
      debts += p.shares * price;
    }
  }
  return debts > 0 ? assets / debts : null;
}

function findPos(s: SimState, code: string, kind: Kind, dir: 'long' | 'short'): Position | undefined {
  return s.pos.find((p) => p.code === code && p.kind === kind && p.dir === dir);
}

function dropEmpty(s: SimState): void {
  s.pos = s.pos.filter((p) => p.shares > 0);
}

/** 當沖單會做什麼：有反向的當沖部位就沖銷，否則建立新部位。 */
function dayAction(s: SimState, code: string, side: Side): 'open' | 'close' {
  return findPos(s, code, 'day', side === 'buy' ? 'short' : 'long') ? 'close' : 'open';
}

/** 委託中的買單要先保留的現金。 */
export function reservedCash(s: SimState, m: Market): number {
  let r = 0;
  for (const o of s.orders) r += cashNeed(s, m, o, o.limit ?? priceNow(s, m, o.code) ?? 0);
  return r;
}

/** 這筆委託成交需要多少現金（賣出了結部位不需要）。 */
function cashNeed(s: SimState, _m: Market, o: Omit<SimOrder, 'id'>, price: number): number {
  const amt = price * o.shares;
  const fee = feeOf(amt, s.settings.discount, o.shares);
  if (o.kind === 'cash') return o.side === 'buy' ? amt + fee : 0;
  if (o.kind === 'margin') return o.side === 'buy' ? amt * (1 - MARGIN_LOAN) + fee : 0;
  if (o.kind === 'short') return o.side === 'sell' ? amt * SHORT_DEPOSIT : amt + fee;
  // 當沖：建立部位時要有足夠現金（先賣後買也要有等額的額度）
  return dayAction(s, o.code, o.side) === 'open' ? amt + fee : o.side === 'buy' ? amt + fee : 0;
}

/** 已委託、還沒成交的同方向股數（避免重複賣出同一批股票）。 */
function pendingShares(s: SimState, code: string, kind: Kind, side: Side): number {
  return s.orders.filter((o) => o.code === code && o.kind === kind && o.side === side).reduce((a, o) => a + o.shares, 0);
}

/** 下單前檢查；回傳錯誤訊息或 null。 */
export function checkOrder(s: SimState, m: Market, o: Omit<SimOrder, 'id'>): string | null {
  if (s.minute >= SESSION_MINUTES) return '已經收盤，請等下一個交易日開盤';
  if (!Number.isInteger(o.shares) || o.shares <= 0) return '股數要是正整數';
  if (o.limit !== undefined && !(o.limit > 0)) return '限價要大於 0';
  const bar = m.bar(o.code, s.date);
  if (!bar) return '這檔股票今天沒有交易（可能暫停交易或還沒上市）';
  const lock = lockedLimit(bar, m.prevClose(o.code, s.date));
  if (o.side === 'buy' && lock === 1) return '今天一價鎖漲停，買不到';
  if (o.side === 'sell' && lock === -1) return '今天一價鎖跌停，賣不掉';
  if ((o.kind === 'margin' || o.kind === 'short') && isEtf(o.code) && /[LRU]$/.test(o.code)) return '槓桿、反向 ETF 不能信用交易';
  // 了結部位：要有足夠的股數
  const closing =
    (o.kind === 'cash' && o.side === 'sell') ||
    (o.kind === 'margin' && o.side === 'sell') ||
    (o.kind === 'short' && o.side === 'buy') ||
    (o.kind === 'day' && dayAction(s, o.code, o.side) === 'close');
  if (closing) {
    const dir = o.kind === 'short' || (o.kind === 'day' && o.side === 'buy') ? 'short' : 'long';
    const have = findPos(s, o.code, o.kind, dir)?.shares ?? 0;
    const pend = pendingShares(s, o.code, o.kind, o.side);
    if (o.shares > have - pend) return `${KIND_NAME[o.kind]}可${o.side === 'buy' ? '回補' : '賣出'}股數不足（部位 ${have} 股，委託中 ${pend} 股）`;
  }
  const px = o.limit ?? priceNow(s, m, o.code) ?? 0;
  const need = cashNeed(s, m, o, px);
  if (need > s.cash - reservedCash(s, m)) return `可用現金不足（約需 ${Math.round(need).toLocaleString()} 元）`;
  return null;
}

/** 下單：市價單、或價格已經碰到的限價單立刻成交，其他的掛著等。 */
export function placeOrder(s: SimState, m: Market, o: Omit<SimOrder, 'id'>): string | null {
  const err = checkOrder(s, m, o);
  if (err) return err;
  const order: SimOrder = { ...o, id: s.nextId++ };
  const now = priceNow(s, m, o.code)!;
  const marketable = o.limit === undefined || (o.side === 'buy' ? now <= o.limit : now >= o.limit);
  if (marketable) return execute(s, m, order, now);
  s.orders.push(order);
  return null;
}

export function cancelOrder(s: SimState, id: number): void {
  s.orders = s.orders.filter((o) => o.id !== id);
}

function note(s: SimState, code: string, text: string): void {
  s.notes.push({ date: s.date, day: s.day, minute: Math.floor(s.minute), code, text });
}

/** 成交一筆委託；失敗時回傳原因。 */
function execute(s: SimState, m: Market, o: SimOrder, price: number, force = false): string | null {
  const amt = price * o.shares;
  const fee = feeOf(amt, s.settings.discount, o.shares);
  const record = (tax: number, pnl?: number) =>
    s.trades.push({ date: s.date, day: s.day, minute: Math.floor(s.minute), code: o.code, side: o.side, kind: o.kind, shares: o.shares, price, fee, tax, pnl: pnl == null ? undefined : Math.round(pnl) });
  const need = cashNeed(s, m, o, price);
  if (!force && need > s.cash) return '現金不足';

  const openLong = (kind: Kind, extra: Partial<Position>, cashOut: number) => {
    s.cash -= cashOut;
    const p = findPos(s, o.code, kind, 'long') ?? (s.pos.push({ code: o.code, kind, dir: 'long', shares: 0, cost: 0 }), s.pos[s.pos.length - 1]);
    p.shares += o.shares;
    p.cost += amt + fee;
    if (extra.loan) p.loan = (p.loan ?? 0) + extra.loan;
    record(0);
  };
  const closeLong = (kind: Kind, dayTrade: boolean) => {
    const p = findPos(s, o.code, kind, 'long')!;
    const tax = taxOf(amt, o.code, dayTrade);
    const part = o.shares / p.shares;
    const cost = p.cost * part;
    const loan = (p.loan ?? 0) * part;
    const interest = (p.interest ?? 0) * part;
    s.cash += amt - fee - tax - loan - interest;
    p.shares -= o.shares;
    p.cost -= cost;
    if (p.loan) p.loan -= loan;
    if (p.interest) p.interest -= interest;
    record(tax, amt - fee - tax - cost - interest);
  };
  const openShort = (kind: Kind, dayTrade: boolean) => {
    const tax = taxOf(amt, o.code, dayTrade);
    const borrow = kind === 'short' ? Math.round(amt * SHORT_FEE) : 0;
    const net = amt - fee - tax - borrow;
    const p = findPos(s, o.code, kind, 'short') ?? (s.pos.push({ code: o.code, kind, dir: 'short', shares: 0, cost: 0 }), s.pos[s.pos.length - 1]);
    p.shares += o.shares;
    p.cost += net;
    if (kind === 'short') {
      const dep = amt * SHORT_DEPOSIT;
      s.cash -= dep;
      p.deposit = (p.deposit ?? 0) + dep;
    } else s.cash += net;
    record(tax + borrow);
  };
  const closeShort = (kind: Kind) => {
    const p = findPos(s, o.code, kind, 'short')!;
    const part = o.shares / p.shares;
    const proceeds = p.cost * part;
    const dep = (p.deposit ?? 0) * part;
    if (kind === 'short') s.cash += dep + proceeds - amt - fee;
    else s.cash -= amt + fee;
    p.shares -= o.shares;
    p.cost -= proceeds;
    if (p.deposit) p.deposit -= dep;
    record(0, proceeds - amt - fee);
  };

  switch (o.kind) {
    case 'cash':
      if (o.side === 'buy') openLong('cash', {}, amt + fee);
      else closeLong('cash', false);
      break;
    case 'margin':
      if (o.side === 'buy') openLong('margin', { loan: amt * MARGIN_LOAN }, amt * (1 - MARGIN_LOAN) + fee);
      else closeLong('margin', false);
      break;
    case 'short':
      if (o.side === 'sell') openShort('short', false);
      else closeShort('short');
      break;
    case 'day':
      if (dayAction(s, o.code, o.side) === 'close') {
        if (o.side === 'sell') closeLong('day', true);
        else closeShort('day');
      } else if (o.side === 'buy') openLong('day', {}, amt + fee);
      else openShort('day', true);
      break;
  }
  dropEmpty(s);
  return null;
}

/** 時間往前走到第 target 分鐘：逐分鐘檢查掛著的限價單有沒有碰到價格。 */
export function tickTo(s: SimState, m: Market, target: number): void {
  const end = Math.min(SESSION_MINUTES, target);
  for (let t = Math.floor(s.minute) + 1; t <= end; t++) {
    s.minute = t;
    if (!s.orders.length) continue;
    for (const o of [...s.orders]) {
      const p = m.path(o.code, s.date)?.price[t];
      if (p == null || o.limit == null) continue;
      if (o.side === 'buy' ? p <= o.limit : p >= o.limit) {
        s.orders = s.orders.filter((x) => x.id !== o.id);
        const err = execute(s, m, o, o.limit);
        if (err) note(s, o.code, `限價單未成交：${err}`);
      }
    }
  }
  s.minute = Math.max(s.minute, end);
}

/** 收盤：取消剩下的委託、沖銷當沖部位、融資計息、檢查維持率，記下今天的總資產。 */
export function closeDay(s: SimState, m: Market): void {
  tickTo(s, m, SESSION_MINUTES);
  for (const o of s.orders) note(s, o.code, `${o.side === 'buy' ? '買' : '賣'} ${o.shares.toLocaleString()} 股限價 ${o.limit} 收盤未成交，已取消`);
  s.orders = [];
  // 當沖沒沖銷的部位以收盤價自動沖銷
  for (const p of s.pos.filter((x) => x.kind === 'day')) {
    const price = priceNow(s, m, p.code) ?? p.cost / p.shares;
    execute(s, m, { id: s.nextId++, code: p.code, side: p.dir === 'long' ? 'sell' : 'buy', kind: 'day', shares: p.shares }, price, true);
    note(s, p.code, `當沖未沖銷，收盤以 ${price} 自動${p.dir === 'long' ? '賣出' : '買回'}`);
  }
  // 融資利息（每個交易日）
  for (const p of s.pos) if (p.kind === 'margin' && p.loan) p.interest = (p.interest ?? 0) + (p.loan * MARGIN_RATE) / 250;
  const ratio = maintenance(s, m);
  if (ratio != null && ratio < MAINT_FORCE) {
    for (const p of s.pos.filter((x) => x.kind === 'margin' || x.kind === 'short')) {
      const price = priceNow(s, m, p.code) ?? 0;
      execute(s, m, { id: s.nextId++, code: p.code, side: p.dir === 'long' ? 'sell' : 'buy', kind: p.kind, shares: p.shares }, price, true);
    }
    note(s, '', `整戶維持率 ${Math.round(ratio * 100)}% 低於 ${MAINT_FORCE * 100}%，融資融券部位已被強制了結（斷頭）`);
  } else if (ratio != null && ratio < MAINT_CALL) {
    note(s, '', `整戶維持率 ${Math.round(ratio * 100)}% 低於 ${MAINT_CALL * 100}%，請減碼或補足，再跌可能被斷頭`);
  }
  s.minute = SESSION_MINUTES;
  s.equity.push([s.date, Math.round(equityOf(s, m))]);
}

/** 進入下一個交易日的 09:00：先處理除權息。 */
export function beginDay(s: SimState, m: Market, date: string): void {
  if (date <= s.date) return;
  s.date = date;
  s.minute = 0;
  s.day += 1;
  s.orders = [];
  for (const [, code, prev, ref, value, kind] of m.exRights(date)) {
    if (!(value > 0)) continue;
    for (const p of s.pos.filter((x) => x.code === code)) {
      const stock = kind.includes('權');
      const sign = p.dir === 'long' ? 1 : -1;
      if (!stock) {
        const cash = Math.round(p.shares * value);
        s.cash += sign * cash;
        note(s, code, `除息：每股 ${value.toFixed(2)} 元，${sign > 0 ? '入帳' : '融券須付'} ${cash.toLocaleString()} 元`);
      } else if (ref > 0) {
        const extra = Math.floor(kind.includes('息') ? (p.shares * value) / ref : p.shares * (prev / ref - 1));
        if (extra <= 0) continue;
        p.shares += extra;
        note(s, code, `除權：${sign > 0 ? '配' : '融券須多還'} ${extra.toLocaleString()} 股（依參考價換算）`);
      }
    }
  }
}

export interface SimSummary {
  equity: number;
  ret: number;
  maxDrawdown: number;
  realized: number;
  wins: number;
  losses: number;
  fees: number;
  days: number;
}

export function summarize(s: SimState, m: Market): SimSummary {
  const equity = equityOf(s, m);
  let peak = s.settings.capital;
  let mdd = 0;
  for (const [, v] of s.equity) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, peak > 0 ? 1 - v / peak : 0);
  }
  const closes = s.trades.filter((t) => t.pnl != null);
  return {
    equity,
    ret: equity / s.settings.capital - 1,
    maxDrawdown: mdd,
    realized: closes.reduce((a, t) => a + (t.pnl ?? 0), 0),
    wins: closes.filter((t) => (t.pnl ?? 0) > 0).length,
    losses: closes.filter((t) => (t.pnl ?? 0) <= 0).length,
    fees: s.trades.reduce((a, t) => a + t.fee + t.tax, 0),
    days: s.equity.length,
  };
}

/** 由日 K 陣列建立查詢用的 Market（測試與網頁共用）；盤中路徑依需要產生並快取。 */
export function buildMarket(series: Map<string, Candle[]>, ex: ExRight[] = []): Market {
  const idx = new Map<string, Map<string, Candle>>();
  for (const [code, rows] of series) idx.set(code, new Map(rows.map((c) => [c.date, c])));
  const exBy = new Map<string, ExRight[]>();
  for (const r of ex) (exBy.get(r[0]) ?? exBy.set(r[0], []).get(r[0])!).push(r);
  const paths = new Map<string, IntradayPath | null>();
  return {
    bar: (code, date) => idx.get(code)?.get(date),
    prevClose(code, date) {
      const rows = series.get(code);
      if (!rows?.length || rows[0].date >= date) return undefined;
      let lo = 0;
      let hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rows[mid].date < date) lo = mid;
        else hi = mid - 1;
      }
      return rows[lo].close;
    },
    exRights: (date) => exBy.get(date) ?? [],
    path(code, date) {
      const key = `${code}|${date}`;
      if (!paths.has(key)) {
        const b = idx.get(code)?.get(date);
        paths.set(key, b ? intradayPath(code, date, b) : null);
        if (paths.size > 400) paths.delete(paths.keys().next().value!);
      }
      return paths.get(key)!;
    },
  };
}
