/**
 * 模擬盤的熱力圖與產業資金流：用模擬當天的全市場資料，套用首頁熱力圖同一套計算（domain/metrics.ts）。
 *
 * - 股票池跟首頁一樣（內建的約 100 檔、依產業分組），只放那一天有交易的股票。
 * - 成交額用「張數 × 當天均價（開高低收平均）」估算；今天與近 20 日平均用同一種估法，比較的基準一致。
 * - 盤中每一分鐘的成交額依模擬走勢的累計成交量分配；只用到模擬時鐘當下為止，不會偷看收盤。
 */
import { buildMockUniverse } from '../../data/mockUniverse';
import type { SimMonth } from '../../data/simData';
import type { MarketSnapshot, Universe } from '../../data/types';
import { SESSION_MINUTES, intradayPath, type IntradayPath } from '../../domain/intraday';

interface Track {
  path: IntradayPath;
  /** 全天成交額估計（億元）。 */
  turnover: number;
  volume: number;
}

export interface SimMapDay {
  date: string;
  universe: Universe;
  tracks: Map<string, Track>;
}

/** 一天的成交額估計（億元）：張數 × 1000 股 × 均價。 */
const estimate = (o: number, h: number, l: number, c: number, v: number) => (v * 1000 * ((o + h + l + c) / 4)) / 1e8;

/**
 * 建立某一天的熱力圖資料。months：這一天的月份與前一個月（算近 20 日平均要往前找）。
 * 資料不夠（那一天沒有全市場資料）時 null。
 */
export function buildMapDay(date: string, months: SimMonth[]): SimMapDay | null {
  const cur = months.find((m) => m.days[date]);
  if (!cur) return null;
  // 近 20 個交易日（不含今天）
  const pastDays: Array<{ m: SimMonth; d: string }> = [];
  for (const m of months) for (const d of Object.keys(m.days)) if (d < date) pastDays.push({ m, d });
  pastDays.sort((a, b) => (a.d < b.d ? -1 : 1));
  const past = pastDays.slice(-20);
  const idx = new Map(cur.codes.map((c, i) => [c, i]));
  const u = buildMockUniverse();
  const tracks = new Map<string, Track>();
  const stocks = u.stocks.filter((s) => {
    const i = idx.get(s.code);
    const r = i == null ? 0 : cur.days[date][i];
    if (!r) return false;
    const [o, h, l, c, v, pc] = r;
    // 內建市值是用內建股價算的，換成當天的昨收時等比例調整
    s.marketCap *= pc / s.prevClose;
    s.prevClose = pc;
    let sum = 0;
    let n = 0;
    for (const { m, d } of past) {
      const j = m.codes.indexOf(s.code);
      const pr = j < 0 ? 0 : m.days[d][j];
      if (!pr) continue;
      sum += estimate(pr[0], pr[1], pr[2], pr[3], pr[4]);
      n++;
    }
    const turnover = estimate(o, h, l, c, v);
    s.avgTurnover20 = n ? sum / n : turnover;
    tracks.set(s.code, { path: intradayPath(s.code, date, { open: o, high: h, low: l, close: c, volume: v }), turnover, volume: v });
    return true;
  });
  if (stocks.length < 10) return null;
  return { date, universe: { ...u, stocks, etfs: [] }, tracks };
}

/** 模擬時鐘 minute（0～270）當下的行情快照。 */
export function snapshotAt(day: SimMapDay, minute: number): MarketSnapshot {
  const t = Math.max(0, Math.min(SESSION_MINUTES, Math.floor(minute)));
  const quotes: MarketSnapshot['quotes'] = {};
  let total = 0;
  for (const [code, tr] of day.tracks) {
    const p = tr.path;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i <= t; i++) {
      if (p.price[i] > hi) hi = p.price[i];
      if (p.price[i] < lo) lo = p.price[i];
    }
    const turnover = tr.volume > 0 ? (tr.turnover * p.cumVolume[t]) / tr.volume : 0;
    total += turnover;
    quotes[code] = { code, price: p.price[t], high: hi, low: lo, volume: Math.round(p.cumVolume[t]), turnover };
  }
  return { time: t, session: t >= SESSION_MINUTES ? 'closed' : 'open', index: { value: 0, turnover: total, series: [] }, quotes };
}

/** 熱力圖方塊旁的小走勢線：每檔從開盤到現在的價格。 */
export function historyAt(day: SimMapDay, minute: number): Map<string, number[]> {
  const t = Math.max(0, Math.min(SESSION_MINUTES, Math.floor(minute)));
  const out = new Map<string, number[]>();
  for (const [code, tr] of day.tracks) out.set(code, Array.from(tr.path.price.slice(0, t + 1)));
  return out;
}
