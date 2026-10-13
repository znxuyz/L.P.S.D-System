/**
 * 拉普拉斯模擬盤引擎（對外的入口；實作分在同一個資料夾的各個檔案）：用歷史日 K 加上「偽即時」盤中走勢，以模擬帳戶練習交易。
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

export { LOT, FEE_RATE, MARGIN_LOAN, MARGIN_RATE, SHORT_DEPOSIT, SHORT_FEE, MAINT_CALL, MAINT_FORCE, SALARY, LOAN_LIMIT, LOAN_RATE, LOAN_TERMS, LOAN_PENALTY, PLEDGE_LTV, PLEDGE_RATE, PLEDGE_CALL, PLEDGE_FORCE, KIND_NAME, isEtf, feeOf, taxOf, lockedLimit } from './config';
export type { Side, Kind, SimOrder, Position, Trade, SimNote, SimSettings, Bankrupt, StopOrder, DcaPlan, Loan, Pledge, DayRec, SimState, ExRight, Market, SimSummary } from './types';
export { newSim, migrate, toggleFav } from './state';
export { priceNow, equityOf, debtOf, investedOf, unrealizedOf, maintenance, reservedCash, pledgedShares, pledgeRatio } from './valuation';
export { checkOrder, placeOrder, cancelOrder, tickTo, setStop, stopOf } from './orders';
export { annuity, takeLoan, repayLoan, pledgeBorrow, pledgeRepay, pledgeRelease, setDca } from './bank';
export { closeDay, ruinLine, repairSplits, beginDay, openDay } from './session';
export { buildMarket } from './market';
export { summarize, benchValue } from './summary';
