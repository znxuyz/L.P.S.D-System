import type { Candle } from '../domain/technicals';
import { createRng, gaussian } from './random';

/** 個股分析用的日 K（不含今天；今天的 K 棒由即時報價補上）。 */
export interface DailySeries {
  candles: Candle[];
  /** fugle = 富果真實日 K；mock = 示意資料。 */
  source: 'fugle' | 'mock';
}

function hashCode(code: string): number {
  let h = 2166136261;
  for (const c of code) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** 往前數 n 個平日（不含 today），由舊到新。 */
export function previousWeekdays(today: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

/**
 * 示意日 K：以代號為種子的隨機漫步，最後一天收盤等於昨收。
 * 只用來展示圖表與指標的樣子，不代表真實走勢。
 */
export function mockDailyCandles(code: string, prevClose: number, today: string, days = 260): Candle[] {
  const rng = createRng(hashCode(code));
  const drift = (rng() - 0.45) * 0.002;
  const vol = 0.012 + rng() * 0.014;
  const dates = previousWeekdays(today, days);
  // 由最後一天往回推，確保最後收盤 = 昨收
  const closes: number[] = new Array(days);
  closes[days - 1] = prevClose;
  for (let i = days - 1; i > 0; i--) closes[i - 1] = closes[i] / Math.exp(drift + vol * gaussian(rng));
  const baseVol = 2000 + rng() * 30000;
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1] * (1 + vol * 0.3 * gaussian(rng));
    const wick = close * vol * 0.6;
    const ret = i === 0 ? 0 : Math.abs(close / closes[i - 1] - 1);
    return {
      date,
      open,
      high: Math.max(open, close) + wick * rng(),
      low: Math.min(open, close) - wick * rng(),
      close,
      volume: Math.round(baseVol * (0.6 + rng() * 0.8) * (1 + ret * 25)),
    };
  });
}
