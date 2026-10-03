import { describe, expect, it } from 'vitest';
import { MockMarketProvider } from '../data/mockProvider';
import { buildMockUniverse } from '../data/mockUniverse';
import { roundToTick } from '../data/twse';
import type { MarketSnapshot } from '../data/types';
import { computeMetrics } from '../domain/metrics';
import { computeRotation } from '../domain/rotation';

function snapshotAt(startMinute = 65): MarketSnapshot {
  const provider = new MockMarketProvider({ startMinute });
  let snap: MarketSnapshot | undefined;
  const off = provider.subscribe((s) => (snap = s));
  off();
  return snap!;
}

describe('資金流（成交額佔比變化）', () => {
  const universe = buildMockUniverse();
  const m = computeMetrics(universe, snapshotAt());

  it('所有產業的資金流加總為 0', () => {
    expect(Math.abs(m.industries.reduce((s, i) => s + i.flow, 0))).toBeLessThan(1e-6);
    expect(m.maxAbsFlow).toBeGreaterThan(0);
  });

  it('佔比高於常態的產業為流入', () => {
    for (const ind of m.industries) expect(Math.sign(ind.flow)).toBe(Math.sign(ind.share - ind.baseShare));
  });

  it('產業資金流等於旗下個股資金流加總', () => {
    for (const ind of m.industries) {
      expect(ind.stocks.reduce((s, x) => s + x.flow, 0)).toBeCloseTo(ind.flow, 6);
    }
  });
});

describe('資金輪動', () => {
  it('每個時段各產業的偏離加總為 0', () => {
    const universe = buildMockUniverse();
    const rotation = computeRotation(universe, snapshotAt().turnoverHistory);
    expect(rotation.buckets.length).toBeGreaterThan(5);
    for (const b of rotation.buckets) expect(Math.abs(b.values.reduce((s, v) => s + v, 0))).toBeLessThan(1e-6);
  });
});

describe('模擬行情', () => {
  it('台積電的成交佔比接近實際水準（10%–25%）', () => {
    const m = computeMetrics(buildMockUniverse(), snapshotAt());
    const tsmc = m.stockByCode.get('2330')!;
    expect(tsmc.baseShare).toBeGreaterThan(0.1);
    expect(tsmc.baseShare).toBeLessThan(0.25);
  });

  it('升降單位', () => {
    expect(roundToTick(1083.2)).toBe(1085);
    expect(roundToTick(46.53)).toBe(46.55);
    expect(roundToTick(9.876)).toBe(9.88);
  });
});

describe('作戰日誌', () => {
  it('第一次只報告系統上線，之後才偵測變化', async () => {
    const { EventDetector } = await import('../domain/events');
    const universe = buildMockUniverse();
    const detector = new EventDetector();
    const first = detector.detect(computeMetrics(universe, snapshotAt(30)));
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain('系統上線');
    // 同一個盤勢再看一次，不會重複報事件
    expect(detector.detect(computeMetrics(universe, snapshotAt(30)))).toHaveLength(0);
  });

  it('盤中推進會產生事件，而且每個事件都有時間', async () => {
    const { EventDetector } = await import('../domain/events');
    const universe = buildMockUniverse();
    const detector = new EventDetector();
    const events = [30, 90, 150, 210, 270].flatMap((min) => detector.detect(computeMetrics(universe, snapshotAt(min))));
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) expect(e.t).toBeGreaterThan(0);
  });
});
