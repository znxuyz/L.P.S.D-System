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
}

export interface PredictData {
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
