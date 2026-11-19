/**
 * 模型模擬帳戶（紙上交易）：完全照「事前存檔」的預測自動下單，看模型實際能不能賺錢。
 *
 *   FORECASTS_DIR=<存檔資料夾> node scripts/paper-trade.ts <資料資料夾>
 *
 * - 只用開盤前已經存檔的預測（forecasts 分支，早上那份優先），成交用之後實際的開盤價、5 分 K、收盤價；不可能看答案。
 * - 每次從第一份存檔重新計算（不存狀態），模型之後怎麼改都不會改到過去的成績。
 * - 本金 100 萬，分三個部位：
 *   趨勢 80%：前一天加權指數收盤在 200 日均線之上 → 持有 00631L，跌破 → 全部換現金（隔天開盤換）。
 *     這是公開文獻的經典規則（槓桿 ETF＋200 日均線），不是用我們的資料調出來的；2020～2026 每一年都贏加權指數。
 *   個股 10%：存檔裡最看好的前 10 檔，下一個交易日開盤平均買進，持有 20 個交易日後收盤賣出，再換下一批。
 *   00631L 開盤當沖 10%：存檔的當沖規則（開盤看跳空決定做多／做空／觀望），收盤出場。
 *   個股與當沖 2022～2026 回測沒有贏大盤，只留小比例觀察；實盤證明有用再加碼。
 *   （00631L 區間進出場模型一直判斷「不交易」，不放錢；成績在 5 分 K 那一區。）
 * - 成本：手續費 0.1425% × 6 折（買賣各一次）、證交稅（個股 0.3%、ETF 0.1%）。
 *
 * 輸出 paper.json。
 *
 * 歷史回測：PAPER_FROM／PAPER_TO 限制期間、PAPER_OUT 換輸出檔名，FORECASTS_DIR 指向 predict.ts／predict-intraday.ts
 * 用 BACKFILL_DIR 寫出的「歷史模擬存檔」（逐段往前滾，每天只用那天以前的資料）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAYTRADE_COST } from '../web/src/domain/intradayModel.ts';
import { adjustForSplits, detectSplits } from '../web/src/domain/splits.ts';
import { readPreOpen } from './lib/archive.ts';

const dir = process.argv[2] ?? 'data';
const FDIR = process.env.FORECASTS_DIR;
const read = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const r5 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : null);

const CAPITAL = 1_000_000;
const FEE = 0.001425 * 0.6;
const STOCK_TAX = 0.003;
const HOLD = 20;
const N_PICKS = 10;
const W = { trend: 0.8, stocks: 0.1, dayTrade: 0.1 };
const MA_N = 200;
const ETF_TAX = 0.001;

// ---------------------------------------------------------------- 資料
const taiex = read<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []);
const cal = taiex.map((r) => r[0]);
const ci = new Map(cal.map((d, i) => [d, i]));
const names = read<Record<string, string>>(join(dir, 'names.json'), {});
const exDays = new Map<string, Set<string>>();
for (const f of readdirSync(join(dir, 'exrights')).filter((f) => /^\d{4}\.json$/.test(f)))
  for (const r of read<Array<[string, string]>>(join(dir, 'exrights', f), [])) (exDays.get(r[1]) ?? exDays.set(r[1], new Set()).get(r[1])!).add(r[0]);
/** 日 K（分割還原；價格比例才對）：日期 → [開, 高, 低, 收] */
const kCache = new Map<string, Map<string, [number, number, number, number]>>();
function kOf(code: string) {
  let m = kCache.get(code);
  if (m) return m;
  const raw = read<Array<[string, number, number, number, number, number]>>(join(dir, 'candles', `${code}.json`), []);
  const bars = raw.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  const adj = adjustForSplits(bars, detectSplits(bars, exDays.get(code)), '9999-12-31');
  m = new Map(adj.map((b) => [b.date, [b.open, b.high, b.low, b.close] as [number, number, number, number]]));
  kCache.set(code, m);
  return m;
}

// ---------------------------------------------------------------- 存檔
type DailyArch = { stocks: { top: string[] }; dayTrade: { code: string; lastClose: number; cost: number; rule: { a: number; b: number; gapMean: number; gapSd: number } } | null };
const daily = new Map(readPreOpen<DailyArch>(FDIR, 'daily').map((a) => [a.asOf, a]));
const firstArch = [...daily.keys()].sort()[0];

interface Trade {
  date: string;
  book: 'stocks' | 'dayTrade' | 'trend';
  code: string;
  name: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  price: number | null;
  pnl: number | null;
  note: string;
}
const trades: Trade[] = [];
const equityRows: Array<[string, number, number, number, number, number]> = [];

let stockCash = CAPITAL * W.stocks;
let dtCash = CAPITAL * W.dayTrade;
let trCash = CAPITAL * W.trend;
let trShares = 0;
let trCost = 0;
let trSince: string | null = null;
/** 第 i 天收盤在 200 日均線之上？（資料不夠時 false） */
const aboveMa = (i: number) => {
  if (i < MA_N - 1) return false;
  let sm = 0;
  for (let j = i - MA_N + 1; j <= i; j++) sm += taiex[j][4];
  return taiex[i][4] > sm / MA_N;
};
const maOf = (i: number) => (i < MA_N - 1 ? NaN : taiex.slice(i - MA_N + 1, i + 1).reduce((t, r) => t + r[4], 0) / MA_N);
let held: { buyIdx: number; pos: Array<{ code: string; shares: number; cost: number }> } | null = null;

const FROM = process.env.PAPER_FROM ?? '0000';
const TO = process.env.PAPER_TO ?? '9999';
const startIdx = firstArch ? cal.findIndex((d) => d > firstArch && d >= FROM) : -1;
if (startIdx > 0) {
  const ix0 = taiex[startIdx - 1][4];
  for (let i = startIdx; i < cal.length && cal[i] <= TO; i++) {
    const D = cal[i];
    const prev = cal[i - 1];
    const dArch = daily.get(prev);

    // ---- 個股：到期賣出（第 20 個交易日收盤）；賣出當天不再買（錢要收盤後才拿得到），隔天開盤才買下一批
    let soldToday = false;
    if (held && i - held.buyIdx >= HOLD - 1) {
      soldToday = true;
      for (const p of held.pos) {
        const k = kOf(p.code).get(D);
        const px = k?.[3] ?? [...kOf(p.code).entries()].filter(([d]) => d <= D).at(-1)?.[1][3] ?? p.cost;
        const value = p.shares * px * (1 - FEE - STOCK_TAX);
        stockCash += value;
        trades.push({ date: D, book: 'stocks', code: p.code, name: names[p.code] ?? '', side: 'sell', price: r2(px), pnl: r2(value - p.shares * p.cost * (1 + FEE)), note: '持有 20 個交易日到期' });
      }
      held = null;
    }
    // ---- 個股：沒有部位時，用昨天收盤後的存檔，今天開盤買前 10 檔
    if (!held && !soldToday && dArch?.stocks?.top?.length) {
      const picks = dArch.stocks.top.filter((c) => kOf(c).get(D)?.[0]).slice(0, N_PICKS);
      if (picks.length) {
        const each = stockCash / picks.length;
        const pos = picks.map((code) => {
          const px = kOf(code).get(D)![0];
          const shares = Math.floor(each / (px * (1 + FEE)));
          stockCash -= shares * px * (1 + FEE);
          trades.push({ date: D, book: 'stocks', code, name: names[code] ?? '', side: 'buy', price: r2(px), pnl: null, note: '最看好前 10 檔，開盤買' });
          return { code, shares, cost: px };
        });
        held = { buyIdx: i, pos };
      }
    }

    // ---- 00631L 開盤當沖：開盤看跳空決定做多／做空／觀望，收盤出場
    const L = kOf('00631L').get(D);
    if (dArch?.dayTrade && L) {
      const { a, b, gapMean, gapSd } = dArch.dayTrade.rule;
      const gap = L[0] / dArch.dayTrade.lastClose - 1;
      const pred = a + b * Math.max(-4, Math.min(4, (gap - gapMean) / (gapSd || 1)));
      const act = pred > dArch.dayTrade.cost ? 1 : pred < -dArch.dayTrade.cost ? -1 : 0;
      if (act) {
        const pnl = dtCash * (act * (L[3] / L[0] - 1) - DAYTRADE_COST);
        dtCash += pnl;
        trades.push({ date: D, book: 'dayTrade', code: '00631L', name: '元大台灣50正2', side: act > 0 ? 'long' : 'short', price: r2(L[0]), pnl: r2(pnl), note: `跳空 ${(gap * 100).toFixed(2)}%，開盤${act > 0 ? '買' : '空'}、收盤 ${L[3]} 出場` });
      }
    }

    // ---- 趨勢：昨天收盤在 200 日均線之上就持有 00631L，否則現金；今天開盤換
    if (L) {
      const want = aboveMa(i - 1);
      if (want && !trShares) {
        trShares = Math.floor(trCash / (L[0] * (1 + FEE)));
        trCost = trShares * L[0] * (1 + FEE);
        trCash -= trCost;
        trSince = D;
        trades.push({ date: D, book: 'trend', code: '00631L', name: '元大台灣50正2', side: 'buy', price: r2(L[0]), pnl: null, note: '加權指數昨天收在 200 日均線之上，開盤買進' });
      } else if (!want && trShares) {
        const value = trShares * L[0] * (1 - FEE - ETF_TAX);
        trCash += value;
        trades.push({ date: D, book: 'trend', code: '00631L', name: '元大台灣50正2', side: 'sell', price: r2(L[0]), pnl: r2(value - trCost), note: '加權指數昨天跌破 200 日均線，開盤賣出換現金' });
        trShares = 0;
        trSince = null;
      }
    }

    // ---- 每天收盤的帳戶價值
    let stockVal = stockCash;
    for (const p of held?.pos ?? []) stockVal += p.shares * (kOf(p.code).get(D)?.[3] ?? [...kOf(p.code).entries()].filter(([d]) => d <= D).at(-1)?.[1][3] ?? p.cost);
    const trVal = trCash + trShares * (L?.[3] ?? [...kOf('00631L').entries()].filter(([d]) => d <= D).at(-1)?.[1][3] ?? 0);
    equityRows.push([D, r2(stockVal + dtCash + trVal), r2(stockVal), r2(dtCash), r2(trVal), r2(CAPITAL * (taiex[i][4] / ix0))]);
  }
}

const last = equityRows.at(-1);
const lastDay = last?.[0] ?? cal.at(-1)!;
let peak = -Infinity;
let maxDD = 0;
for (const r of equityRows) (peak = Math.max(peak, r[1])), (maxDD = Math.min(maxDD, r[1] / peak - 1));
const bookStat = (b: Trade['book']) => {
  const t = trades.filter((x) => x.book === b && x.pnl != null);
  return { trades: t.length, win: t.length ? r5(t.filter((x) => x.pnl! > 0).length / t.length) : null };
};
// 每個月的報酬（帳戶與大盤）
const monthly: Array<[string, number | null, number | null]> = [];
{
  let prevEq = CAPITAL;
  let prevBm = CAPITAL;
  equityRows.forEach((r, k) => {
    const nx = equityRows[k + 1];
    if (nx && nx[0].slice(0, 7) === r[0].slice(0, 7)) return;
    monthly.push([r[0].slice(0, 7), r5(r[1] / prevEq - 1), r5(r[5] / prevBm - 1)]);
    prevEq = r[1];
    prevBm = r[5];
  });
}
const out = {
  generatedAt: new Date().toISOString(),
  capital: CAPITAL,
  weights: W,
  firstArchive: firstArch ?? null,
  start: equityRows[0]?.[0] ?? null,
  asOf: last?.[0] ?? null,
  days: equityRows.length,
  equity: last?.[1] ?? CAPITAL,
  ret: last ? r5(last[1] / CAPITAL - 1) : 0,
  books: last
    ? { stocks: r5(last[2] / (CAPITAL * W.stocks) - 1), dayTrade: r5(last[3] / (CAPITAL * W.dayTrade) - 1), trend: r5(last[4] / (CAPITAL * W.trend) - 1) }
    : { stocks: 0, dayTrade: 0, trend: 0 },
  // 同期間把 100 萬買加權指數放著
  benchmark: last ? r5(last[5] / CAPITAL - 1) : 0,
  maxDD: r5(maxDD),
  stats: { stocks: bookStat('stocks'), dayTrade: bookStat('dayTrade'), trend: bookStat('trend') },
  // 趨勢部位：目前持有什麼、下一個交易日該持有什麼（看最新收盤與 200 日均線）
  trend: (() => {
    const li = cal.length - 1;
    return { holding: trShares > 0, since: trSince, nextHold: aboveMa(li), close: r2(taiex[li][4]), ma: r2(maOf(li)), dist: r5(taiex[li][4] / maOf(li) - 1), asOf: cal[li] };
  })(),
  monthly,
  curve: equityRows,
  positions: (held?.pos ?? []).map((p) => {
    const k = [...kOf(p.code).entries()].filter(([d]) => d <= lastDay).at(-1)?.[1];
    return { code: p.code, name: names[p.code] ?? '', shares: p.shares, cost: r2(p.cost), price: k ? r2(k[3]) : null, ret: k ? r5(k[3] / p.cost - 1) : null };
  }),
  heldSince: held ? cal[held.buyIdx] : null,
  sellOn: held ? `${HOLD} 個交易日後（第 ${HOLD} 天收盤）` : null,
  trades: trades.slice(-60).reverse(),
  tradeCount: trades.length,
};
writeFileSync(join(dir, process.env.PAPER_OUT ?? 'paper.json'), JSON.stringify(out));
console.log(`模擬帳戶：${out.days} 天（${out.start ?? '—'} ～ ${out.asOf ?? '—'}），總報酬 ${out.ret}，大盤 ${out.benchmark}，最大回落 ${out.maxDD}，交易 ${trades.length} 筆`);
console.log('  各部位：', JSON.stringify(out.books), JSON.stringify(out.stats));
