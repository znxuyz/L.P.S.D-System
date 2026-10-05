import { describe, expect, it } from 'vitest';
import { mockDailyCandles, previousWeekdays } from '../data/candles';
import { MockMarketProvider } from '../data/mockProvider';
import { buildSummary, peerStats, strategyScores } from '../domain/analysis';
import { computeMetrics } from '../domain/metrics';
import { classifyHeadline } from '../domain/news';
import { stockView } from '../domain/screens';
import { analyzeTechnicals, kd, rsi, sma, type Candle } from '../domain/technicals';

const line = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }));

describe('技術指標', () => {
  it('均線前 n−1 天為空', () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  it('一路上漲：RSI 接近 100、KD 在高檔、均線多頭排列', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(rsi(closes).at(-1)!).toBeGreaterThan(95);
    expect(kd(line(closes)).k.at(-1)!).toBeGreaterThan(80);
    const report = analyzeTechnicals(line(closes))!;
    expect(report.signals.find((s) => s.id === 'ma')!.value).toBe('多頭排列');
  });

  it('一路下跌：均線空頭排列、MACD 偏空', () => {
    const report = analyzeTechnicals(line(Array.from({ length: 80 }, (_, i) => 200 - i)))!;
    expect(report.signals.find((s) => s.id === 'ma')!.value).toBe('空頭排列');
    expect(report.signals.find((s) => s.id === 'macd')!.tilt).toBe('bear');
  });

  it('資料不足 30 天時不計算', () => {
    expect(analyzeTechnicals(line([1, 2, 3]))).toBeNull();
  });
});

describe('示意日 K', () => {
  it('只有平日，最後收盤等於昨收，同代號結果固定', () => {
    const a = mockDailyCandles('2330', 1000, '2026-10-05');
    expect(a.at(-1)!.close).toBeCloseTo(1000);
    expect(a.at(-1)!.date).toBe('2026-10-02'); // 10/5 是星期一，前一個平日是星期五
    expect(a.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))).toBe(true);
    expect(mockDailyCandles('2330', 1000, '2026-10-05')).toEqual(a);
    expect(previousWeekdays('2026-10-05', 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('個股分析', () => {
  it('策略評分、同業比較與摘要', async () => {
    const provider = new MockMarketProvider({ tickMs: 1e9 });
    const universe = await provider.loadUniverse();
    let snap!: Parameters<typeof computeMetrics>[1];
    provider.subscribe((s) => (snap = s))();
    const metrics = computeMetrics(universe, snap);
    const fundamentals = new Map(universe.stocks.map((s) => [s.code, s.fundamentals!]));
    const s = metrics.stockByCode.get('2330')!;
    const view = stockView(s, fundamentals.get('2330')!);
    const scores = strategyScores(view);
    expect(scores).toHaveLength(5);
    expect(scores.every((x) => x.score >= 0 && x.score <= 1)).toBe(true);

    const peers = peerStats(s, metrics, fundamentals);
    const ind = metrics.industryById.get(s.industryId)!;
    expect(peers.every((p) => p.rank >= 1 && p.rank <= ind.stocks.length)).toBe(true);

    const { candles } = await provider.dailyCandles('2330');
    const sum = buildSummary(view, scores, analyzeTechnicals(candles), metrics, universe);
    expect(sum.score).toBeGreaterThanOrEqual(-100);
    expect(sum.score).toBeLessThanOrEqual(100);
    expect(sum.points.length).toBeGreaterThanOrEqual(5);
  });

  it('新聞關鍵字判斷', () => {
    expect(classifyHeadline('台積電調升全年展望，營收創新高')).toBe('bull');
    expect(classifyHeadline('長榮運價下滑，獲利恐不如預期')).toBe('bear');
    expect(classifyHeadline('鴻海召開股東會')).toBe('neutral');
  });
});
