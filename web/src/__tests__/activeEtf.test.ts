import { describe, expect, it } from 'vitest';
import { applyActiveEtfData } from '../data/activeEtfData';
import { diffSnapshots, looksValid, pushSnapshot, recentChanges, type Snapshot } from '../data/activeEtfDiff';
import type { EtfMeta } from '../data/types';

const h = (code: string, weight: number, shares: number) => ({ code, name: `股${code}`, weight, shares });

describe('主動式 ETF 持股比對', () => {
  it('新進、出清、加碼、減碼', () => {
    const prev: Snapshot = { date: '2026-10-02', holdings: [h('2330', 9, 1000), h('2454', 6, 500), h('2603', 1, 300)] };
    const next: Snapshot = { date: '2026-10-05', holdings: [h('2330', 9.5, 1100), h('2454', 5, 400), h('3017', 2, 200)] };
    const kinds = Object.fromEntries(diffSnapshots(prev, next).map((c) => [c.code, c.kind]));
    expect(kinds).toEqual({ '3017': 'add', '2330': 'increase', '2454': 'decrease', '2603': 'remove' });
  });

  it('申購買回造成的等比例股數變化不算經理人調整', () => {
    const prev: Snapshot = { date: '2026-10-02', units: 1000, holdings: [h('2330', 9, 1000), h('2454', 6, 500)] };
    // 單位數多 10%，所有股數也多 10%：每單位持股不變
    const next: Snapshot = { date: '2026-10-05', units: 1100, holdings: [h('2330', 9, 1100), h('2454', 6, 550)] };
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it('歷史同一天會被取代，只保留最近幾筆；異動由新到舊', () => {
    const s = (date: string, shares: number): Snapshot => ({ date, holdings: [h('2330', 9, shares), h('2454', 6, 500)] });
    let hist: Snapshot[] = [];
    for (const [d, n] of [['2026-09-30', 1000], ['2026-10-01', 1100], ['2026-10-01', 1200], ['2026-10-02', 1000]] as const) hist = pushSnapshot(hist, s(d, n), 3);
    expect(hist.map((x) => x.date)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    const ch = recentChanges(hist);
    expect(ch.map((c) => `${c.date} ${c.kind}`)).toEqual(['2026-10-02 decrease', '2026-10-01 increase']);
  });

  it('資料不完整時不採用', () => {
    expect(looksValid({ date: '2026-10-05', holdings: [h('2330', 9, 1)] })).toBe(false);
    expect(looksValid({ date: '2026/10/05', holdings: Array.from({ length: 10 }, (_, i) => h(String(2300 + i), 9, 1)) })).toBe(false);
    expect(looksValid({ date: '2026-10-05', holdings: Array.from({ length: 10 }, (_, i) => h(String(2300 + i), 9, 1)) })).toBe(true);
  });

  it('套用到 ETF：只換有資料的主動式 ETF', () => {
    const etfs = [
      { code: '00980A', category: 'active', holdings: [], changes: [] },
      { code: '0050', category: 'market', holdings: [], changes: [] },
    ] as unknown as EtfMeta[];
    const n = applyActiveEtfData(etfs, {
      generatedAt: '',
      etfs: {
        '00980A': { issuer: '野村投信', asOf: '2026-10-05', snapshots: 1, holdings: [h('3105', 5, 1)], changes: [] },
        '0050': { issuer: 'x', asOf: '2026-10-05', snapshots: 1, holdings: [h('2330', 50, 1)], changes: [] },
      },
    });
    expect(n).toBe(1);
    expect(etfs[0].holdings).toEqual([{ code: '3105', name: '股3105', weight: 5 }]);
    expect(etfs[0].holdingsSource).toMatchObject({ kind: 'real', asOf: '2026-10-05', issuer: '野村投信' });
    expect(etfs[1].holdings).toEqual([]);
  });
});
