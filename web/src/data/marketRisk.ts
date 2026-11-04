/**
 * 大盤風險指標（scripts/market-risk.ts 產生的 data/market-risk.json）：
 * 上市融資維持率、融資與融券餘額、外資台指期淨未平倉。
 */
/** [日期, 維持率(%)／null, 融資餘額(億), 融資張數, 融券張數, 外資淨未平倉(口，大台＋小台÷4)／null] */
export type RiskRow = [string, number | null, number, number, number, number | null];

export interface MarketRisk {
  asOf: string | null;
  rows: RiskRow[];
}

let pending: Promise<MarketRisk | null> | null = null;
export function loadMarketRisk(): Promise<MarketRisk | null> {
  pending ??= fetch('data/market-risk.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<MarketRisk>) : null))
    .then((j) => (j && Array.isArray(j.rows) ? j : null))
    .catch(() => null);
  return pending;
}

/** 融資維持率的白話判斷（大盤約 140% 以下常出現斷頭賣壓；個股 130% 以下追繳）。 */
export function ratioLevel(r: number): { cls: 'ok' | 'warn' | 'bad'; text: string } {
  if (r >= 160) return { cls: 'ok', text: '安全區：融資戶普遍有獲利，斷頭壓力小' };
  if (r >= 145) return { cls: 'warn', text: '留意：再跌一段，融資戶的追繳壓力會升高' };
  return { cls: 'bad', text: '危險區：接近斷頭線，下跌容易引發融資斷頭的連環賣壓（多殺多）' };
}

/** date 以前（不含）最後一筆有某欄資料的列。 */
export function lastBefore(rows: RiskRow[], date: string, col: 1 | 5): RiskRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i][0] < date && rows[i][col] != null) return rows[i];
  return undefined;
}
