/**
 * L.P.L.C. 預測（scripts/predict.ts 部署時產生的 data/predict.json）。
 * 三個模型都是逐段往前滾訓練（只用當時看得到的資料），回測成績是樣本外的。
 */
import { decodeAnalogs, type AnalogDay } from '../domain/intradayModel';
import type { IntradayData } from '../ui/predictIntraday';
import { keyedRefresh } from './refresh';

export type Verdict = 'signal' | 'none';

export interface StockPick {
  code: string;
  name: string;
  /** 0～100，越高越看好（全市場排名百分位）。 */
  score: number;
  close: number | null;
  /** [白話原因, 貢獻] */
  reasons: Array<[string, number]>;
  /** 進出場價位（最看好的股票才有）：entry／target／stop 為 null 代表「隔天開盤買」／不設停利／不設停損；refStop 是參考停損。 */
  levels?: { atr: number; entry: number | null; target: number | null; stop: number | null; refStop: number } | null;
}

/** 進出場方式的回測統計。 */
export interface EeStat {
  signals: number;
  fill: number;
  perSignal: number;
  perTrade: number;
  win: number;
  days: number;
  worst: number;
  p10: number;
  target: number;
  stop: number;
}

/** 營收選股（第一手資料，正式選股模型）。 */
export interface RevStocks {
  asOf: string;
  tradeDate: string;
  rebalanceTomorrow: boolean;
  nextRebalance: string;
  trendOk: boolean;
  universe: number;
  n: number;
  revMonth: string | null;
  /** 全部股票的分數（0～100）。 */
  all?: Record<string, number>;
  calib?: import('../domain/stockForecast').StockCalib;
  top: Array<{ code: string; name: string; close: number | null; score: number; vals: Record<string, number | null> }>;
  backtest: { from: string | null; to: string; periods: number; total: number | null; market: number | null; win: number | null; years: Array<{ year: string; ret: number | null; market: number | null }>; curve: Array<[string, number, number]> };
}
export interface PredictData {
  revStocks?: RevStocks;
  generatedAt: string;
  horizon: number;
  market: {
    asOf: string;
    probUp: number;
    expReturn: number;
    verdict: Verdict;
    drivers: Array<{ name: string; value: number | null; z: number | null; contrib: number | null }>;
    backtest: {
      from: string;
      days: number;
      accuracy: number;
      baseRate: number;
      brier: number;
      brierBase: number;
      /** [日期, 依模型進出的淨值, 一直持有的淨值] */
      curve: Array<[string, number, number]>;
      /** [日期, 上漲機率, 實際 20 日報酬（還沒揭曉是 null）] */
      history: Array<[string, number, number | null]>;
    };
  };
  stocks: {
    asOf: string;
    universe: number;
    verdict: Verdict;
    top: StockPick[];
    bottom: StockPick[];
    all: Record<string, number>;
    weights: Array<{ id: string; name: string; w: number }>;
    /** 進場、出場：目前的方式與回測（逐段往前滾挑方式）。 */
    entryExit?: {
      plan: { a: number; b: number | null; c: number | null; name: string };
      backtest: { periods: number; strategy: EeStat; baseline: EeStat; reference: Array<EeStat & { name: string }>; picked: Array<[string, string]> };
    };
    backtest: {
      from: string;
      to: string;
      periods: number;
      icMean: number;
      icPositive: number;
      icT: number;
      hitRate: number;
      cagrTop: number;
      cagrMarket: number;
      avgExcess: number;
      maxDD: number;
      cost: number;
      /** [日期, 前 10% 淨值, 全部平均, 大盤] */
      curve: Array<[string, number, number, number]>;
    };
  };
  dayTrade: {
    code: string;
    name: string;
    lastDate: string;
    lastClose: number;
    cost: number;
    verdict: Verdict;
    rule: { a: number; b: number; gapMean: number; gapSd: number };
    drivers: Array<{ name: string; value: number | null; contrib: number | null; w: number }>;
    backtest: {
      from: string;
      days: number;
      trades: number;
      winRate: number;
      avgNet: number;
      total: number;
      maxDD: number;
      alwaysLong: number;
      longs: number;
      shorts: number;
      curve: Array<[string, number, number]>;
      /** [日期, 跳空, 預測, 實際, 動作 1 做多／-1 做空／0 觀望, 淨損益] */
      recent: Array<[string, number, number, number, number, number]>;
    };
  } | null;
  /** 事前存檔的實盤成績（每天收盤後存的預測 vs 之後的實際）。 */
  forward?: {
    stocks: { n: number; icMean: number | null; topExcess: number | null; bottomExcess: number | null; rows: Array<{ asOf: string; ic: number; top: number; bottom: number; all: number; market: number }> };
    market: { n: number; hit: number; rows: Array<{ asOf: string; probUp: number; actual: number }> };
    dayTrade: { n: number; trades: number; total: number | null; rows: Array<{ asOf: string; date: string; gap: number; pred: number; action: number; actual: number; pnl: number }> };
  };
}

const get = keyedRefresh<PredictData | null>(
  () =>
    fetch('data/predict.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<PredictData>) : null))
      .then((j) => (j && j.stocks && j.market ? j : null))
      .catch(() => null),
  (j) => j != null,
);
export const loadPredict = (): Promise<PredictData | null> => get('');

const getIntra = keyedRefresh<IntradayData | null>(
  () =>
    fetch('data/predict-intraday.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<IntradayData>) : null))
      .catch(() => null),
  (j) => j != null,
);
/** 00631L 5 分 K 走勢預測（scripts/predict-intraday.ts）。 */
export const loadPredictIntraday = (): Promise<IntradayData | null> => getIntra('');

/** 00631L 當沖：輸入開盤價，算出預測的「開盤到收盤」報酬與建議動作。 */
export function dayTradeCall(d: NonNullable<PredictData['dayTrade']>, open: number): { gap: number; pred: number; action: 1 | -1 | 0 } {
  const gap = open / d.lastClose - 1;
  const { a, b, gapMean, gapSd } = d.rule;
  const z = Math.max(-4, Math.min(4, (gap - gapMean) / (gapSd || 1)));
  const pred = a + b * z;
  return { gap, pred, action: pred > d.cost ? 1 : pred < -d.cost ? -1 : 0 };
}

/** 開盤價落在哪個區間會做多／做空（b = 0 時沒有門檻）。 */
export function dayTradeBands(d: NonNullable<PredictData['dayTrade']>): { long: string | null; short: string | null } {
  const { a, b, gapMean, gapSd } = d.rule;
  if (!b) return { long: a > d.cost ? 'any' : null, short: a < -d.cost ? 'any' : null };
  const price = (target: number) => {
    const z = (target - a) / b;
    if (Math.abs(z) > 4) return null;
    return d.lastClose * (1 + gapMean + z * gapSd);
  };
  const pl = price(d.cost);
  const ps = price(-d.cost);
  const f = (p: number | null, dir: '≥' | '≤') => (p == null ? null : `${dir} ${p.toFixed(2)}`);
  // b > 0：開越高越偏多；b < 0：開越低越偏多
  return b > 0 ? { long: f(pl, '≥'), short: f(ps, '≤') } : { long: f(pl, '≤'), short: f(ps, '≥') };
}

const getAnalogs = keyedRefresh<AnalogDay[] | null>(
  () =>
    fetch('data/predict-analogs.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j) ? decodeAnalogs(j) : null))
      .catch(() => null),
  (j) => j != null,
);
/** 相似日資料庫（歷史上每天的 5 分 K 走勢）。 */
export const loadAnalogs = (): Promise<AnalogDay[] | null> => getAnalogs('');

/** 模型模擬帳戶（scripts/paper-trade.ts）：完全照事前存檔的預測自動下單。 */
export interface PaperData {
  capital: number;
  weights: { trend: number; stocks: number; dayTrade: number };
  firstArchive: string | null;
  start: string | null;
  asOf: string | null;
  days: number;
  equity: number;
  ret: number;
  books: { trend: number; stocks: number; dayTrade: number };
  benchmark: number;
  maxDD?: number | null;
  /** [月份, 帳戶, 大盤] */
  monthly?: Array<[string, number | null, number | null]>;
  /** [日期, 總值, 個股, 開盤當沖, 趨勢, 同額買大盤] */
  curve: Array<[string, number, number, number, number, number]>;
  positions: Array<{ code: string; name: string; shares: number; cost: number; price: number | null; ret: number | null }>;
  heldSince: string | null;
  trend?: { holding: boolean; since: string | null; nextHold: boolean; close: number; ma: number; dist: number; asOf: string };
  trades: Array<{ date: string; book: 'stocks' | 'dayTrade' | 'trend' | 'range'; code: string; name: string; side: string; price: number | null; pnl: number | null; note: string }>;
  tradeCount: number;
}
const getPaper = keyedRefresh<PaperData | null>(
  (f) =>
    fetch(`data/${f}`, { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<PaperData>) : null))
      .catch(() => null),
  (j) => j != null,
);
export const loadPaper = (): Promise<PaperData | null> => getPaper('paper.json');
export const loadPaperBacktest = (): Promise<PaperData | null> => getPaper('paper-backtest.json');
