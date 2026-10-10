/**
 * 型態歷史勝率（data/pattern-stats.json，由 scripts/pattern-stats.ts 回測全市場日 K 產生）。
 */

export interface StatRow {
  /** 樣本數。 */
  n: number;
  /** 勝率（0～1）：偏多型態 N 天後上漲、偏空型態 N 天後下跌的比例。 */
  win: number;
  /** 往型態方向的平均報酬（%）。 */
  avg: number;
}

export type Regime = 'bull' | 'bear';

/** 某種大盤行情下的勝率（加權指數在半年線之上／之下）。 */
export interface RegimeStats {
  /** 這種行情的交易日數。 */
  days: number;
  baseline: { up20: number | null; up5: number | null };
  patterns: Record<string, StatRow>;
  candles: Record<string, StatRow>;
}

export interface PatternStats {
  generatedAt: string;
  from: string;
  to: string;
  stocks: number;
  horizon: number;
  candleHorizon: number;
  /** 同樣取樣點隨機持有 N 天上漲的比例（基準）。 */
  baseline: { up20: number | null; up5: number | null };
  /** key：`型態 id|bull` 或 `型態 id|bear`。 */
  patterns: Record<string, StatRow>;
  /** key：`K 棒訊號名稱|bull/bear`。 */
  candles: Record<string, StatRow>;
  /** 依大盤行情分開算的勝率（舊的回測結果沒有）。 */
  regimes?: { rule: string; bull?: RegimeStats; bear?: RegimeStats };
}

let pending: Promise<PatternStats | null> | null = null;

export function loadPatternStats(url = 'data/pattern-stats.json'): Promise<PatternStats | null> {
  pending ??= fetch(url, { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<PatternStats>) : null))
    .then((j) => (j && typeof j.patterns === 'object' ? j : null))
    .catch(() => null);
  return pending;
}

/** 這個方向的基準勝率：偏多看隨機上漲比例，偏空看隨機下跌比例。 */
export function baselineFor(stats: PatternStats, bias: 'bull' | 'bear', candle = false): number | null {
  const up = candle ? stats.baseline.up5 : stats.baseline.up20;
  if (up == null) return null;
  return bias === 'bull' ? up : 1 - up;
}

/** 樣本太少時勝率不可靠。 */
export const MIN_SAMPLES = 30;

export const REGIME_MA = 120;
export const REGIME_NAME: Record<Regime, string> = { bull: '多頭行情', bear: '空頭行情' };

/** 目前的大盤行情：加權指數最新收盤在 120 日均線之上＝多頭（和回測用同一個規則）。 */
export function currentRegime(taiex: Map<string, number> | null | undefined): Regime | null {
  if (!taiex || taiex.size < REGIME_MA) return null;
  const closes = [...taiex.values()].slice(-REGIME_MA);
  const ma = closes.reduce((a, b) => a + b, 0) / REGIME_MA;
  return closes[closes.length - 1] >= ma ? 'bull' : 'bear';
}

/** 換成某種行情下的勝率（形狀和整體一樣，方便共用顯示）；沒有分組資料時回傳 null。 */
export function regimeView(stats: PatternStats, regime: Regime): PatternStats | null {
  const r = stats.regimes?.[regime];
  return r ? { ...stats, baseline: r.baseline, patterns: r.patterns, candles: r.candles } : null;
}
