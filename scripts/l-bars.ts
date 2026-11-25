/**
 * 00631L 盤中實價 K 棒（Yahoo 財經，免金鑰）：回放時畫真正的 00631L 走勢、對答案用實價算誤差。
 *
 *   node scripts/l-bars.ts <資料資料夾>
 *
 * - Yahoo 的 1 分 K 只給最近 7 天、5 分 K 約 60 天：每天收盤後抓一次，存起來慢慢累積。
 * - 存 lbars/<日期>.json：{ tf: 1 | 5, bars: [["09:00", 開, 高, 低, 收, 量], ...] }（台北時間；量是股）。
 * - 已經有 1 分 K 的日子不再改；只有 5 分 K 的日子，之後抓到 1 分 K 就換掉。今天收盤（13:35）前不存今天。
 * - 這是 Yahoo 的資料（跟 us/ 底下的美股指數同一個來源），不是富果的。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'data';
const out = join(dir, 'lbars');
mkdirSync(out, { recursive: true });
const SYM = process.env.LBARS_SYMBOL ?? '00631L.TW';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
type Bar = [string, number, number, number, number, number];

const tp = (sec: number) => new Date(sec * 1000 + 8 * 3600_000).toISOString();
const nowTp = tp(Date.now() / 1000);
const today = nowTp.slice(0, 10);
const closedToday = nowTp.slice(11, 16) >= '13:35';

async function chart(interval: '1m' | '5m', range: string): Promise<Map<string, Bar[]>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYM)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { chart: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> } };
  const r = j.chart.result?.[0];
  const q = r?.indicators.quote[0];
  const byDay = new Map<string, Bar[]>();
  if (!r?.timestamp || !q) return byDay;
  r.timestamp.forEach((t, i) => {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null) return;
    const s = tp(t);
    const d = s.slice(0, 10);
    const hm = s.slice(11, 16);
    if (hm < '09:00' || hm > '13:30') return;
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push([hm, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2), v ?? 0]);
  });
  return byDay;
}

let saved = 0;
for (const [tf, range] of [[1, '7d'], [5, '60d']] as const) {
  let days: Map<string, Bar[]>;
  try {
    days = await chart(tf === 1 ? '1m' : '5m', range);
  } catch (e) {
    console.log(`00631L ${tf} 分 K（Yahoo）抓不到：${e}`);
    continue;
  }
  for (const [d, bars] of days) {
    if (d > today || (d === today && !closedToday)) continue;
    // 太少根代表那天資料不完整（例如 Yahoo 還沒補齊），先不存
    if (bars.length < (tf === 1 ? 200 : 40)) continue;
    const path = join(out, `${d}.json`);
    const old = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { tf: number }) : null;
    if (old && old.tf <= tf) continue;
    writeFileSync(path, JSON.stringify({ tf, bars }));
    saved++;
  }
  console.log(`00631L ${tf} 分 K（Yahoo）：${days.size} 天`);
}
console.log(`00631L 盤中實價：這次新存 ${saved} 天`);
