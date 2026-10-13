/** 資金：信用貸款、股票質押、定期定額、月初薪資與扣款。 */
import { LOAN_LIMIT, LOAN_PENALTY, LOAN_RATE, LOAN_TERMS, PLEDGE_LTV, feeOf } from './config';
import { placeOrder } from './orders';
import { findPos, note } from './state';
import { type Market, type SimState } from './types';
import { pendingShares, priceNow } from './valuation';

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
export function runDca(s: SimState, m: Market): void {
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

/** 每個月第一個交易日開盤前：薪資入帳、信貸扣款、質押扣息。 */
export function monthStart(s: SimState): void {
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
