/**
 * 臺指期夜盤（給開盤前的預測用）。期交所把「D 日前一晚」（15:00～05:00）的夜盤標成 D 日，
 * 所以台股 D 開盤前看得到的是標成 D 的夜盤；晚上存檔時它還沒開始 → NaN。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TxDay } from './taifexDaily.ts';

export function loadTx(dir: string): Map<string, TxDay> {
  const out = new Map<string, TxDay>();
  const d = join(dir, 'txdaily');
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort())
    for (const [date, v] of Object.entries(JSON.parse(readFileSync(join(d, f), 'utf8')) as Record<string, TxDay>)) out.set(date, v);
  return out;
}

/** 台股 D 開盤前的夜盤漲跌：夜盤收盤 ÷ 上一個交易日 prev 的一般時段收盤。D 還不知道（下一個交易日）時用 prev 之後最新一筆有夜盤的日期。 */
export function nightMove(tx: Map<string, TxDay>, prev: string, D: string | null): number {
  const p = tx.get(prev)?.d?.[3];
  let n: number | undefined;
  if (D) n = tx.get(D)?.n?.[3];
  else {
    const later = [...tx.keys()].filter((k) => k > prev).sort();
    for (const k of later) if (tx.get(k)?.n) n = tx.get(k)!.n![3];
  }
  return p && n ? Math.log(n / p) : NaN;
}
