/**
 * 型態歷史勝率（回測）：用已累積的全市場日 K，統計每種型態出現後的實際走勢。
 *
 *   node --import ./scripts/lib/ts-resolve.mjs scripts/pattern-stats.ts <資料資料夾>
 *
 * 規則：
 * - 型態：每 3 個交易日用「當天以前」的日 K 跑一次型態辨識（不看未來）。
 *   偏多型態 20 個交易日後收盤較高算勝、偏空型態收盤較低算勝。
 *   同一檔股票、同一種型態 20 天內只算一次，避免重疊的視窗重複計算。
 * - K 棒訊號：訊號出現後 5 個交易日的漲跌。
 * - 基準：同樣的取樣點隨機持有 20（5）天上漲的比例。多頭期間偏多型態容易「看起來很準」，
 *   要和基準比較才看得出型態有沒有額外的預測力。
 * 只用一般股票（4 碼），不含 ETF。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectPatterns } from '../web/src/domain/patterns.ts';
import { detectCandles } from '../web/src/domain/candlesticks.ts';
import type { Candle } from '../web/src/domain/technicals.ts';

const HORIZON = 20;
const CANDLE_HORIZON = 5;
const STEP = Number(process.env.STATS_STEP ?? 3);
const DEADLINE = Number(process.env.DEADLINE ?? Infinity);

interface Acc {
  n: number;
  win: number;
  /** 往型態方向的報酬加總（%）。 */
  ret: number;
}
const acc = (m: Map<string, Acc>, key: string, signedRet: number) => {
  const a = m.get(key) ?? { n: 0, win: 0, ret: 0 };
  a.n++;
  if (signedRet > 0) a.win++;
  a.ret += signedRet * 100;
  m.set(key, a);
};

const dir = process.argv[2] ?? 'data';
const files = readdirSync(join(dir, 'candles')).filter((f) => /^\d{4}\.json$/.test(f));
const patterns = new Map<string, Acc>();
const candles = new Map<string, Acc>();
let base20 = { n: 0, up: 0 };
let base5 = { n: 0, up: 0 };
let from = '9999';
let to = '0000';
let used = 0;
const started = Date.now();

for (const f of files) {
  if (Date.now() > DEADLINE) {
    console.log('時間到，先用已處理的股票輸出');
    break;
  }
  const rows = JSON.parse(readFileSync(join(dir, 'candles', f), 'utf8')) as Array<[string, number, number, number, number, number]>;
  if (rows.length < 150) continue;
  const c: Candle[] = rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  used++;
  if (c[0].date < from) from = c[0].date;
  if (c[c.length - 1].date > to) to = c[c.length - 1].date;

  const last: Record<string, number> = {};
  for (let t = 120; t + HORIZON < c.length; t += STEP) {
    const ret = (c[t + HORIZON].close - c[t].close) / c[t].close;
    base20.n++;
    if (ret > 0) base20.up++;
    const { patterns: found } = detectPatterns(c.slice(0, t + 1));
    for (const p of found) {
      if (p.bias === 'neutral') continue;
      if (t - (last[p.id] ?? -Infinity) < HORIZON) continue;
      last[p.id] = t;
      acc(patterns, `${p.id}|${p.bias}`, p.bias === 'bull' ? ret : -ret);
    }
  }

  for (let t = 20; t + CANDLE_HORIZON < c.length; t += STEP) {
    base5.n++;
    if (c[t + CANDLE_HORIZON].close > c[t].close) base5.up++;
  }
  for (const s of detectCandles(c, c.length)) {
    if (s.bias === 'neutral' || s.i + CANDLE_HORIZON >= c.length) continue;
    const ret = (c[s.i + CANDLE_HORIZON].close - c[s.i].close) / c[s.i].close;
    acc(candles, `${s.name}|${s.bias}`, s.bias === 'bull' ? ret : -ret);
  }
}

const pack = (m: Map<string, Acc>) =>
  Object.fromEntries([...m].map(([k, a]) => [k, { n: a.n, win: Math.round((a.win / a.n) * 1000) / 1000, avg: Math.round((a.ret / a.n) * 100) / 100 }]));
const out = {
  generatedAt: new Date().toISOString(),
  from,
  to,
  stocks: used,
  horizon: HORIZON,
  candleHorizon: CANDLE_HORIZON,
  baseline: { up20: base20.n ? Math.round((base20.up / base20.n) * 1000) / 1000 : null, up5: base5.n ? Math.round((base5.up / base5.n) * 1000) / 1000 : null },
  patterns: pack(patterns),
  candles: pack(candles),
};
writeFileSync(join(dir, 'pattern-stats.json'), JSON.stringify(out));
console.log(`完成：${used} 檔、${from}～${to}，型態 ${patterns.size} 類、K 棒 ${candles.size} 類，基準 20 日上漲 ${out.baseline.up20}，耗時 ${Math.round((Date.now() - started) / 1000)} 秒`);
for (const [k, v] of Object.entries(out.patterns).sort((a, b) => b[1].win - a[1].win)) console.log(`  ${k.padEnd(20)} n=${String(v.n).padStart(5)} 勝率 ${(v.win * 100).toFixed(1)}% 平均 ${v.avg}%`);
for (const [k, v] of Object.entries(out.candles).sort((a, b) => b[1].win - a[1].win)) console.log(`  ${k.padEnd(20)} n=${String(v.n).padStart(5)} 勝率 ${(v.win * 100).toFixed(1)}% 平均 ${v.avg}%`);
