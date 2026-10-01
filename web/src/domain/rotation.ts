import type { IndustryId, TurnoverBar, Universe } from '../data/types';

/**
 * 資金輪動：把盤中切成固定長度的時段，計算每個時段內各產業的成交佔比，
 * 和 20 日平均佔比相比。
 *
 *   時段資金強度（百分點）= 該時段成交佔比 − 20 日平均佔比
 *
 * 和累計資金流不同，這裡只看「那幾分鐘」的資金去向，所以看得出早盤、午盤的輪動。
 */

export interface RotationBucket {
  start: number;
  end: number;
  /** 依產業順序排列，單位：百分點。 */
  values: number[];
}

export interface Rotation {
  industries: Array<{ id: IndustryId; name: string }>;
  buckets: RotationBucket[];
  maxAbs: number;
}

export function computeRotation(universe: Universe, history: TurnoverBar[] | undefined, bucketMinutes = 5): Rotation {
  const industries = universe.industries.map((i) => ({ id: i.id, name: i.name }));
  const industryOf = new Map(universe.stocks.map((s) => [s.code, s.industryId]));
  const baseTotal = universe.stocks.reduce((sum, s) => sum + s.avgTurnover20, 0);
  const baseShare = industries.map(
    (ind) => universe.stocks.filter((s) => s.industryId === ind.id).reduce((sum, s) => sum + s.avgTurnover20, 0) / baseTotal,
  );
  const index = new Map(industries.map((ind, i) => [ind.id, i]));

  const buckets: RotationBucket[] = [];
  if (!history || history.length < 2) return { industries, buckets, maxAbs: 1 };

  for (let from = 0; from < history.length - 1; from += bucketMinutes) {
    const to = Math.min(from + bucketMinutes, history.length - 1);
    const a = history[from];
    const b = history[to];
    const sums = new Array<number>(industries.length).fill(0);
    let total = 0;
    for (const code of Object.keys(b.byStock)) {
      const delta = b.byStock[code] - (a.byStock[code] ?? 0);
      const i = index.get(industryOf.get(code) ?? '');
      if (i === undefined) continue;
      sums[i] += delta;
      total += delta;
    }
    if (total <= 0) continue;
    buckets.push({ start: a.t, end: b.t, values: sums.map((v, i) => (v / total - baseShare[i]) * 100) });
  }
  const maxAbs = Math.max(0.5, ...buckets.flatMap((b) => b.values.map(Math.abs)));
  return { industries, buckets, maxAbs };
}
