import type { IndustryId } from '../data/types';
import type { MarketMetrics } from './metrics';

/**
 * 中立城池（方案①：相鄰產業之間的相對資金強弱）
 *
 * 城池在中央戰場，由面向它的外圈產業爭奪；正中央的核心城池開放所有產業進攻。
 *
 *   攻城壓力 p = max(產業資金流, 0)
 *   守城兵力 N = 今日總成交額 × 1% × 城池規模係數
 *   占領度     = p ÷ (Σp + N)
 *   中立度     = N ÷ (Σp + N)
 *
 * 資金流出的產業不施加壓力，而是「撤退」。守城兵力讓城池在資金流不明顯時維持中立，
 * 核心城池的守城兵力較高，需要更多資金才攻得下來。
 */

export type CastleTier = 'core' | 'major' | 'minor';

export interface CastleSite {
  id: string;
  /** 顯示用編號，例如 #07。 */
  label: string;
  tier: CastleTier;
  x: number;
  y: number;
  r: number;
  /** 相鄰、參與爭奪的產業。 */
  contestants: IndustryId[];
}

export type CastleStatus = 'neutral' | 'contested' | 'advancing' | 'occupied';

export interface ContestantState {
  industryId: IndustryId;
  name: string;
  short: string;
  /**
   * 陣營色序號。三方以內的城池依產業順序固定為 0、1、2；
   * 核心城池開放所有產業進攻，依攻城壓力取前三名，其餘為 -1（其他）。
   */
  slot: number;
  flow: number;
  pressure: number;
  occupancy: number;
  /** 攻擊深度（0–1），1 代表已抵達城牆。 */
  depth: number;
  retreating: boolean;
}

export interface CastleState {
  site: CastleSite;
  contestants: ContestantState[];
  neutral: number;
  leader: ContestantState | undefined;
  status: CastleStatus;
  /** 目前投入這座城池的攻城資金（億元）。 */
  siegeFunds: number;
  /** 爭奪激烈程度：前兩名攻城壓力的較小值（億元）。 */
  intensity: number;
}

export const TIER_DEFENCE: Record<CastleTier, number> = { core: 1.6, major: 1.0, minor: 0.6 };
export const TIER_LABEL: Record<CastleTier, string> = { core: '核心城池', major: '大型城池', minor: '小型據點' };
const DEFENCE_RATIO = 0.01;

export function defenceOf(site: CastleSite, totalTurnover: number): number {
  return Math.max(1e-6, totalTurnover * DEFENCE_RATIO * TIER_DEFENCE[site.tier]);
}

export function evaluateCastle(site: CastleSite, metrics: MarketMetrics): CastleState {
  const defence = defenceOf(site, metrics.totalTurnover);
  const contestants: ContestantState[] = site.contestants.map((id, slot) => {
    const ind = metrics.industryById.get(id);
    const flow = ind?.flow ?? 0;
    const pressure = Math.max(0, flow);
    return {
      industryId: id,
      name: ind?.name ?? id,
      short: ind?.short ?? id,
      slot,
      flow,
      pressure,
      occupancy: 0,
      depth: pressure / (pressure + defence),
      retreating: flow < 0,
    };
  });

  if (contestants.length > 3) {
    const rank = [...contestants].sort((a, b) => b.pressure - a.pressure);
    for (const c of contestants) c.slot = -1;
    rank.slice(0, 3).forEach((c, i) => (c.slot = c.pressure > 0 ? i : -1));
  }

  const siegeFunds = contestants.reduce((sum, c) => sum + c.pressure, 0);
  const denominator = siegeFunds + defence;
  for (const c of contestants) c.occupancy = c.pressure / denominator;
  const neutral = defence / denominator;

  const ranked = [...contestants].sort((a, b) => b.occupancy - a.occupancy);
  const [first, second] = ranked;
  const leader = first && first.occupancy > 0 ? first : undefined;

  let status: CastleStatus;
  if (!leader || siegeFunds < defence * 0.5) status = 'neutral';
  else if (second && second.occupancy >= 0.25 && first.occupancy - second.occupancy < 0.25) status = 'contested';
  else if (first.occupancy >= 0.65) status = 'occupied';
  else status = 'advancing';

  return {
    site,
    contestants,
    neutral,
    leader,
    status,
    siegeFunds,
    intensity: second ? Math.min(first.pressure, second.pressure) : 0,
  };
}

export function statusText(state: CastleState): string {
  switch (state.status) {
    case 'neutral':
      return '中立';
    case 'contested':
      return '爭奪中';
    case 'occupied':
      return `${state.leader?.name ?? ''}占領`;
    case 'advancing':
      return `${state.leader?.name ?? ''}推進中`;
  }
}
