/** 模擬盤的資料結構：帳戶狀態、部位、委託、成交、資金往來、行情介面。 */
import { type IntradayPath } from '../intraday';
import { type Split } from '../splits';
import { type Candle } from '../technicals';

export type Side = 'buy' | 'sell';

export type Kind = 'cash' | 'day' | 'margin' | 'short';

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
