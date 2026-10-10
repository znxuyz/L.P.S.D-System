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
 * - 行情分組：訊號當天加權指數收盤在 120 日均線（半年線）之上算「多頭行情」、之下算「空頭行情」，
 *   各自另算一份勝率與基準（regimes），看型態是不是只在某種行情有效。這個判斷只用當天以前的資料。
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

type Regime = 'bull' | 'bear';
const REGIME_MA = 120;
/** 每個交易日的大盤行情：加權指數收盤在 120 日均線之上＝多頭。 */
const regimeOf = new Map<string, Regime>();
{
  let taiex: Array<[string, number, number, number, number]> = [];
  try {
    taiex = JSON.parse(readFileSync(join(dir, 'index', 'TAIEX.json'), 'utf8'));
  } catch {
    console.log('沒有加權指數資料，不分行情');
  }
  let sum = 0;
  taiex.forEach(([date, , , , close], i) => {
    sum += close;
    if (i >= REGIME_MA) sum -= taiex[i - REGIME_MA][4];
    if (i >= REGIME_MA - 1) regimeOf.set(date, close >= sum / REGIME_MA ? 'bull' : 'bear');
  });
}
const byRegime = {
  bull: { patterns: new Map<string, Acc>(), candles: new Map<string, Acc>(), base20: { n: 0, up: 0 }, base5: { n: 0, up: 0 } },
  bear: { patterns: new Map<string, Acc>(), candles: new Map<string, Acc>(), base20: { n: 0, up: 0 }, base5: { n: 0, up: 0 } },
};
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
    const reg = regimeOf.get(c[t].date);
    const R = reg ? byRegime[reg] : null;
    if (R) {
      R.base20.n++;
      if (ret > 0) R.base20.up++;
    }
    const { patterns: found } = detectPatterns(c.slice(0, t + 1));
    for (const p of found) {
      if (p.bias === 'neutral') continue;
      if (t - (last[p.id] ?? -Infinity) < HORIZON) continue;
      last[p.id] = t;
      acc(patterns, `${p.id}|${p.bias}`, p.bias === 'bull' ? ret : -ret);
      if (R) acc(R.patterns, `${p.id}|${p.bias}`, p.bias === 'bull' ? ret : -ret);
    }
  }

  for (let t = 20; t + CANDLE_HORIZON < c.length; t += STEP) {
    base5.n++;
    const up = c[t + CANDLE_HORIZON].close > c[t].close;
    if (up) base5.up++;
    const reg = regimeOf.get(c[t].date);
    if (reg) {
      byRegime[reg].base5.n++;
      if (up) byRegime[reg].base5.up++;
    }
  }
  for (const s of detectCandles(c, c.length)) {
    if (s.bias === 'neutral' || s.i + CANDLE_HORIZON >= c.length) continue;
    const ret = (c[s.i + CANDLE_HORIZON].close - c[s.i].close) / c[s.i].close;
    acc(candles, `${s.name}|${s.bias}`, s.bias === 'bull' ? ret : -ret);
    const reg = regimeOf.get(c[s.i].date);
    if (reg) acc(byRegime[reg].candles, `${s.name}|${s.bias}`, s.bias === 'bull' ? ret : -ret);
  }
}

const rate = (b: { n: number; up: number }) => (b.n ? Math.round((b.up / b.n) * 1000) / 1000 : null);
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
  regimes: regimeOf.size
    ? {
        rule: `加權指數收盤在 ${REGIME_MA} 日均線之上＝多頭行情，之下＝空頭行情（以訊號當天判斷）`,
        ...Object.fromEntries(
          (['bull', 'bear'] as const).map((r) => {
            const R = byRegime[r];
            const days = [...regimeOf.values()].filter((v) => v === r).length;
            return [r, { days, baseline: { up20: rate(R.base20), up5: rate(R.base5) }, patterns: pack(R.patterns), candles: pack(R.candles) }];
          }),
        ),
      }
    : undefined,
};
writeFileSync(join(dir, 'pattern-stats.json'), JSON.stringify(out));
console.log(`完成：${used} 檔、${from}～${to}，型態 ${patterns.size} 類、K 棒 ${candles.size} 類，基準 20 日上漲 ${out.baseline.up20}，耗時 ${Math.round((Date.now() - started) / 1000)} 秒`);
for (const [k, v] of Object.entries(out.patterns).sort((a, b) => b[1].win - a[1].win)) console.log(`  ${k.padEnd(20)} n=${String(v.n).padStart(5)} 勝率 ${(v.win * 100).toFixed(1)}% 平均 ${v.avg}%`);
for (const [k, v] of Object.entries(out.candles).sort((a, b) => b[1].win - a[1].win)) console.log(`  ${k.padEnd(20)} n=${String(v.n).padStart(5)} 勝率 ${(v.win * 100).toFixed(1)}% 平均 ${v.avg}%`);
