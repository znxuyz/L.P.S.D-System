/** 交易日流程：開盤前（除權息、分割、月初）、開盤、收盤結算、強制了結與破產。 */
import { SESSION_MINUTES } from '../intraday';
import { monthStart, runDca } from './bank';
import { MAINT_CALL, MAINT_FORCE, MARGIN_RATE, PLEDGE_CALL, PLEDGE_FORCE, PLEDGE_RATE } from './config';
import { checkOrder, checkStops, execute, tickTo } from './orders';
import { findPos, note } from './state';
import { type Market, type SimState } from './types';
import { debtOf, equityOf, investedOf, maintenance, pledgeRatio, priceNow, unrealizedOf } from './valuation';

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

/** 套用一次分割／減資：持股與質押股數 ×k，停損停利價 ÷k；only 指定時只換算這麼多股（舊存檔補換算時，只換算分割前買的）。 */
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
