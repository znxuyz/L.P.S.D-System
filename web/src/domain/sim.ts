/**
 * 拉普拉斯模擬盤：用歷史日 K 回放、以模擬帳戶練習交易。
 *
 * 規則（盡量貼近台股實際，但都是日 K 層級的近似）：
 * - 每天收盤後下單，下一個交易日成交：市價單用開盤價；限價單在當天最低（買）／最高（賣）碰到限價時成交，
 *   成交價取開盤價與限價中對自己較不利的一個（開盤就優於限價時用開盤價）。當天沒碰到就取消（當日有效）。
 * - 手續費 0.1425% × 折扣，整股最低 20 元、零股最低 1 元；賣出證交稅 0.3%（ETF 0.1%）。
 * - 一價到底的漲停買不到、跌停賣不掉；當天沒有成交資料（暫停交易）時委託取消。
 * - 除權息：除息日把現金股利（每股權值＋息值）直接記入現金；除權依除權前收盤與參考價換算配股
 *   （權息合併的只能用總價值換算成股數，屬近似）。
 * - 每天收盤後以收盤價計算總資產。
 */
import type { Candle } from './technicals';

export const LOT = 1000;
export const FEE_RATE = 0.001425;

export type Side = 'buy' | 'sell';

export interface SimOrder {
  id: number;
  code: string;
  side: Side;
  shares: number;
  /** 沒有 = 市價單（隔天開盤價）。 */
  limit?: number;
}

export interface Holding {
  shares: number;
  /** 持有成本（含買進手續費），配股不增加成本。 */
  cost: number;
}

export interface Trade {
  date: string;
  code: string;
  side: Side;
  shares: number;
  price: number;
  fee: number;
  tax: number;
  /** 賣出才有：這筆實現損益（扣掉手續費、稅）。 */
  pnl?: number;
}

export interface SimNote {
  date: string;
  code: string;
  text: string;
}

export interface SimSettings {
  start: string;
  capital: number;
  /** 手續費折扣（0.28 = 2.8 折）。 */
  discount: number;
}

export interface SimState {
  v: 1;
  settings: SimSettings;
  /** 目前所在的交易日（這一天已收盤）。 */
  date: string;
  cash: number;
  holdings: Record<string, Holding>;
  orders: SimOrder[];
  trades: Trade[];
  notes: SimNote[];
  /** [日期, 總資產] */
  equity: Array<[string, number]>;
  nextId: number;
  /** 最後一次看的股票。 */
  watch: string;
}

/** 除權息：[日期, 代號, 除權息前收盤, 參考價, 權值+息值, 權/息] */
export type ExRight = [string, string, number, number, number, string];

export interface Market {
  /** 某檔某天的日 K；沒有 = 那天沒有成交（或還沒下載）。 */
  bar(code: string, date: string): Candle | undefined;
  /** 某檔在 date 之前（含）最後一根日 K 的收盤。 */
  lastClose(code: string, date: string): number | undefined;
  /** 某天除權息的股票。 */
  exRights(date: string): ExRight[];
}

export const isEtf = (code: string) => code.startsWith('00');

export function feeOf(amount: number, discount: number, shares: number): number {
  const min = shares % LOT === 0 ? 20 : 1;
  return Math.max(min, Math.floor(amount * FEE_RATE * discount));
}

export function taxOf(amount: number, code: string): number {
  return Math.floor(amount * (isEtf(code) ? 0.001 : 0.003));
}

/** 一價到底（開高低收都一樣）且漲跌超過 9%：1 = 漲停鎖死、-1 = 跌停鎖死、0 = 不是。 */
export function lockedLimit(bar: Candle, prevClose: number | undefined): -1 | 0 | 1 {
  if (!prevClose || bar.open !== bar.high || bar.high !== bar.low || bar.low !== bar.close) return 0;
  const r = bar.close / prevClose - 1;
  return r >= 0.09 ? 1 : r <= -0.09 ? -1 : 0;
}

export function newSim(settings: SimSettings, date: string, watch = '2330'): SimState {
  return {
    v: 1,
    settings,
    date,
    cash: settings.capital,
    holdings: {},
    orders: [],
    trades: [],
    notes: [],
    equity: [[date, settings.capital]],
    nextId: 1,
    watch,
  };
}

export function marketValue(s: SimState, m: Market, date = s.date): number {
  let v = 0;
  for (const [code, h] of Object.entries(s.holdings)) v += h.shares * (m.lastClose(code, date) ?? h.cost / Math.max(1, h.shares));
  return v;
}

export function equityOf(s: SimState, m: Market, date = s.date): number {
  return s.cash + marketValue(s, m, date);
}

/** 買進委託要先保留的現金（市價單用最近收盤 ×1.1 估）。 */
export function reservedCash(s: SimState, m: Market): number {
  let r = 0;
  for (const o of s.orders) {
    if (o.side !== 'buy') continue;
    const px = o.limit ?? (m.lastClose(o.code, s.date) ?? 0) * 1.1;
    const amt = px * o.shares;
    r += amt + feeOf(amt, s.settings.discount, o.shares);
  }
  return r;
}

/** 已委託賣出的股數。 */
export function pendingSell(s: SimState, code: string): number {
  return s.orders.filter((o) => o.side === 'sell' && o.code === code).reduce((a, o) => a + o.shares, 0);
}

/** 下單前檢查；回傳錯誤訊息或 null。 */
export function checkOrder(s: SimState, m: Market, o: Omit<SimOrder, 'id'>): string | null {
  if (!Number.isInteger(o.shares) || o.shares <= 0) return '股數要是正整數';
  if (o.limit !== undefined && !(o.limit > 0)) return '限價要大於 0';
  const ref = m.lastClose(o.code, s.date);
  if (ref === undefined) return '這檔股票在這一天以前沒有成交資料';
  if (o.side === 'sell') {
    const have = s.holdings[o.code]?.shares ?? 0;
    if (o.shares > have - pendingSell(s, o.code)) return `可賣股數不足（持有 ${have} 股，已委託賣出 ${pendingSell(s, o.code)} 股）`;
    return null;
  }
  const px = o.limit ?? ref * 1.1;
  const need = px * o.shares + feeOf(px * o.shares, s.settings.discount, o.shares);
  if (need > s.cash - reservedCash(s, m)) return `可用現金不足（約需 ${Math.round(need).toLocaleString()} 元）`;
  return null;
}

export function placeOrder(s: SimState, m: Market, o: Omit<SimOrder, 'id'>): string | null {
  const err = checkOrder(s, m, o);
  if (err) return err;
  s.orders.push({ ...o, id: s.nextId++ });
  return null;
}

export function cancelOrder(s: SimState, id: number): void {
  s.orders = s.orders.filter((o) => o.id !== id);
}

function applyExRights(s: SimState, m: Market, date: string): void {
  for (const [, code, prev, ref, value, kind] of m.exRights(date)) {
    const h = s.holdings[code];
    if (!h || !(value > 0)) continue;
    const stock = kind.includes('權');
    const cashOnly = !stock;
    if (cashOnly) {
      const cash = Math.round(h.shares * value);
      s.cash += cash;
      s.notes.push({ date, code, text: `除息：每股 ${value.toFixed(2)} 元，入帳 ${cash.toLocaleString()} 元` });
      continue;
    }
    if (!(ref > 0)) continue;
    // 純除權：配股率 = 除權前收盤 ÷ 參考價 − 1；權息合併：用總價值換算成股數（近似）
    const extra = Math.floor(kind.includes('息') ? (h.shares * value) / ref : h.shares * (prev / ref - 1));
    if (extra <= 0) continue;
    h.shares += extra;
    s.notes.push({ date, code, text: `除權${kind.includes('息') ? '息' : ''}：配 ${extra.toLocaleString()} 股（依參考價換算）` });
  }
}

function fill(s: SimState, m: Market, o: SimOrder, date: string): void {
  const bar = m.bar(o.code, date);
  const cancel = (why: string): void => {
    s.notes.push({ date, code: o.code, text: `${o.side === 'buy' ? '買' : '賣'} ${o.shares.toLocaleString()} 股未成交：${why}` });
  };
  if (!bar) return cancel('當天沒有成交資料');
  const lock = lockedLimit(bar, m.lastClose(o.code, prevDay(date)));
  if (o.side === 'buy' && lock === 1) return cancel('一價漲停，買不到');
  if (o.side === 'sell' && lock === -1) return cancel('一價跌停，賣不掉');
  let price = bar.open;
  if (o.limit !== undefined) {
    if (o.side === 'buy') {
      if (bar.low > o.limit) return cancel(`最低價 ${bar.low} 沒碰到限價 ${o.limit}`);
      price = Math.min(bar.open, o.limit);
    } else {
      if (bar.high < o.limit) return cancel(`最高價 ${bar.high} 沒碰到限價 ${o.limit}`);
      price = Math.max(bar.open, o.limit);
    }
  }
  const amount = price * o.shares;
  const fee = feeOf(amount, s.settings.discount, o.shares);
  if (o.side === 'buy') {
    if (amount + fee > s.cash) return cancel('現金不足（開盤跳空）');
    s.cash -= amount + fee;
    const h = (s.holdings[o.code] ??= { shares: 0, cost: 0 });
    h.shares += o.shares;
    h.cost += amount + fee;
    s.trades.push({ date, code: o.code, side: 'buy', shares: o.shares, price, fee, tax: 0 });
    return;
  }
  const h = s.holdings[o.code];
  if (!h || h.shares < o.shares) return cancel('持股不足');
  const tax = taxOf(amount, o.code);
  const costPart = (h.cost * o.shares) / h.shares;
  const pnl = amount - fee - tax - costPart;
  s.cash += amount - fee - tax;
  h.shares -= o.shares;
  h.cost -= costPart;
  if (h.shares === 0) delete s.holdings[o.code];
  s.trades.push({ date, code: o.code, side: 'sell', shares: o.shares, price, fee, tax, pnl: Math.round(pnl) });
}

/** 前一個日曆日（lastClose 會往前找到最近一根）。 */
function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 前進到下一個交易日 next：先除權息、再撮合昨天收盤後的委託，最後以收盤價結算總資產。 */
export function advance(s: SimState, m: Market, next: string): void {
  if (next <= s.date) return;
  applyExRights(s, m, next);
  const orders = s.orders;
  s.orders = [];
  // 先賣後買：賣出的錢當天就能用來買（實際是 T+2 交割，這裡簡化）
  for (const o of orders.filter((o) => o.side === 'sell')) fill(s, m, o, next);
  for (const o of orders.filter((o) => o.side === 'buy')) fill(s, m, o, next);
  s.date = next;
  s.equity.push([next, Math.round(equityOf(s, m, next))]);
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
  let peak = -Infinity;
  let mdd = 0;
  for (const [, v] of s.equity) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, peak > 0 ? 1 - v / peak : 0);
  }
  const sells = s.trades.filter((t) => t.side === 'sell');
  return {
    equity,
    ret: equity / s.settings.capital - 1,
    maxDrawdown: mdd,
    realized: sells.reduce((a, t) => a + (t.pnl ?? 0), 0),
    wins: sells.filter((t) => (t.pnl ?? 0) > 0).length,
    losses: sells.filter((t) => (t.pnl ?? 0) <= 0).length,
    fees: s.trades.reduce((a, t) => a + t.fee + t.tax, 0),
    days: s.equity.length - 1,
  };
}

/** 由日 K 陣列建立查詢用的 Market（測試與網頁共用）。 */
export function buildMarket(series: Map<string, Candle[]>, ex: ExRight[] = []): Market {
  const idx = new Map<string, Map<string, Candle>>();
  for (const [code, rows] of series) idx.set(code, new Map(rows.map((c) => [c.date, c])));
  const exBy = new Map<string, ExRight[]>();
  for (const r of ex) (exBy.get(r[0]) ?? exBy.set(r[0], []).get(r[0])!).push(r);
  return {
    bar: (code, date) => idx.get(code)?.get(date),
    lastClose(code, date) {
      const rows = series.get(code);
      if (!rows?.length) return undefined;
      // 二分搜尋：最後一根日期 <= date
      let lo = 0;
      let hi = rows.length - 1;
      if (rows[0].date > date) return undefined;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rows[mid].date <= date) lo = mid;
        else hi = mid - 1;
      }
      return rows[lo].close;
    },
    exRights: (date) => exBy.get(date) ?? [],
  };
}
