/**
 * 朋友排行榜的成績：每位玩家玩的期間、天數、速度都不一樣，所以
 * - 「日／週／月」看的是「最近 1／5／20 個模擬交易日」，不是現實的日期；
 * - 排名用「超額報酬」＝自己的報酬－同一段期間加權指數的報酬，大家在不同年代玩也能比；
 * - 天數不夠的區間不列入那個排行。
 * 有薪資投入時，區間報酬用簡化的 Modified Dietz：（期末－期初－投入）÷（期初＋投入）。
 */
import { benchValue, investedOf, type SimState } from './sim';

export type Window = 'd1' | 'd5' | 'd20' | 'all';
export const WINDOW_DAYS: Record<Exclude<Window, 'all'>, number> = { d1: 1, d5: 5, d20: 20 };
export const WINDOW_NAME: Record<Window, string> = { d1: '日排行', d5: '週排行', d20: '月排行', all: '本局' };

export interface BoardStats {
  /** 玩了幾個交易日（已收盤）。 */
  days: number;
  /** 各區間的報酬率。 */
  r: Record<Window, number | null>;
  /** 各區間的超額報酬（減掉同期大盤）。 */
  x: Record<Window, number | null>;
}

export function boardStats(s: SimState, index: (d: string) => number | undefined, prevDay: (d: string) => string | undefined): BoardStats {
  const eq = s.equity;
  const r: BoardStats['r'] = { d1: null, d5: null, d20: null, all: null };
  const x: BoardStats['x'] = { d1: null, d5: null, d20: null, all: null };
  if (eq.length) {
    const [d1, e1] = eq[eq.length - 1];
    for (const w of ['d1', 'd5', 'd20'] as const) {
      const n = WINDOW_DAYS[w];
      if (eq.length < n) continue;
      const i = eq.length - 1 - n;
      const d0 = i >= 0 ? eq[i][0] : prevDay(s.settings.start);
      const e0 = i >= 0 ? eq[i][1] : s.settings.capital;
      const flow = s.flows.filter(([d]) => (i < 0 || d > d0!) && d <= d1).reduce((a, [, v]) => a + v, 0);
      if (!d0 || e0 + flow <= 0) continue;
      r[w] = (e1 - e0 - flow) / (e0 + flow);
      const t0 = index(d0);
      const t1 = index(d1);
      if (t0 && t1) x[w] = r[w]! - (t1 / t0 - 1);
    }
    const inv = investedOf(s);
    r.all = e1 / inv - 1;
    const b = benchValue(s, index, prevDay, d1);
    if (b != null) x.all = r.all - (b / inv - 1);
  }
  return { days: eq.length, r, x };
}
