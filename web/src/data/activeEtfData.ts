import type { ChangeRow, HoldingRow } from './activeEtfDiff';
import type { EtfMeta } from './types';

/**
 * 每日自動抓取的主動式 ETF 持股（GitHub Actions 產生的 data/active-etf.json）。
 * 讀不到時（例如本機開發、還沒跑過排程）就沿用模擬資料。
 */

export interface ActiveEtfFile {
  generatedAt: string;
  etfs: Record<
    string,
    { issuer: string; asOf: string; snapshots: number; holdings: HoldingRow[]; changes: ChangeRow[]; error?: string; fetchedAt?: string }
  >;
}

export async function loadActiveEtfData(url = 'data/active-etf.json'): Promise<ActiveEtfFile | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = (await res.json()) as ActiveEtfFile;
    return json && typeof json.etfs === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** 用真實持股取代模擬資料；只動有抓到資料的主動式 ETF。 */
export function applyActiveEtfData(etfs: EtfMeta[], file: ActiveEtfFile): number {
  let n = 0;
  for (const meta of etfs) {
    const d = file.etfs[meta.code];
    if (meta.category !== 'active' || !d?.holdings?.length) continue;
    meta.holdings = d.holdings.map((h) => ({ code: h.code, name: h.name, weight: h.weight }));
    meta.changes = (d.changes ?? []).map((c) => ({ date: c.date, code: c.code, name: c.name, kind: c.kind, before: c.before, after: c.after }));
    meta.holdingsSource = { kind: 'real', asOf: d.asOf, snapshots: d.snapshots, issuer: d.issuer };
    meta.rebalance = { schedule: '每日公告持股，經理人隨時調整', last: d.asOf };
    n++;
  }
  return n;
}
