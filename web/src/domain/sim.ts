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
 *
 * 停損／停利單：針對一個部位設定觸發價，盤中價格碰到時以當下價格（市價）了結整個部位；長效有效，直到觸發、取消或部位沒了。
 * 資金（每個月第一個交易日開盤前處理）：
 * - 薪資投入：每月固定投入（預設 2 萬，設定裡可以改，0 = 不投入）。
 * - 信用貸款：額度 100 萬、年利率 3.5%，本息平均攤還；可以隨時提前還款（之後月付金重算）。
 *   現金不夠扣款時，沒繳到的部分加 1% 違約金滾入本金。
 * - 股票質押：拿現股向銀行借錢，最多借市值的 60%，年利率 2.5%（每個交易日計息，每月扣息）；
 *   質押中的股票不能賣。維持率（質押股票市值 ÷ 借款＋利息）收盤低於 130% 提醒，低於 120% 強制賣出質押股票還款。
 * - 定期定額：每月第一個交易日（薪資入帳後）以開盤價買進設定的金額，可以買零股。
 * 報酬率＝總資產 ÷ 累計投入（本金＋薪資）－ 1；貸款是負債，不算投入。
 *
 * 盤前（08:30～09:00）：每天先停在盤前，可以先下單（市價或限價），按「開盤」後以開盤集合競價撮合：
 * 市價單、買進限價 ≥ 開盤價、賣出限價 ≤ 開盤價的單子都以開盤價成交，其他限價單留到盤中繼續等。
 * 盤前看不到今天的價格（現價＝昨收），一價鎖漲跌停在開盤時才判斷。
 * 開盤前就觸發的停損／停利單也以開盤價成交（一價鎖跌停時賣不掉，會提醒）；定期定額在開盤時買進。
 */
import { SESSION_MINUTES, intradayPath, type IntradayPath } from './intraday';
import { detectSplits, type Split } from './splits';
import type { Candle } from './technicals';

export const LOT = 1000;
export const FEE_RATE = 0.001425;
export const MARGIN_LOAN = 0.6;
export const MARGIN_RATE = 0.065;
export const SHORT_DEPOSIT = 0.9;
export const SHORT_FEE = 0.0008;
export const MAINT_CALL = 1.3;
export const MAINT_FORCE = 1.2;
export const SALARY = 20_000;
export const LOAN_LIMIT = 1_000_000;
export const LOAN_RATE = 0.035;
export const LOAN_TERMS = [12, 24, 36, 60, 84] as const;
export const LOAN_PENALTY = 0.01;
export const PLEDGE_LTV = 0.6;
export const PLEDGE_RATE = 0.025;
export const PLEDGE_CALL = 1.3;
export const PLEDGE_FORCE = 1.2;

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
  /** 每月薪資投入（沒有 = 0）。 */
  monthly?: number;
  /**
   * 破產條件：收盤時虧損達到累計投入的這個比例就破產（1 = 總資產歸零、0.8、0.5；0 = 不會破產）。
   * 沒設定（舊存檔）視為 1。
   */
  ruinLoss?: number;
  /** 隨機開局抽到的情境（結束報告才揭曉）。 */
  scenario?: string;
}

/** 破產時的狀態。 */
export interface Bankrupt {
  date: string;
  day: number;
  /** 破產時（強制了結後）的總資產。 */
  equity: number;
}

/** 停損／停利：盤中價格碰到就以市價了結整個部位。 */
export interface StopOrder {
  id: number;
  code: string;
  kind: Kind;
  dir: 'long' | 'short';
  /** 停損價（多方：跌到以下；空方：漲到以上）。 */
  loss?: number;
  /** 停利價（多方：漲到以上；空方：跌到以下）。 */
  profit?: number;
  /** 觸發了但成交不了（例如鎖跌停）時，那一天已經提醒過。 */
  warned?: string;
}

/** 定期定額：每月第一個交易日以開盤價買進 amount 元。 */
export interface DcaPlan {
  code: string;
  amount: number;
}

/** 信用貸款（本息平均攤還）。 */
export interface Loan {
  id: number;
  principal: number;
  balance: number;
  rate: number;
  months: number;
  /** 還剩幾期。 */
  left: number;
  /** 每月應繳。 */
  payment: number;
}

/** 股票質押借款（每檔一筆）。 */
export interface Pledge {
  code: string;
  shares: number;
  loan: number;
  /** 累計未繳利息。 */
  interest: number;
}

/** 每天收盤的結算。 */
export interface DayRec {
  d: string;
  /** 總資產。 */
  eq: number;
  /** 今天的已實現損益。 */
  real: number;
  /** 收盤時持有部位的未實現損益合計。 */
  float: number;
  /** 今天的手續費＋稅。 */
  fee: number;
  /** 今天投入的資金（薪資）。 */
  flow: number;
  /** 今天成交筆數。 */
  n: number;
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
  stops: StopOrder[];
  loans: Loan[];
  pledges: Pledge[];
  /** 每天收盤的結算（舊存檔沒有）。 */
  days: DayRec[];
  /** 本金以外投入的資金 [日期, 金額]。 */
  flows: Array<[string, number]>;
  dca: DcaPlan[];
  /** 自選股。 */
  fav: string[];
  /** 盤前（還沒開盤）。 */
  pre?: boolean;
  /** 這個月的定期定額要在開盤時買進。 */
  dcaDue?: boolean;
  /** 破產了：這一局結束，不能再交易。 */
  bankrupt?: Bankrupt;
  /** 已經處理過的分割／減資（"代號|日期"）。 */
  splitsDone?: string[];
}

/** 除權息：[日期, 代號, 除權息前收盤, 參考價, 權值+息值, 權/息] */
export type ExRight = [string, string, number, number, number, string];

export interface Market {
  bar(code: string, date: string): Candle | undefined;
  /** date 之前（不含）最後一根日 K 的收盤。 */
  prevClose(code: string, date: string): number | undefined;
  exRights(date: string): ExRight[];
  /** 這一天生效的分割／減資：[代號, 股數倍數]。 */
  splits(date: string): Array<[string, number]>;
  /** 某檔所有的分割／減資（圖表還原用；只能用模擬日以前的）。 */
  splitsOf(code: string): Split[];
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

/** 開新的一局（preOpen = true：第一天也從盤前開始）。 */
export function newSim(settings: SimSettings, watch = '2330', preOpen = false): SimState {
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
    stops: [],
    loans: [],
    pledges: [],
    days: [],
    flows: [],
    dca: [],
    fav: [],
    pre: preOpen,
  };
}

/** 舊存檔沒有的欄位補上預設值。 */
function withDefaults(s: SimState): SimState {
  s.stops ??= [];
  s.loans ??= [];
  s.pledges ??= [];
  s.days ??= [];
  s.flows ??= [];
  s.dca ??= [];
  s.fav ??= [];
  return s;
}

/** 舊版（每天收盤後下單、隔天開盤成交）的存檔轉成新版：視為那一天已收盤。 */
export function migrate(raw: unknown): SimState | null {
  const s = raw as Partial<SimState> & { v?: number; holdings?: Record<string, { shares: number; cost: number }>; trades?: Array<Partial<Trade>>; notes?: Array<Partial<SimNote>> };
  if (!s || typeof s !== 'object') return null;
  if (s.v === 2) return withDefaults(s as SimState);
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
    stops: [],
    loans: [],
    pledges: [],
    days: [],
    flows: [],
    dca: [],
    fav: [],
  };
}

// ------------------------------------------------------------ 價格與市值

/** 現在的價格：今天有成交用盤中路徑，否則用最近收盤。 */
export function priceNow(s: SimState, m: Market, code: string): number | undefined {
  // 盤前還不知道今天的價格
  if (s.pre) return m.prevClose(code, s.date);
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

/** 總資產＝現金＋部位價值－貸款與質押借款（含未繳利息）。 */
export function equityOf(s: SimState, m: Market): number {
  let v = s.cash;
  for (const p of s.pos) v += posValue(p, priceNow(s, m, p.code) ?? p.cost / Math.max(1, p.shares));
  return v - debtOf(s);
}

/** 信貸餘額＋質押借款與未繳利息。 */
export function debtOf(s: SimState): number {
  let d = 0;
  for (const l of s.loans) d += l.balance;
  for (const p of s.pledges) d += p.loan + p.interest;
  return d;
}

/** 累計投入＝本金＋薪資等投入。 */
export function investedOf(s: SimState): number {
  return s.settings.capital + s.flows.reduce((a, [, v]) => a + v, 0);
}

/** 一個部位現在了結的話，扣掉費用、稅、利息後的損益（未實現損益）；base 是投入的本錢。 */
export function unrealizedOf(p: Position, s: SimState, m: Market): { now: number | undefined; pnl: number; base: number } {
  const now = priceNow(s, m, p.code);
  if (now == null) return { now, pnl: 0, base: p.cost };
  const mv = now * p.shares;
  const fee = feeOf(mv, s.settings.discount, p.shares);
  if (p.dir === 'long') {
    const tax = taxOf(mv, p.code, p.kind === 'day');
    return { now, pnl: mv - fee - tax - p.cost - (p.interest ?? 0), base: p.kind === 'margin' ? p.cost * (1 - MARGIN_LOAN) : p.cost };
  }
  return { now, pnl: p.cost - mv - fee, base: p.kind === 'short' ? p.deposit ?? p.cost : p.cost };
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
  if (s.bankrupt) return '已經破產，這一局結束了';
  if (s.minute >= SESSION_MINUTES) return '已經收盤，請等下一個交易日開盤';
  if (!Number.isInteger(o.shares) || o.shares <= 0) return '股數要是正整數';
  if (o.limit !== undefined && !(o.limit > 0)) return '限價要大於 0';
  const bar = m.bar(o.code, s.date);
  if (!bar) return '這檔股票今天沒有交易（可能暫停交易或還沒上市）';
  // 盤前還不知道會不會鎖漲跌停，開盤撮合時才判斷
  const lock = s.pre ? 0 : lockedLimit(bar, m.prevClose(o.code, s.date));
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
    const pledged = o.kind === 'cash' ? pledgedShares(s, o.code) : 0;
    if (o.shares > have - pend - pledged)
      return `${KIND_NAME[o.kind]}可${o.side === 'buy' ? '回補' : '賣出'}股數不足（部位 ${have} 股，委託中 ${pend} 股${pledged ? `，質押中 ${pledged} 股` : ''}）`;
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
  // 盤前的單子先排著，開盤時一起撮合
  if (s.pre) {
    s.orders.push(order);
    return null;
  }
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
    for (const o of [...s.orders]) {
      const p = m.path(o.code, s.date)?.price[t];
      if (p == null || o.limit == null) continue;
      if (o.side === 'buy' ? p <= o.limit : p >= o.limit) {
        s.orders = s.orders.filter((x) => x.id !== o.id);
        const err = execute(s, m, o, o.limit);
        if (err) note(s, o.code, `限價單未成交：${err}`);
      }
    }
    if (s.stops.length) checkStops(s, m, t);
  }
  s.minute = Math.max(s.minute, end);
}

/** 第 t 分鐘：碰到停損／停利價的部位以當下價格了結。 */
function checkStops(s: SimState, m: Market, t: number): void {
  for (const st of [...s.stops]) {
    const p = findPos(s, st.code, st.kind, st.dir);
    if (!p) {
      s.stops = s.stops.filter((x) => x !== st);
      continue;
    }
    const px = m.path(st.code, s.date)?.price[t];
    if (px == null) continue;
    const long = st.dir === 'long';
    const hitLoss = st.loss != null && (long ? px <= st.loss : px >= st.loss);
    const hitProfit = st.profit != null && (long ? px >= st.profit : px <= st.profit);
    if (!hitLoss && !hitProfit) continue;
    const shares = p.shares - (st.kind === 'cash' ? pledgedShares(s, st.code) : 0) - pendingShares(s, st.code, st.kind, long ? 'sell' : 'buy');
    const o: Omit<SimOrder, 'id'> = { code: st.code, side: long ? 'sell' : 'buy', kind: st.kind, shares };
    const err = shares > 0 ? checkOrder(s, m, o) : st.kind === 'cash' && pledgedShares(s, st.code) ? '股票質押中，要先還款解除質押' : '沒有可以了結的股數';
    const what = hitLoss ? '停損' : '停利';
    if (err) {
      if (st.warned !== s.date) note(s, st.code, `${what}價 ${hitLoss ? st.loss : st.profit} 已觸發，但無法成交：${err}`);
      st.warned = s.date;
      continue;
    }
    s.stops = s.stops.filter((x) => x !== st);
    execute(s, m, { ...o, id: s.nextId++ }, px);
    note(s, st.code, `${what}觸發（設定 ${hitLoss ? st.loss : st.profit}），以 ${px} 了結 ${shares.toLocaleString()} 股`);
  }
}

/** 設定（或更新）某個部位的停損／停利價；兩個都沒有就是取消。回傳錯誤訊息或 null。 */
export function setStop(s: SimState, m: Market, code: string, kind: Kind, dir: 'long' | 'short', loss?: number, profit?: number): string | null {
  const p = findPos(s, code, kind, dir);
  if (!p) return '沒有這個部位';
  const now = priceNow(s, m, code);
  if (loss != null && !(loss > 0)) return '停損價要大於 0';
  if (profit != null && !(profit > 0)) return '停利價要大於 0';
  if (now != null) {
    const long = dir === 'long';
    if (loss != null && (long ? loss >= now : loss <= now)) return `停損價要${long ? '低於' : '高於'}現價 ${now}`;
    if (profit != null && (long ? profit <= now : profit >= now)) return `停利價要${long ? '高於' : '低於'}現價 ${now}`;
  }
  s.stops = s.stops.filter((x) => !(x.code === code && x.kind === kind && x.dir === dir));
  if (loss != null || profit != null) s.stops.push({ id: s.nextId++, code, kind, dir, loss, profit });
  return null;
}

export function stopOf(s: SimState, p: Position): StopOrder | undefined {
  return s.stops.find((x) => x.code === p.code && x.kind === p.kind && x.dir === p.dir);
}

// ------------------------------------------------------------ 資金：薪資、信貸、質押

export function pledgedShares(s: SimState, code: string): number {
  return s.pledges.find((p) => p.code === code)?.shares ?? 0;
}

/** 本息平均攤還的每月應繳。 */
export function annuity(balance: number, rate: number, months: number): number {
  const r = rate / 12;
  if (months <= 0) return Math.round(balance);
  if (r === 0) return Math.round(balance / months);
  return Math.round((balance * r) / (1 - (1 + r) ** -months));
}

export function takeLoan(s: SimState, amount: number, months: number): string | null {
  if (!(amount >= 10_000) || !Number.isFinite(amount)) return '貸款金額至少 1 萬元';
  if (!(LOAN_TERMS as readonly number[]).includes(months)) return '請選擇期數';
  const used = s.loans.reduce((a, l) => a + l.balance, 0);
  if (used + amount > LOAN_LIMIT) return `超過信貸額度（還可以借 ${Math.max(0, LOAN_LIMIT - used).toLocaleString()} 元）`;
  amount = Math.round(amount);
  s.loans.push({ id: s.nextId++, principal: amount, balance: amount, rate: LOAN_RATE, months, left: months, payment: annuity(amount, LOAN_RATE, months) });
  s.cash += amount;
  note(s, '', `信用貸款 ${amount.toLocaleString()} 元入帳（${months} 期，年利率 ${(LOAN_RATE * 100).toFixed(1)}%）`);
  return null;
}

/** 提前還款（部分或全部）；之後的月付金依剩下的期數重算。 */
export function repayLoan(s: SimState, id: number, amount: number): string | null {
  const l = s.loans.find((x) => x.id === id);
  if (!l) return '沒有這筆貸款';
  amount = Math.round(Math.min(amount, l.balance));
  if (!(amount > 0)) return '還款金額要大於 0';
  if (amount > s.cash) return `現金不足：要 ${amount.toLocaleString()} 元，現金只有 ${Math.max(0, Math.floor(s.cash)).toLocaleString()} 元（可以先還一部分）`;
  s.cash -= amount;
  l.balance -= amount;
  if (l.balance < 1) {
    s.loans = s.loans.filter((x) => x !== l);
    note(s, '', `信用貸款已全部還清`);
  } else {
    l.payment = annuity(l.balance, l.rate, l.left);
    note(s, '', `提前還款 ${amount.toLocaleString()} 元，剩餘本金 ${Math.round(l.balance).toLocaleString()} 元，月付金改為 ${l.payment.toLocaleString()} 元`);
  }
  return null;
}

/** 質押維持率＝質押股票市值 ÷（借款＋未繳利息）；沒有質押借款時 null。 */
export function pledgeRatio(s: SimState, m: Market): number | null {
  let value = 0;
  let debt = 0;
  for (const p of s.pledges) {
    value += p.shares * (priceNow(s, m, p.code) ?? 0);
    debt += p.loan + p.interest;
  }
  return debt > 0 ? value / debt : null;
}

/** 質押（可以只增加質押股數、只多借錢，或兩者都做）。 */
export function pledgeBorrow(s: SimState, m: Market, code: string, shares: number, amount: number): string | null {
  if (!Number.isInteger(shares) || shares < 0) return '質押股數要是正整數';
  if (!(amount >= 0)) return '借款金額不正確';
  if (!shares && !amount) return '請輸入質押股數或借款金額';
  const pos = findPos(s, code, 'cash', 'long');
  const pl = s.pledges.find((p) => p.code === code);
  const free = (pos?.shares ?? 0) - (pl?.shares ?? 0) - pendingShares(s, code, 'cash', 'sell');
  if (shares > free) return `可質押的現股不足（可質押 ${Math.max(0, free).toLocaleString()} 股；融資、當沖部位不能質押）`;
  const px = priceNow(s, m, code);
  if (!px) return '這檔現在沒有價格';
  const total = (pl?.shares ?? 0) + shares;
  const room = Math.floor(total * px * PLEDGE_LTV - (pl?.loan ?? 0) - (pl?.interest ?? 0));
  if (amount > room) return `最多還可以借 ${Math.max(0, room).toLocaleString()} 元（市值的 ${PLEDGE_LTV * 100}%）`;
  amount = Math.round(amount);
  if (pl) {
    pl.shares = total;
    pl.loan += amount;
  } else s.pledges.push({ code, shares: total, loan: amount, interest: 0 });
  s.cash += amount;
  note(s, code, `質押 ${total.toLocaleString()} 股${amount ? `，借款 ${amount.toLocaleString()} 元入帳` : ''}`);
  return null;
}

/** 質押還款：先繳利息再還本金。 */
export function pledgeRepay(s: SimState, code: string, amount: number): string | null {
  const pl = s.pledges.find((p) => p.code === code);
  if (!pl) return '沒有這筆質押';
  amount = Math.round(Math.min(amount, pl.loan + pl.interest));
  if (!(amount > 0)) return '還款金額要大於 0';
  if (amount > s.cash) return `現金不足：要 ${amount.toLocaleString()} 元，現金只有 ${Math.max(0, Math.floor(s.cash)).toLocaleString()} 元（可以先還一部分）`;
  s.cash -= amount;
  const toInterest = Math.min(amount, pl.interest);
  pl.interest -= toInterest;
  pl.loan -= amount - toInterest;
  if (pl.loan < 1) pl.loan = 0;
  note(s, code, `質押還款 ${amount.toLocaleString()} 元，剩餘借款 ${Math.round(pl.loan + pl.interest).toLocaleString()} 元`);
  return null;
}

/** 解除質押：解除後剩下的股票市值要還夠擔保借款（不超過 60%）。 */
export function pledgeRelease(s: SimState, m: Market, code: string, shares: number): string | null {
  const pl = s.pledges.find((p) => p.code === code);
  if (!pl) return '沒有這筆質押';
  if (!Number.isInteger(shares) || shares <= 0 || shares > pl.shares) return `解除股數要在 1～${pl.shares.toLocaleString()} 股之間`;
  const after = pl.shares - shares;
  const debt = pl.loan + pl.interest;
  const px = priceNow(s, m, code) ?? 0;
  if (debt > 0 && debt > after * px * PLEDGE_LTV) return `還有借款 ${Math.round(debt).toLocaleString()} 元，解除後擔保不足，請先還款`;
  pl.shares = after;
  if (!pl.shares && debt <= 0) s.pledges = s.pledges.filter((p) => p !== pl);
  note(s, code, `解除質押 ${shares.toLocaleString()} 股`);
  return null;
}

/** 設定（amount > 0）或取消（amount = 0）某檔的定期定額。 */
export function setDca(s: SimState, code: string, amount: number): string | null {
  amount = Math.round(amount);
  s.dca = s.dca.filter((p) => p.code !== code);
  if (!amount) return null;
  if (amount < 1000) return '定期定額每月至少 1,000 元';
  s.dca.push({ code, amount });
  return null;
}

/** 每月定期定額：以開盤價買進，股數無條件捨去（可以買零股）。 */
function runDca(s: SimState, m: Market): void {
  for (const p of s.dca) {
    const px = m.path(p.code, s.date)?.price[0];
    if (!px) {
      note(s, p.code, `定期定額 ${p.amount.toLocaleString()} 元：今天沒有成交，這個月略過`);
      continue;
    }
    let shares = Math.floor(p.amount / px);
    while (shares > 0 && shares * px + feeOf(shares * px, s.settings.discount, shares) > p.amount) shares--;
    if (shares <= 0) {
      note(s, p.code, `定期定額 ${p.amount.toLocaleString()} 元：金額不夠買 1 股（開盤價 ${px}）`);
      continue;
    }
    const err = placeOrder(s, m, { code: p.code, side: 'buy', kind: 'cash', shares });
    note(s, p.code, err ? `定期定額買進失敗：${err}` : `定期定額以開盤價 ${px} 買進 ${shares.toLocaleString()} 股`);
  }
}

/** 加入或移除自選股。 */
export function toggleFav(s: SimState, code: string): boolean {
  const had = s.fav.includes(code);
  s.fav = had ? s.fav.filter((c) => c !== code) : [...s.fav, code];
  return !had;
}

/** 每個月第一個交易日開盤前：薪資入帳、信貸扣款、質押扣息。 */
function monthStart(s: SimState): void {
  const salary = Math.round(s.settings.monthly ?? 0);
  if (salary > 0) {
    s.cash += salary;
    s.flows.push([s.date, salary]);
    note(s, '', `本月薪資投入 ${salary.toLocaleString()} 元`);
  }
  for (const l of [...s.loans]) {
    const interest = Math.round((l.balance * l.rate) / 12);
    const due = Math.min(l.payment, Math.round(l.balance) + interest);
    const paid = Math.max(0, Math.min(s.cash, due));
    s.cash -= paid;
    const penalty = paid < due ? Math.round((due - paid) * LOAN_PENALTY) : 0;
    l.balance = l.balance + interest - paid + penalty;
    l.left = Math.max(0, l.left - 1);
    if (penalty) note(s, '', `信貸月付 ${due.toLocaleString()} 元只繳了 ${Math.round(paid).toLocaleString()} 元，未繳部分加 ${LOAN_PENALTY * 100}% 違約金滾入本金`);
    else note(s, '', `信貸扣款 ${due.toLocaleString()} 元（利息 ${interest.toLocaleString()} 元），剩餘本金 ${Math.max(0, Math.round(l.balance)).toLocaleString()} 元`);
    if (l.balance < 1) {
      s.loans = s.loans.filter((x) => x !== l);
      note(s, '', '信用貸款已全部還清');
    } else l.payment = annuity(l.balance, l.rate, Math.max(1, l.left));
  }
  for (const p of s.pledges) {
    const due = Math.round(p.interest);
    if (!due) continue;
    const paid = Math.max(0, Math.min(s.cash, due));
    s.cash -= paid;
    p.interest -= paid;
    note(s, p.code, paid < due ? `質押利息 ${due.toLocaleString()} 元現金不足，只繳了 ${Math.round(paid).toLocaleString()} 元` : `質押利息扣款 ${due.toLocaleString()} 元`);
  }
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
  // 質押：計息、檢查維持率
  for (const p of s.pledges) if (p.loan > 0) p.interest += (p.loan * PLEDGE_RATE) / 250;
  const pr = pledgeRatio(s, m);
  if (pr != null && pr < PLEDGE_FORCE) {
    for (const pl of [...s.pledges]) {
      const pos = findPos(s, pl.code, 'cash', 'long');
      const shares = Math.min(pl.shares, pos?.shares ?? 0);
      const price = priceNow(s, m, pl.code) ?? 0;
      if (shares > 0) execute(s, m, { id: s.nextId++, code: pl.code, side: 'sell', kind: 'cash', shares }, price, true);
      s.cash -= pl.loan + pl.interest;
    }
    s.pledges = [];
    note(s, '', `質押維持率 ${Math.round(pr * 100)}% 低於 ${PLEDGE_FORCE * 100}%，質押股票已被強制賣出還款`);
  } else if (pr != null && pr < PLEDGE_CALL) {
    note(s, '', `質押維持率 ${Math.round(pr * 100)}% 低於 ${PLEDGE_CALL * 100}%，請還款或增加質押，再跌會被強制賣出`);
  }
  s.minute = SESSION_MINUTES;
  // 提醒只留最近 500 則（成交紀錄全部保留），存檔才不會越來越大
  if (s.notes.length > 600) s.notes = s.notes.slice(-500);
  checkRuin(s, m);
  const eq = Math.round(equityOf(s, m));
  s.equity.push([s.date, eq]);
  const today = s.trades.filter((t) => t.date === s.date);
  s.days.push({
    d: s.date,
    eq,
    real: Math.round(today.reduce((a, t) => a + (t.pnl ?? 0), 0)),
    float: Math.round(s.pos.reduce((a, p) => a + unrealizedOf(p, s, m).pnl, 0)),
    fee: today.reduce((a, t) => a + t.fee + t.tax, 0),
    flow: s.flows.filter(([d]) => d === s.date).reduce((a, [, v]) => a + v, 0),
    n: today.length,
  });
}

/** 破產門檻：總資產低於這個金額就破產（null = 不會破產）。 */
export function ruinLine(s: SimState): number | null {
  const loss = s.settings.ruinLoss ?? 1;
  if (!(loss > 0)) return null;
  return investedOf(s) * (1 - loss);
}

/**
 * 收盤檢查破產：總資產跌到門檻以下時，所有部位以收盤價強制了結、還清信貸與質押借款（還不完就是負資產），
 * 取消委託、停損停利與定期定額，這一局結束。
 */
function checkRuin(s: SimState, m: Market): void {
  const line = ruinLine(s);
  if (s.bankrupt || line == null) return;
  const before = equityOf(s, m);
  if (before > line) return;
  for (const p of [...s.pos]) {
    const price = priceNow(s, m, p.code) ?? p.cost / Math.max(1, p.shares);
    execute(s, m, { id: s.nextId++, code: p.code, side: p.dir === 'long' ? 'sell' : 'buy', kind: p.kind, shares: p.shares }, price, true);
  }
  s.pos = [];
  s.cash -= debtOf(s);
  s.loans = [];
  s.pledges = [];
  s.orders = [];
  s.stops = [];
  s.dca = [];
  const equity = Math.round(s.cash);
  s.bankrupt = { date: s.date, day: s.day, equity };
  const loss = s.settings.ruinLoss ?? 1;
  note(
    s,
    '',
    loss >= 1
      ? `💥 破產：總資產 ${Math.round(before).toLocaleString()} 元已經歸零，所有部位以收盤價強制了結並償還借款，這一局結束`
      : `💥 破產：虧損超過累計投入的 ${Math.round(loss * 100)}%（總資產 ${Math.round(before).toLocaleString()} 元），所有部位以收盤價強制了結並償還借款，這一局結束`,
  );
}

/** 套用一次分割／減資：持股與質押股數 ×k，停損停利價 ÷k；extra 指定時只把這麼多股（分割前買的）換算。 */
function applySplit(s: SimState, code: string, date: string, k: number, only?: number): void {
  const key = `${code}|${date}`;
  s.splitsDone = [...(s.splitsDone ?? []).filter((x) => x !== key), key];
  let touched = false;
  for (const p of s.pos.filter((x) => x.code === code && x.dir === 'long')) {
    const base = only == null ? p.shares : Math.min(p.shares, only);
    if (base <= 0) continue;
    p.shares = Math.max(1, p.shares + Math.round(base * (k - 1)));
    if (only != null) only -= base;
    touched = true;
  }
  for (const p of s.pos.filter((x) => x.code === code && x.dir === 'short' && only == null)) {
    p.shares = Math.max(1, Math.round(p.shares * k));
    touched = true;
  }
  for (const pl of s.pledges.filter((x) => x.code === code)) pl.shares = Math.round(pl.shares * k);
  for (const st of s.stops.filter((x) => x.code === code)) {
    if (st.loss != null) st.loss = Math.round((st.loss / k) * 100) / 100;
    if (st.profit != null) st.profit = Math.round((st.profit / k) * 100) / 100;
  }
  if (touched)
    note(
      s,
      code,
      k > 1 && Number.isInteger(k)
        ? `股票分割：一股拆成 ${k} 股，持股數量 ×${k}，總成本不變（均價變成 1/${k}）`
        : `${k < 1 ? '減資或反分割' : '面額變更'}：持股依價格換算為原本的 ${k.toFixed(4)} 倍，總成本不變`,
    );
}

/**
 * 補上舊存檔漏掉的分割（分割處理加上去之前已經過了分割日的局）。
 * 用成交紀錄判斷：分割前買的股數如果還沒乘上倍數，就補上；已經換算過的不會重複。回傳補了幾筆。
 */
export function repairSplits(s: SimState, m: Market): number {
  const done = new Set(s.splitsDone ?? []);
  let fixed = 0;
  for (const code of new Set(s.pos.filter((p) => p.dir === 'long').map((p) => p.code))) {
    for (const [date, k] of m.splitsOf(code)) {
      if (date > s.date || done.has(`${code}|${date}`)) continue;
      const net = (before: boolean) =>
        s.trades
          .filter((t) => t.code === code && (t.kind === 'cash' || t.kind === 'margin') && (t.date < date) === before)
          .reduce((a, t) => a + (t.side === 'buy' ? t.shares : -t.shares), 0);
      const pre = net(true);
      const post = net(false);
      const held = s.pos.filter((p) => p.code === code && p.dir === 'long').reduce((a, p) => a + p.shares, 0);
      // 分割前沒有持股，或是股數已經是換算後的樣子：不用補
      const missed = pre > 0 && Math.abs(held - (pre + post)) < Math.abs(held - (pre * k + post));
      if (missed) {
        applySplit(s, code, date, k, pre);
        fixed++;
      } else s.splitsDone = [...(s.splitsDone ?? []), `${code}|${date}`];
    }
  }
  return fixed;
}

/**
 * 進入下一個交易日：先處理除權息與月初資金。
 * preOpen = true 時停在盤前，等 openDay() 開盤；否則直接開盤（09:00）。
 */
export function beginDay(s: SimState, m: Market, date: string, preOpen = false): void {
  if (date <= s.date || s.bankrupt) return;
  const newMonth = date.slice(0, 7) !== s.date.slice(0, 7);
  s.date = date;
  s.minute = 0;
  s.day += 1;
  s.orders = [];
  // 股票分割、面額變更、減資：股數換算，總成本不變（均價跟著變），停損停利價跟著換算
  for (const [code, k] of m.splits(date)) applySplit(s, code, date, k);
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
  // 月初：薪資、信貸、質押利息（在除權息之後）；定期定額在開盤時買進
  if (newMonth) {
    monthStart(s);
    s.dcaDue = true;
  }
  s.pre = true;
  if (!preOpen) openDay(s, m);
}

/**
 * 開盤（09:00 集合競價）：定期定額、盤前委託以開盤價撮合，開盤前就觸發的停損／停利以開盤價成交。
 * 不在盤前時不做事。
 */
export function openDay(s: SimState, m: Market): void {
  if (!s.pre) return;
  s.pre = false;
  s.minute = 0;
  if (s.dcaDue) {
    s.dcaDue = false;
    runDca(s, m);
  }
  const pending = s.orders;
  s.orders = [];
  for (const o of pending) {
    const open = m.path(o.code, s.date)?.price[0];
    if (open == null) {
      note(s, o.code, '盤前委託未成交：這檔今天沒有交易');
      continue;
    }
    const hit = o.limit == null || (o.side === 'buy' ? open <= o.limit : open >= o.limit);
    if (!hit) {
      s.orders.push(o);
      continue;
    }
    const err = checkOrder(s, m, o) ?? execute(s, m, o, open);
    note(s, o.code, err ? `盤前委託未成交：${err}` : `盤前委託以開盤價 ${open} 成交`);
  }
  if (s.stops.length) checkStops(s, m, 0);
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
  // 回檔用扣掉薪資投入的報酬指數算（不然每次入帳都像是漲了一段）
  const flowOn = new Map<string, number>();
  for (const [d, v] of s.flows) flowOn.set(d, (flowOn.get(d) ?? 0) + v);
  let idx = 1;
  let prev = s.settings.capital;
  let peak = 1;
  let mdd = 0;
  for (const [d, v] of s.equity) {
    const base = prev + (flowOn.get(d) ?? 0);
    if (base > 0) idx *= v / base;
    prev = v;
    peak = Math.max(peak, idx);
    mdd = Math.max(mdd, 1 - idx / peak);
  }
  const closes = s.trades.filter((t) => t.pnl != null);
  return {
    equity,
    ret: equity / investedOf(s) - 1,
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
  // 分割／減資：從每檔的價格找出來（排除除權息那天）
  const exDays = new Map<string, Set<string>>();
  for (const r of ex) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);
  const splitsBy = new Map<string, Split[]>();
  const splitDay = new Map<string, Array<[string, number]>>();
  for (const [code, rows] of series) {
    const list = detectSplits(rows, exDays.get(code));
    splitsBy.set(code, list);
    for (const [d, k] of list) (splitDay.get(d) ?? splitDay.set(d, []).get(d)!).push([code, k]);
  }
  return {
    splits: (date) => splitDay.get(date) ?? [],
    splitsOf: (code) => splitsBy.get(code) ?? [],
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
      // 中間發生分割／減資時，昨收換算成新的基準（跟交易所的參考價一樣）
      let close = rows[lo].close;
      for (const [d, k] of splitsBy.get(code) ?? []) if (d > rows[lo].date && d <= date) close /= k;
      return close;
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

/**
 * 對照組：同樣的錢（本金＋每次投入）都在投入當天以前一天收盤買進加權指數，到 date 收盤值多少。
 * index(d) = 那天的加權指數收盤、prevDay(d) = 前一個交易日；資料不夠時 null。
 */
export function benchValue(
  s: SimState,
  index: (d: string) => number | undefined,
  prevDay: (d: string) => string | undefined,
  date: string,
): number | null {
  const buy = (d: string) => {
    const p = prevDay(d);
    return p ? index(p) : undefined;
  };
  const t0 = buy(s.settings.start);
  const t1 = index(date);
  if (!t0 || !t1) return null;
  let units = s.settings.capital / t0;
  for (const [d, v] of s.flows) {
    if (d > date) continue;
    const t = buy(d);
    if (!t) return null;
    units += v / t;
  }
  return units * t1;
}
