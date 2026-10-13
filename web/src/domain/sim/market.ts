/** 由日 K 建立行情查詢（昨收、盤中路徑、除權息、分割）。 */
import { type IntradayPath, intradayPath } from '../intraday';
import { type Split, detectSplits } from '../splits';
import { type Candle } from '../technicals';
import { type ExRight, type Market } from './types';

/** 由日 K 陣列建立查詢用的 Market（測試與網頁共用）；盤中路徑依需要產生並快取。 */
export function buildMarket(series: Map<string, Candle[]>, ex: ExRight[] = []): Market {
  const idx = new Map<string, Map<string, Candle>>();
  for (const [code, rows] of series) idx.set(code, new Map(rows.map((c) => [c.date, c])));
  const exBy = new Map<string, ExRight[]>();
  for (const r of ex) (exBy.get(r[0]) ?? exBy.set(r[0], []).get(r[0])!).push(r);
  const paths = new Map<string, IntradayPath | null>();
  // 分割／減資：從每檔的價格找出來（排除除權息那天）
  const exDays = new Map<string, Set<string>>();
  for (const r of ex) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);
  const splitsBy = new Map<string, Split[]>();
  const splitDay = new Map<string, Array<[string, number]>>();
  for (const [code, rows] of series) {
    const list = detectSplits(rows, exDays.get(code));
    splitsBy.set(code, list);
    for (const [d, k] of list) (splitDay.get(d) ?? splitDay.set(d, []).get(d)!).push([code, k]);
  }
  return {
    splits: (date) => splitDay.get(date) ?? [],
    splitsOf: (code) => splitsBy.get(code) ?? [],
    bar: (code, date) => idx.get(code)?.get(date),
    prevClose(code, date) {
      const rows = series.get(code);
      if (!rows?.length || rows[0].date >= date) return undefined;
      let lo = 0;
      let hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rows[mid].date < date) lo = mid;
        else hi = mid - 1;
      }
      // 中間發生分割／減資時，昨收換算成新的基準（跟交易所的參考價一樣）
      let close = rows[lo].close;
      for (const [d, k] of splitsBy.get(code) ?? []) if (d > rows[lo].date && d <= date) close /= k;
      return close;
    },
    exRights: (date) => exBy.get(date) ?? [],
    path(code, date) {
      const key = `${code}|${date}`;
      if (!paths.has(key)) {
        const b = idx.get(code)?.get(date);
        paths.set(key, b ? intradayPath(code, date, b) : null);
        if (paths.size > 400) paths.delete(paths.keys().next().value!);
      }
      return paths.get(key)!;
    },
  };
}
