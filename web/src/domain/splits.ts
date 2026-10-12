/**
 * 股票分割、面額變更、減資：資料來源的日 K 是沒有還原的原始價格，分割那天股價會「跳」一大段
 * （例如 0050 一拆四，188 元隔天變 47 元）。這裡從價格找出這些事件，模擬盤用來換算持股，圖表用來還原。
 *
 * 判斷方式：台股一天最多漲跌 10%，所以開盤價跟前一天收盤差超過約 20%、而且那天沒有除權息，
 * 就是參考價被調整過了（新上市前 5 天沒有漲跌幅限制，略過）。
 * - 前收 ÷ 開盤 接近整數 k（誤差在一天漲跌幅以內）：一拆 k，股數 ×k。
 * - 其他（減資、反分割）：用價格比例換算，可能有幾 % 的誤差。
 */
export interface PriceRow {
  date: string;
  open: number;
  close: number;
}

/** [日期, 股數倍數]（>1 分割、<1 減資或反分割） */
export type Split = [string, number];

export function detectSplits(rows: PriceRow[], exDates: Set<string> = new Set()): Split[] {
  const out: Split[] = [];
  for (let i = 5; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const open = rows[i].open;
    if (!(prev > 0) || !(open > 0) || exDates.has(rows[i].date)) continue;
    const q = prev / open;
    if (q > 1.2) {
      const k = Math.round(q);
      out.push([rows[i].date, k >= 2 && Math.abs(q / k - 1) <= 0.11 ? k : Math.round(q * 1e4) / 1e4]);
    } else if (q < 0.83) out.push([rows[i].date, Math.round(q * 1e4) / 1e4]);
  }
  return out;
}

/** 把事件以前的 K 線還原成跟現在同一個基準（價格 ÷ 倍數、成交量 × 倍數）；只用 upTo 以前（含）發生的事件。 */
export function adjustForSplits<T extends { date: string; open: number; high: number; low: number; close: number; volume: number }>(
  rows: T[],
  splits: Split[],
  upTo: string,
): T[] {
  const done = splits.filter(([d]) => d <= upTo);
  if (!done.length) return rows;
  return rows.map((r) => {
    let f = 1;
    for (const [d, k] of done) if (r.date < d) f *= k;
    return f === 1 ? r : { ...r, open: r.open / f, high: r.high / f, low: r.low / f, close: r.close / f, volume: r.volume * f };
  });
}
