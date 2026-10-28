import type { Candle } from '../domain/technicals';
import { adjustForSplits, detectSplits, type Split } from '../domain/splits';
import { createRng, gaussian } from './random';

/** 個股分析用的日 K（不含今天；今天的 K 棒由即時報價補上）。 */
export interface DailySeries {
  candles: Candle[];
  /**
   * official = 證交所／櫃買每日收盤（GitHub Actions 每天累積）；fugle = 富果日 K；
   * mock = 模擬行情用的示意資料（只用在模擬模式的熱力圖股票）；none = 沒有真實日 K。
   */
  source: 'official' | 'fugle' | 'mock' | 'none';
  /** 抓不到真實日 K 時的原因（例如富果回應的錯誤）。 */
  note?: string;
  /** 已經還原的股票分割、面額變更、減資：[日期, 股數倍數]。 */
  splits?: Split[];
}

/** 官方日 K：一檔一個檔案（data/candles/2330.json），由 GitHub Actions 每天累積。 */
const exYears = new Map<number, Promise<Array<[string, string]>>>();

/** 某檔股票的除權息日（分割判斷要排除這些日子）。 */
async function exDaysFor(code: string, fromYear: number, toYear: number): Promise<Set<string>> {
  const years: Promise<Array<[string, string]>>[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    let p = exYears.get(y);
    if (!p) {
      p = fetch(`data/exrights/${y}.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? (r.json() as Promise<Array<[string, string]>>) : []))
        .catch(() => []);
      exYears.set(y, p);
    }
    years.push(p);
  }
  return new Set((await Promise.all(years)).flat().filter((r) => r[1] === code).map((r) => r[0]));
}

/**
 * 還原股票分割、面額變更、減資：日 K 是交易所的原始價格，分割那天會「跳」一大段（例如一拆四股價變 1/4），
 * 均線、型態、技術指標都會被這一刀帶歪。把之前的價格換算成現在的基準（價格 ÷ 倍數、成交量 × 倍數）。
 */
export async function adjustSplits(code: string, series: DailySeries): Promise<DailySeries> {
  const c = series.candles;
  if (c.length < 10) return series;
  const ex = await exDaysFor(code, Number(c[0].date.slice(0, 4)), Number(c[c.length - 1].date.slice(0, 4)));
  const splits = detectSplits(c, ex);
  if (!splits.length) return series;
  return { ...series, candles: adjustForSplits(c, splits, '9999-12-31'), splits };
}

export async function loadOfficialCandles(code: string): Promise<Candle[] | null> {
  try {
    const res = await fetch(`data/candles/${encodeURIComponent(code)}.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const rows = (await res.json()) as [string, number, number, number, number, number][];
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  } catch {
    return null;
  }
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
  // 示意走勢不要偏離太遠：一年內的高低點控制在現價的 ±35% 左右
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const k = Math.min(1, Math.log(1.35) / Math.max(1e-9, Math.max(Math.log(hi / prevClose), Math.log(prevClose / lo))));
  for (let i = 0; i < days; i++) closes[i] = prevClose * Math.exp(Math.log(closes[i] / prevClose) * k);
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
