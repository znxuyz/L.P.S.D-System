/** 模擬盤的「今日排行」：全市場每一檔今天的盤中路徑，依漲跌、量、價排序。 */
import type { SimMonth } from '../../data/simData';
import { SESSION_MINUTES, intradayPath, type IntradayPath } from '../../domain/intraday';
import type { SimState } from '../../domain/sim';
import { escapeHtml as esc, num, pct, price } from '../format';
import { cls } from './util';

export type RankKey = 'up' | 'down' | 'vol' | 'high' | 'low' | 'fav';
export const RANK_NAME: Record<RankKey, string> = { up: '漲幅', down: '跌幅', vol: '成交量', high: '高價', low: '低價', fav: '自選' };

export interface RankRow {
  code: string;
  /** 昨收（分割當天已換算成新的基準）。 */
  pc: number;
  path: IntradayPath;
}

/** 某一天全市場的盤中路徑（換日時算一次）。 */
export function rankRows(month: SimMonth, date: string): RankRow[] {
  const rows: RankRow[] = [];
  const day = month.days[date];
  if (!day) return rows;
  day.forEach((r, i) => {
    if (!r) return;
    const [open, high, low, close, volume, pc] = r;
    const code = month.codes[i];
    rows.push({ code, pc, path: intradayPath(code, date, { open, high, low, close, volume }) });
  });
  return rows;
}

/** 前 k 名：不用整個排序（約 2,000 檔，畫面每秒重畫好幾次），只維護 k 個的有序名單。 */
export function topK<T>(items: T[], k: number, better: (a: T, b: T) => boolean): T[] {
  const top: T[] = [];
  for (const it of items) {
    if (top.length === k && !better(it, top[k - 1])) continue;
    let i = top.length < k ? top.length : k - 1;
    if (top.length < k) top.push(it);
    while (i > 0 && better(it, top[i - 1])) {
      top[i] = top[i - 1];
      i--;
    }
    top[i] = it;
  }
  return top;
}

/** 排行表格（不含分頁按鈕）。 */
export function rankTableHtml(rows: RankRow[], s: SimState, key: RankKey, nameOf: (code: string) => string): string {
  if (key === 'fav' && !s.fav.length) return '<p class="muted">還沒有自選股。看一檔股票時按圖表上方的「☆ 自選」加入。</p>';
  const t = Math.min(SESSION_MINUTES, Math.floor(s.minute));
  const pick = (r: RankRow) => {
    const p = r.path.price[t];
    return { code: r.code, p, chg: r.pc ? p / r.pc - 1 : 0, vol: r.path.cumVolume[t] };
  };
  type Item = ReturnType<typeof pick>;
  let shown: Item[];
  if (key === 'fav') {
    const byCode = new Map(rows.map((r) => [r.code, r]));
    shown = s.fav.map((c) => byCode.get(c)).filter((r): r is RankRow => !!r).map(pick);
  } else {
    const better: Record<Exclude<RankKey, 'fav'>, (a: Item, b: Item) => boolean> = {
      up: (a, b) => a.chg > b.chg,
      down: (a, b) => a.chg < b.chg,
      vol: (a, b) => a.vol > b.vol,
      high: (a, b) => a.p > b.p,
      low: (a, b) => a.p < b.p,
    };
    shown = topK(rows.map(pick), 20, better[key]);
  }
  const body = shown
    .map(
      (r, i) => `<tr data-sim="watch" data-code="${esc(r.code)}" class="${r.code === s.watch ? 'is-watch' : ''}">
          <td class="num muted">${i + 1}</td><td><b>${esc(r.code)}</b> ${esc(nameOf(r.code))}</td>
          <td class="num">${price(r.p)}</td><td class="num ${cls(r.chg)}">${pct(r.chg * 100)}</td><td class="num muted">${num(Math.round(r.vol))}</td></tr>`,
    )
    .join('');
  return `<div class="sim-table-wrap"><table class="sim-table sim-rank-table"><thead><tr><th>#</th><th>股票</th><th>現價</th><th>漲跌</th><th>量（張）</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted sim-note">共 ${rows.length} 檔（上市、上櫃、ETF），價格是依當天開高低收模擬的盤中走勢。</p>`;
}
