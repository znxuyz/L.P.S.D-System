import type { IndustryId } from '../data/types';
import type { MarketMetrics } from './metrics';

/**
 * 作戰日誌：比較前後兩次盤勢，找出值得注意的事件。
 *
 * - 產業資金轉向：資金流從撤出轉為湧入（或反過來）。用遲滯區間避免在 0 附近反覆觸發。
 * - 資金龍頭易主：資金流入第一名的產業換人。
 * - 資金流突破門檻：產業資金流的絕對值每突破 50 億記一次。
 * - 個股急漲急跌：漲跌幅首次突破 ±5%，以及觸及漲跌停。
 * - 大盤突破：加權指數漲跌幅首次突破 ±1%、±2%。
 */

export type EventLevel = 'info' | 'alert' | 'critical';

export interface MarketEvent {
  id: number;
  /** epoch ms */
  t: number;
  level: EventLevel;
  text: string;
  industryId?: IndustryId;
  code?: string;
}

const FLOW_STEP = 50;
const LIMIT_PCT = 9.5;
const SURGE_PCT = 5;

export class EventDetector {
  private seq = 0;
  private started = false;
  private flowState = new Map<IndustryId, 'in' | 'out' | 'flat'>();
  private flowLevel = new Map<IndustryId, number>();
  private leader: IndustryId | undefined;
  private stockLevel = new Map<string, number>();
  private indexLevel = 0;

  reset(): void {
    this.started = false;
    this.flowState.clear();
    this.flowLevel.clear();
    this.leader = undefined;
    this.stockLevel.clear();
    this.indexLevel = 0;
  }

  detect(m: MarketMetrics): MarketEvent[] {
    const events: MarketEvent[] = [];
    const emit = (level: EventLevel, text: string, ref: { industryId?: IndustryId; code?: string } = {}) =>
      events.push({ id: ++this.seq, t: m.time, level, text, ...ref });
    const first = !this.started;
    this.started = true;

    // 遲滯區間：總成交額的 0.3%
    const band = Math.max(1, m.totalTurnover * 0.003);
    for (const ind of m.industries) {
      const prev = this.flowState.get(ind.id) ?? 'flat';
      const next = ind.flow > band ? 'in' : ind.flow < -band ? 'out' : prev === 'flat' ? 'flat' : prev;
      if (!first && next !== prev && next !== 'flat') {
        emit('alert', next === 'in' ? `${ind.name} 轉為資金湧入` : `${ind.name} 轉為資金撤出`, { industryId: ind.id });
      }
      this.flowState.set(ind.id, next);

      const level = Math.floor(Math.abs(ind.flow) / FLOW_STEP);
      const prevLevel = this.flowLevel.get(ind.id) ?? (first ? level : 0);
      if (!first && level > prevLevel && level > 0) {
        const amount = level * FLOW_STEP;
        emit(level >= 2 ? 'critical' : 'alert', `${ind.name} 資金${ind.flow >= 0 ? '湧入' : '撤出'}突破 ${amount} 億`, { industryId: ind.id });
      }
      this.flowLevel.set(ind.id, Math.max(level, first ? level : prevLevel));
    }

    const top = [...m.industries].sort((a, b) => b.flow - a.flow)[0];
    if (top && top.flow > 0) {
      if (first) emit('info', `系統上線，目前資金龍頭：${top.name}`, { industryId: top.id });
      else if (this.leader && this.leader !== top.id) {
        const old = m.industryById.get(this.leader);
        emit('critical', `資金龍頭易主：${top.name} 超越 ${old?.name ?? ''}`, { industryId: top.id });
      }
      this.leader = top.id;
    }

    for (const s of m.stockByCode.values()) {
      const abs = Math.abs(s.changePct);
      const level = abs >= LIMIT_PCT ? 2 : abs >= SURGE_PCT ? 1 : 0;
      const prev = this.stockLevel.get(s.code) ?? (first ? level : 0);
      if (!first && level > prev) {
        const up = s.changePct > 0;
        if (level === 2) emit('critical', `${s.name} ${up ? '漲停' : '跌停'}`, { code: s.code });
        else emit('alert', `${s.name} ${up ? '急漲' : '急跌'} ${s.changePct.toFixed(1)}%`, { code: s.code });
      }
      this.stockLevel.set(s.code, Math.max(level, prev));
    }

    const idxLevel = Math.floor(Math.abs(m.index.changePct));
    if (!first && idxLevel > this.indexLevel && idxLevel > 0) {
      emit('critical', `加權指數${m.index.changePct >= 0 ? '漲' : '跌'}幅突破 ${idxLevel}%`);
    }
    this.indexLevel = Math.max(this.indexLevel, idxLevel);

    return events;
  }
}
