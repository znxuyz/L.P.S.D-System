/** 下單、撮合、盤中推進與停損停利。 */
import { SESSION_MINUTES } from '../intraday';
import { KIND_NAME, MARGIN_LOAN, SHORT_DEPOSIT, SHORT_FEE, feeOf, isEtf, lockedLimit, taxOf } from './config';
import { dropEmpty, findPos, note } from './state';
import { type Kind, type Market, type Position, type Side, type SimOrder, type SimState, type StopOrder } from './types';
import { pendingShares, pledgedShares, priceNow, reservedCash } from './valuation';

/** 當沖單會做什麼：有反向的當沖部位就沖銷，否則建立新部位。 */
function dayAction(s: SimState, code: string, side: Side): 'open' | 'close' {
  return findPos(s, code, 'day', side === 'buy' ? 'short' : 'long') ? 'close' : 'open';
}

/** 這筆委託成交需要多少現金（賣出了結部位不需要）。 */
export function cashNeed(s: SimState, _m: Market, o: Omit<SimOrder, 'id'>, price: number): number {
  const amt = price * o.shares;
  const fee = feeOf(amt, s.settings.discount, o.shares);
  if (o.kind === 'cash') return o.side === 'buy' ? amt + fee : 0;
  if (o.kind === 'margin') return o.side === 'buy' ? amt * (1 - MARGIN_LOAN) + fee : 0;
  if (o.kind === 'short') return o.side === 'sell' ? amt * SHORT_DEPOSIT : amt + fee;
  // 當沖：建立部位時要有足夠現金（先賣後買也要有等額的額度）
  return dayAction(s, o.code, o.side) === 'open' ? amt + fee : o.side === 'buy' ? amt + fee : 0;
}

/** 下單前檢查；回傳錯誤訊息或 null。 */
export function checkOrder(s: SimState, m: Market, o: Omit<SimOrder, 'id'>): string | null {
  if (s.bankrupt) return '已經破產，這一局結束了';
  if (s.minute >= SESSION_MINUTES) return '已經收盤，請等下一個交易日開盤';
  if (!Number.isInteger(o.shares) || o.shares <= 0) return '股數要是正整數';
  if (o.limit !== undefined && !(o.limit > 0)) return '限價要大於 0';
  const bar = m.bar(o.code, s.date);
  if (!bar) return '這檔股票今天沒有交易（可能暫停交易或還沒上市）';
  // 限價要在今天的漲跌停範圍內（昨收 ±10%），超出的委託交易所不收
  const pc = m.prevClose(o.code, s.date);
  if (o.limit !== undefined && pc) {
    const lo = Math.ceil(pc * 0.9 * 100) / 100;
    const hi = Math.floor(pc * 1.1 * 100) / 100;
    if (o.limit < lo - 1e-9 || o.limit > hi + 1e-9) return `限價超出今天的漲跌停範圍（${lo}～${hi}）`;
  }
  // 盤前還不知道會不會鎖漲跌停，開盤撮合時才判斷
  const lock = s.pre ? 0 : lockedLimit(bar, pc);
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

/** 成交一筆委託；失敗時回傳原因。 */
export function execute(s: SimState, m: Market, o: SimOrder, price: number, force = false): string | null {
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
export function checkStops(s: SimState, m: Market, t: number): void {
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
