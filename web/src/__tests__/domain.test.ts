import { describe, expect, it } from 'vitest';
import { MockMarketProvider } from '../data/mockProvider';
import { buildMockUniverse } from '../data/mockUniverse';
import { roundToTick } from '../data/twse';
import type { MarketSnapshot } from '../data/types';
import { evaluateCastle, type CastleSite } from '../domain/castles';
import { computeMetrics } from '../domain/metrics';
import { area, clipHalfPlane, insetConvex } from '../layout/geometry';
import { computeBattlefield } from '../layout/battlefield';

function firstSnapshot(): MarketSnapshot {
  const provider = new MockMarketProvider();
  let snap: MarketSnapshot | undefined;
  const off = provider.subscribe((s) => (snap = s));
  off();
  return snap!;
}

describe('資金流（成交額佔比變化）', () => {
  it('所有產業的資金流加總為 0', () => {
    const universe = buildMockUniverse();
    const m = computeMetrics(universe, firstSnapshot());
    const sum = m.industries.reduce((s, i) => s + i.flow, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-6);
    expect(m.maxAbsFlow).toBeGreaterThan(0);
  });

  it('佔比高於基準的產業為流入', () => {
    const universe = buildMockUniverse();
    const m = computeMetrics(universe, firstSnapshot());
    for (const ind of m.industries) {
      expect(Math.sign(ind.flow)).toBe(Math.sign(ind.share - ind.baseShare));
    }
  });
});

describe('城池占領度', () => {
  const universe = buildMockUniverse();
  const m = computeMetrics(universe, firstSnapshot());
  const inflow = m.industries.filter((i) => i.flow > 0).sort((a, b) => b.flow - a.flow);
  const outflow = m.industries.filter((i) => i.flow < 0);

  const site = (contestants: string[]): CastleSite => ({ id: 'c', label: '#01', tier: 'major', x: 0, y: 0, r: 10, contestants });

  it('占領度與中立度加總為 1', () => {
    const s = evaluateCastle(site([inflow[0].id, inflow[1].id]), m);
    const total = s.contestants.reduce((acc, c) => acc + c.occupancy, 0) + s.neutral;
    expect(total).toBeCloseTo(1, 9);
    expect(s.leader?.industryId).toBe(inflow[0].id);
  });

  it('資金流出的產業只撤退、不占領', () => {
    const s = evaluateCastle(site([outflow[0].id, outflow[1].id]), m);
    expect(s.contestants.every((c) => c.retreating && c.occupancy === 0)).toBe(true);
    expect(s.status).toBe('neutral');
    expect(s.neutral).toBe(1);
  });
});

describe('幾何', () => {
  const square: [number, number][] = [[0, 0], [0, 10], [10, 10], [10, 0]];

  it('半平面裁切', () => {
    const cut = clipHalfPlane(square, [0, 0], [1, 0], 4);
    expect(area(cut)).toBeCloseTo(60);
  });

  it('凸多邊形內縮', () => {
    expect(area(insetConvex(square, 1))).toBeCloseTo(64);
  });

  it('升降單位', () => {
    expect(roundToTick(1083.2)).toBe(1085);
    expect(roundToTick(46.53)).toBe(46.55);
    expect(roundToTick(9.876)).toBe(9.88);
  });
});

describe('戰場版面', () => {
  const universe = buildMockUniverse();

  for (const [w, h] of [[1200, 760], [400, 520]]) {
    it(`${w}×${h} 可以放下 8–12 座城池，且每檔股票都有區塊`, () => {
      const layout = computeBattlefield(universe, w, h);
      expect(layout.castles.length).toBeGreaterThanOrEqual(8);
      expect(layout.castles.length).toBeLessThanOrEqual(12);
      expect(layout.castles.filter((c) => c.tier === 'core')).toHaveLength(1);
      for (const c of layout.castles) expect(c.contestants.length).toBeGreaterThanOrEqual(2);
      const cells = layout.territories.flatMap((t) => t.cells);
      expect(cells).toHaveLength(universe.stocks.length);
    });
  }
});
