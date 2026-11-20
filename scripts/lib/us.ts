/**
 * 美股漲跌（給台股預測用的特徵）。
 *
 * 台股第 D 天開盤前看得到的美股：日期在「前一個台股交易日 prev」（含）到 D（不含）之間收盤的美股交易日。
 * 美股日期 = 美國當地日期；美股收盤在台北隔天清晨，所以美國日期 d 的收盤一定在台股 d＋1 開盤前。
 * 回傳這段期間的累計對數報酬；這段期間沒有任何美股收盤（例如晚上存檔時，當晚的美股還沒收）回傳 NaN。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = [string, number, number, number, number];
export const US_SYMBOLS = ['SOX', 'TSM', 'GSPC', 'VIX'] as const;
export type UsSym = (typeof US_SYMBOLS)[number];

export function loadUs(dir: string): Record<UsSym, Row[]> {
  const out = {} as Record<UsSym, Row[]>;
  for (const s of US_SYMBOLS) {
    try {
      out[s] = JSON.parse(readFileSync(join(dir, 'us', `${s}.json`), 'utf8')) as Row[];
    } catch {
      out[s] = [];
    }
  }
  return out;
}

export { usMove } from './usMove.ts';
