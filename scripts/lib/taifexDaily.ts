/**
 * 期交所「期貨每日交易行情」CSV（futDataDown）→ 臺股期貨（TX）近月的一般時段與夜盤（盤後）開高低收。
 * 依欄位名稱找欄位（交易日期、契約、到期月份、開盤價…、交易時段），沒有成交的「-」略過。
 * 近月＝當天月契約（6 碼年月，不含週契約與價差）裡到期月份最小的。
 */
export type Ohlcv = [number, number, number, number, number];
export interface TxDay {
  /** 一般時段（08:45～13:45）。 */
  d?: Ohlcv;
  /** 夜盤（15:00～隔天 05:00），依期交所的交易日期歸屬。 */
  n?: Ohlcv;
}

const num = (s: string | undefined) => {
  const v = Number(String(s ?? '').replace(/,/g, '').trim());
  return Number.isFinite(v) && v > 0 ? v : NaN;
};

export function parseTxDaily(csv: string): Record<string, TxDay> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return {};
  const head = lines[0].split(',').map((s) => s.trim());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const iDate = col('交易日期');
  const iCon = col('契約');
  const iMon = col('到期月份');
  const iO = col('開盤價');
  const iH = col('最高價');
  const iL = col('最低價');
  const iC = col('收盤價');
  const iV = col('成交量');
  const iS = col('交易時段');
  if ([iDate, iCon, iMon, iO, iH, iL, iC, iV, iS].some((i) => i < 0)) throw new Error(`期交所欄位不符：${head.join(',')}`);
  // 每天、每個時段：近月（到期月份最小的月契約）
  const best = new Map<string, { mon: string; v: Ohlcv }>();
  for (const l of lines.slice(1)) {
    const c = l.split(',').map((s) => s.trim());
    if (c[iCon] !== 'TX') continue;
    const mon = c[iMon] ?? '';
    if (!/^\d{6}$/.test(mon)) continue;
    const v: Ohlcv = [num(c[iO]), num(c[iH]), num(c[iL]), num(c[iC]), num(c[iV]) || 0];
    if (!Number.isFinite(v[3])) continue;
    const date = (c[iDate] ?? '').replace(/\//g, '-');
    const session = (c[iS] ?? '').includes('盤後') ? 'n' : 'd';
    const key = `${date}|${session}`;
    const cur = best.get(key);
    if (!cur || mon < cur.mon) best.set(key, { mon, v: v.map((x) => (Number.isFinite(x) ? x : v[3])) as Ohlcv });
  }
  const out: Record<string, TxDay> = {};
  for (const [key, { v }] of best) {
    const [date, s] = key.split('|');
    (out[date] ??= {})[s as 'd' | 'n'] = v;
  }
  return out;
}
