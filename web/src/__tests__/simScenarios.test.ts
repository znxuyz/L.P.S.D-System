import { describe, expect, it } from 'vitest';
import { MIN_LEFT_DAYS, pickRandomStart, SCENARIOS } from '../domain/simScenarios';

/** 2020-01-01 起到 2026-10-09 的平日（當作交易日）。 */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

describe('隨機開局', () => {
  const cal = weekdays('2020-01-01', '2026-10-09');
  const minIdx = 60;

  it('起點一定離最新資料至少一年', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const labels = new Set<string>();
    for (let k = 0; k < 2000; k++) {
      const r = pickRandomStart(cal, minIdx, rnd);
      expect(r.idx).toBeGreaterThanOrEqual(minIdx);
      expect(cal.length - 1 - r.idx).toBeGreaterThanOrEqual(MIN_LEFT_DAYS);
      if (r.scenario) labels.add(r.scenario);
    }
    // 每個情境都抽得到
    expect(labels.size).toBe(SCENARIOS.length);
  });

  it('情境起點在事件前 0～10 個交易日', () => {
    const r = pickRandomStart(cal, minIdx, () => 0);
    const s = SCENARIOS.find((x) => x.label === r.scenario)!;
    const i = cal.findIndex((d) => d >= s.start);
    expect(i - r.idx).toBeGreaterThanOrEqual(0);
    expect(i - r.idx).toBeLessThanOrEqual(10);
  });

  it('太近的情境不會被抽到', () => {
    const short = weekdays('2020-01-01', '2025-09-01');
    for (let k = 0; k < 200; k++) {
      const r = pickRandomStart(short, minIdx);
      expect(short.length - 1 - r.idx).toBeGreaterThanOrEqual(MIN_LEFT_DAYS);
      expect(r.scenario).not.toBe(SCENARIOS.at(-1)!.label);
    }
  });

  it('資料不夠一年時退回至少留一個月', () => {
    const tiny = weekdays('2026-01-01', '2026-10-09');
    const r = pickRandomStart(tiny, minIdx, () => 0.99);
    expect(r.idx).toBeLessThanOrEqual(tiny.length - 22);
  });
});
