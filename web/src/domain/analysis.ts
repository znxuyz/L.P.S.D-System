import type { Fundamentals, Universe } from '../data/types';
import type { MarketMetrics, StockMetrics } from './metrics';
import { STRATEGIES, stockView, type Check, type Strategy, type StockView } from './screens';
import type { Signal, TechReport, Tilt } from './technicals';

/**
 * 個股分析：把五大選股、技術指標、資金流、籌碼與同業比較整理成評分與文字摘要。
 * 摘要是依規則把指標翻成文字，不是投資建議。
 */

export interface StrategyScore {
  strategy: Strategy;
  checks: Check[];
  passed: number;
  /** 0–1：符合條件的比例（「任一成立」的策略只要一項成立就是 1）。 */
  score: number;
  matched: boolean;
}

export function strategyScores(view: StockView): StrategyScore[] {
  return STRATEGIES.map((strategy) => {
    const checks = strategy.criteria.map((c) => c.test(view));
    const passed = checks.filter((c) => c.pass).length;
    const score = strategy.match === 'any' ? (passed > 0 ? 1 : 0) : passed / checks.length;
    return { strategy, checks, passed, score, matched: score === 1 };
  });
}

export interface PeerStat {
  label: string;
  /** 給新手的一句說明：這個數字怎麼看。 */
  hint: string;
  value: number;
  median: number;
  /** 在同業中的排名（1 = 最好）。 */
  rank: number;
  count: number;
  /** 越大越好還是越小越好。 */
  better: 'high' | 'low';
  format: (v: number) => string;
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 和同產業比較本益比、殖利率、EPS 成長、今日漲跌、資金流。 */
export function peerStats(stock: StockMetrics, metrics: MarketMetrics, fundamentals: Map<string, Fundamentals>): PeerStat[] {
  const peers = metrics.industryById.get(stock.industryId)?.stocks ?? [stock];
  const views = peers.flatMap((p) => {
    const f = fundamentals.get(p.code);
    return f ? [stockView(p, f)] : [];
  });
  const self = views.find((v) => v.stock.code === stock.code);
  const out: PeerStat[] = [];
  const add = (label: string, hint: string, pick: (v: StockView) => number, better: 'high' | 'low', format: (v: number) => string) => {
    if (!self) return;
    const vals = views.map(pick).filter(Number.isFinite);
    const value = pick(self);
    if (!Number.isFinite(value) || vals.length === 0) return;
    const sorted = [...vals].sort((a, b) => (better === 'high' ? b - a : a - b));
    out.push({ label, hint, value, median: median(vals), rank: sorted.indexOf(value) + 1, count: vals.length, better, format });
  };
  add('本益比', '越低代表股價越便宜', (v) => (v.pe > 0 ? v.pe : NaN), 'low', (v) => `${v.toFixed(1)} 倍`);
  add('殖利率', '越高代表配息越多', (v) => v.yieldPct, 'high', (v) => `${v.toFixed(2)}%`);
  add('EPS 年增', '越高代表獲利成長越快', (v) => v.f.epsYoY, 'high', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
  add('今日漲跌', '今天的股價表現', (v) => v.stock.changePct, 'high', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  add('今日資金流', '正數代表今天資金流入', (v) => v.stock.flow, 'high', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} 億`);
  return out;
}

/** 單一指標在同業中的星等：第 1 名 5 顆星，最後一名 1 顆星。 */
export function peerStars(p: PeerStat): number {
  if (p.count <= 1) return 3;
  const pct = (p.count - p.rank) / (p.count - 1);
  return 1 + Math.round(pct * 4);
}

export interface PeerRating {
  /** 1–5，以 0.5 為單位。 */
  stars: number;
  label: string;
  note: string;
}

/**
 * 同業推薦度：各指標星等的平均（評價、配息、成長的權重較高，今天的漲跌與資金流較低）。
 * 只是「和同產業相比的相對位置」，不是買賣建議。
 */
export function peerRating(peers: PeerStat[]): PeerRating | null {
  if (!peers.length) return null;
  const weight = (p: PeerStat) => (p.label.startsWith('今日') ? 0.5 : 1);
  const total = peers.reduce((s, p) => s + peerStars(p) * weight(p), 0);
  const w = peers.reduce((s, p) => s + weight(p), 0);
  const stars = Math.round((total / w) * 2) / 2;
  const good = peers.filter((p) => peerStars(p) >= 4).map((p) => p.label);
  const weak = peers.filter((p) => peerStars(p) <= 2).map((p) => p.label);
  const label = stars >= 4 ? '同業中的優等生' : stars >= 3 ? '同業中段班' : '落後多數同業';
  const parts = [];
  if (good.length) parts.push(`${good.join('、')}優於多數同業`);
  if (weak.length) parts.push(`${weak.join('、')}落後`);
  return { stars, label, note: parts.join('；') || '各項都和同業差不多' };
}

export interface Summary {
  /** −100（極度偏空）～ +100（極度偏多）。 */
  score: number;
  tilt: Tilt;
  label: string;
  points: Array<{ tilt: Tilt; text: string }>;
}

function tiltOf(score: number): Tilt {
  return score >= 15 ? 'bull' : score <= -15 ? 'bear' : 'neutral';
}

export function buildSummary(
  view: StockView,
  scores: StrategyScore[],
  tech: TechReport | null,
  metrics: MarketMetrics,
  universe: Universe,
): Summary {
  const s = view.stock;
  const f = view.f;
  const points: Summary['points'] = [];
  let total = 0;
  let weight = 0;
  const add = (tilt: Tilt, text: string, w = 1) => {
    points.push({ tilt, text });
    total += (tilt === 'bull' ? 1 : tilt === 'bear' ? -1 : 0) * w;
    weight += w;
  };

  // 技術面
  if (tech) {
    const get = (id: Signal['id']) => tech.signals.find((x) => x.id === id)!;
    const ma = get('ma');
    const mom = [get('rsi'), get('macd'), get('kd')];
    const bulls = mom.filter((x) => x.tilt === 'bull').length;
    add(ma.tilt, `趨勢：${ma.value}`, 2);
    add(bulls >= 2 ? 'bull' : bulls === 0 ? 'bear' : 'neutral', `動能：RSI ${get('rsi').value}、MACD ${get('macd').value}、KD ${get('kd').note}`, 1.5);
    const level = get('level');
    if (level.tilt !== 'neutral') add(level.tilt, `價位：${level.note}`);
  }

  // 資金面
  const ind = metrics.industryById.get(s.industryId);
  const rank = ind ? [...ind.stocks].sort((a, b) => b.flow - a.flow).findIndex((x) => x.code === s.code) + 1 : 0;
  const ratio = s.baseShare > 0 ? s.share / s.baseShare : 1;
  add(
    s.flow > 0 ? 'bull' : s.flow < 0 ? 'bear' : 'neutral',
    `資金：今日成交是常態的 ${ratio.toFixed(2)} 倍，資金${s.flow >= 0 ? '流入' : '流出'} ${Math.abs(s.flow).toFixed(1)} 億${ind ? `（${ind.name}第 ${rank} / ${ind.stocks.length} 名）` : ''}`,
    1.5,
  );

  // 籌碼
  const inst = f.instBuyDays >= 3 ? 'bull' : f.instBuyDays <= -3 ? 'bear' : 'neutral';
  add(inst, `籌碼：法人${f.instBuyDays >= 0 ? `連買 ${f.instBuyDays}` : `連賣 ${-f.instBuyDays}`} 天，千張大戶 ${f.bigHolderChg >= 0 ? '+' : '−'}${Math.abs(f.bigHolderChg).toFixed(1)} 百分點`);

  // 基本面
  const pe = Number.isFinite(view.pe) && view.pe > 0 ? `${view.pe.toFixed(1)} 倍` : '虧損';
  const growth = f.epsYoY > 20 ? 'bull' : f.epsYoY < -10 ? 'bear' : 'neutral';
  const peNote = view.pePct !== null && pe !== '虧損' ? `（自身 5 年 ${Math.round(view.pePct * 100)}% 分位，${view.pePct <= 0.3 ? '偏便宜' : view.pePct >= 0.7 ? '偏貴' : '合理'}）` : '';
  add(growth, `基本面：本益比 ${pe}${peNote}、殖利率 ${view.yieldPct.toFixed(2)}%、EPS 年增 ${f.epsYoY >= 0 ? '+' : ''}${f.epsYoY.toFixed(1)}%`);

  // 策略
  const matched = scores.filter((x) => x.matched).map((x) => x.strategy.name);
  const best = [...scores].sort((a, b) => b.score - a.score)[0];
  points.push({
    tilt: matched.length ? 'bull' : 'neutral',
    text: matched.length
      ? `策略：符合「${matched.join('」「')}」`
      : `策略：目前沒有完全符合的策略，最接近「${best.strategy.name}」（${best.passed} / ${best.checks.length}）`,
  });

  // 市場背景
  const idx = metrics.index.changePct;
  if (Math.abs(idx) >= 1) points.push({ tilt: idx > 0 ? 'bull' : 'bear', text: `大盤：${universe.index.name} ${idx > 0 ? '+' : ''}${idx.toFixed(2)}%，個股容易跟著大盤方向` });

  const score = weight ? Math.round((total / weight) * 100) : 0;
  const tilt = tiltOf(score);
  const label = score >= 50 ? '明顯偏多' : score >= 15 ? '偏多' : score <= -50 ? '明顯偏空' : score <= -15 ? '偏空' : '中性';
  return { score, tilt, label, points };
}
