/**
 * 模型模擬帳戶（紙上交易）：完全照「事前存檔」的預測自動下單，看模型實際能不能賺錢。
 *
 *   FORECASTS_DIR=<存檔資料夾> node scripts/paper-trade.ts <資料資料夾>
 *
 * - 只用開盤前已經存檔的預測（forecasts 分支，早上那份優先），成交用之後實際的開盤價、5 分 K、收盤價；不可能看答案。
 * - 每次從第一份存檔重新計算（不存狀態），模型之後怎麼改都不會改到過去的成績。
 * - 本金 100 萬，分兩個部位：
 *   趨勢 50%：前一天加權指數收盤在 200 日均線之上 → 持有 00631L，跌破 → 全部換現金（隔天開盤換）。
 *     持有比例依波動調整（公開研究的標準做法）：比例＝長期一般波動 ÷ 近 20 日波動（最多 100%），
 *     長期一般波動＝到前一天為止所有近 20 日波動的中位數（不偷看未來）；比例變動超過 20% 才調整，避免一直換手。
 *     回測 2020-11 起：最大回落 −41% → −32%（跟大盤一樣），總報酬 +728% → +523%（大盤 +206%），每一年都贏大盤。
 *   現金（趨勢不持有、營收選股持有現金時）以年息 1.5% 計（定存或貨幣基金）。
 *     這是公開文獻的經典規則（槓桿 ETF＋200 日均線），不是用我們的資料調出來的；2020～2026 每一年都贏加權指數。
 *   營收選股 50%：每月 12 日後第一個交易日開盤，換成存檔裡「營收成長加速＋營收創新高＋毛利率改善＋法人買超」綜合分數最高的 20 檔
 *     （留在名單裡的不動，掉出名單的賣、新進的買）；換股前一天加權指數在 200 日均線之下就全部持有現金。
 *     （分兩批輪流換的版本只當對照，見 TRANCHES。）
 * - 舊的個股排名（逆勢撿便宜）、00631L 開盤當沖、區間進出場：2022～2026 回測都沒有贏大盤，不放錢（成績在各自的區塊）。
 * - 成本：手續費 0.1425% 不打折（保守；實際券商多有折扣，買賣各一次）、證交稅（個股 0.3%、ETF 0.1%）。
 *   不足一張的零股成交價比開盤價差 0.5%、手續費每筆最低 20 元（見 ODD）。回測（2022 起）：營收選股部位 +165% → +111%，整個帳戶 +193% → +166%（大盤 +98%）。
 *
 * 輸出 paper.json。
 *
 * 歷史回測：PAPER_FROM／PAPER_TO 限制期間、PAPER_OUT 換輸出檔名，FORECASTS_DIR 指向 predict.ts／predict-intraday.ts
 * 用 BACKFILL_DIR 寫出的「歷史模擬存檔」（逐段往前滾，每天只用那天以前的資料）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRebalanceDate } from './lib/revDates.ts';
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
const FEE = 0.001425;
const STOCK_TAX = 0.003;
const REV_N = 20;
const W = { trend: 0.5, stocks: 0.5, dayTrade: 0 };
const MA_N = 200;
const ETF_TAX = 0.001;
/**
 * 真實下單的限制：50 萬分 20 檔、每檔只有約 2.5 萬，很多股票一張就買不起，只能買零股。
 * - 整張的部分用開盤價；不足一張的零股另外下單，價格比開盤價差 PAPER_ODD_SPREAD（預設 0.5%，保守：買貴、賣便宜）。
 * - 手續費每筆最低 20 元（整股、零股是不同筆）。PAPER_ODD_SPREAD=0 且 MIN_FEE=0 就是舊的理想算法（比較用）。
 */
const ODD = Number(process.env.PAPER_ODD_SPREAD ?? 0.005);
const MIN_FEE = Number(process.env.PAPER_MIN_FEE ?? 20);
const feeOf = (amt: number) => (amt > 0 ? Math.max(MIN_FEE, amt * FEE) : 0);
/** 買 shares 股要付的總金額（含手續費）。 */
const buyCost = (px: number, shares: number) => {
  const lots = Math.floor(shares / 1000) * 1000;
  const a = lots * px;
  const b = (shares - lots) * px * (1 + ODD);
  return a + b + feeOf(a) + feeOf(b);
};
/** 賣 shares 股拿回的金額（扣手續費、證交稅）。 */
const sellValue = (px: number, shares: number, tax: number) => {
  const lots = Math.floor(shares / 1000) * 1000;
  const a = lots * px;
  const b = (shares - lots) * px * (1 - ODD);
  return a + b - feeOf(a) - feeOf(b) - (a + b) * tax;
};
/** 預算內最多能買幾股。 */
const maxShares = (px: number, budget: number) => {
  let n = Math.floor(budget / (px * (1 + FEE)));
  while (n > 0 && buyCost(px, n) > budget) n -= Math.max(1, Math.ceil((buyCost(px, n) - budget) / (px * (1 + ODD + FEE))));
  return Math.max(0, n);
};
const CASH_RATE = 0.015;
/** 依波動調整持有比例；VOL_TARGET=0 關掉（比較用）。 */
const VOL_TARGET = process.env.VOL_TARGET !== '0';

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
type DailyArch = { stocks: { top: string[] }; revStocks?: { top: string[]; trendOk: boolean }; dayTrade: { code: string; lastClose: number; cost: number; rule: { a: number; b: number; gapMean: number; gapSd: number } } | null };
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

/**
 * 營收選股分 REV_TRANCHES 批：每批各抱 N 個月，每個換股日只換其中一批（輪流）。預設 1＝每月全換（正式帳戶）。
 * 研究（2021-01～2026-11）：選股後第 1、2 個月都多賺約 1.8%（t≈3.5），第 3 個月才變弱，所以試了分兩批（換手 63% → 38%）。
 * 模擬帳戶回測（2022 起，含 200 日均線）：開發期（～2025-10）+105% vs +81% 比較好，但保留期（2025-11～）+30% vs +47% 比較差，
 * 整段 +166% vs +165% 打平 → 沒通過保留期檢驗，不採用；部署時另外輸出 paper-backtest-2t.json 繼續對照。
 */
const TRANCHES = Math.max(1, Number(process.env.REV_TRANCHES ?? 1));
type Pos = { code: string; shares: number; cost: number; paid: number };
const tranches: Array<{ cash: number; pos: Pos[]; since: number | null }> = Array.from({ length: TRANCHES }, () => ({ cash: (CAPITAL * W.stocks) / TRANCHES, pos: [], since: null }));
let rebCount = 0;
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
// 加權指數近 20 日波動（年化）與「到前一天為止」的中位數
const ixLr = taiex.map((r, i) => (i ? Math.log(r[4] / taiex[i - 1][4]) : 0));
const vol20 = taiex.map((_, i) => {
  if (i < 20) return NaN;
  let s = 0;
  let s2 = 0;
  for (let j = i - 19; j <= i; j++) (s += ixLr[j]), (s2 += ixLr[j] ** 2);
  return Math.sqrt(Math.max(0, s2 / 20 - (s / 20) ** 2) * 252);
});
const volMed: number[] = [];
{
  const sorted: number[] = [];
  for (let i = 0; i < taiex.length; i++) {
    volMed.push(sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN);
    if (Number.isFinite(vol20[i])) sorted.splice(sorted.findIndex((x) => x > vol20[i]) < 0 ? sorted.length : sorted.findIndex((x) => x > vol20[i]), 0, vol20[i]);
  }
  // 最後一天之後（下一個交易日）用的中位數
  volMed.push(sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN);
}
/** 第 i 天收盤後算出的「下一個交易日」00631L 持有比例（0～1）。 */
const trendWeight = (i: number) => {
  if (!aboveMa(i)) return 0;
  if (!VOL_TARGET) return 1;
  const w = volMed[i + 1] / vol20[i];
  return Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 1;
};
const maOf = (i: number) => (i < MA_N - 1 ? NaN : taiex.slice(i - MA_N + 1, i + 1).reduce((t, r) => t + r[4], 0) / MA_N);

const FROM = process.env.PAPER_FROM ?? '0000';
const TO = process.env.PAPER_TO ?? '9999';
const startIdx = firstArch ? cal.findIndex((d) => d > firstArch && d >= FROM) : -1;
if (startIdx > 0) {
  const ix0 = taiex[startIdx - 1][4];
  for (let i = startIdx; i < cal.length && cal[i] <= TO; i++) {
    const D = cal[i];
    const prev = cal[i - 1];
    // 現金的利息（每個交易日）
    for (const t of tranches) t.cash *= 1 + CASH_RATE / 252;
    trCash *= 1 + CASH_RATE / 252;
    const dArch = daily.get(prev);

    // ---- 營收選股：換股日開盤，照前一天收盤後存檔的名單換股（大盤跌破 200 日均線 → 全部現金）
    const rs = dArch?.revStocks;
    if (rs && isRebalanceDate(D, prev)) {
      const target = rs.trendOk ? rs.top.filter((c) => kOf(c).get(D)?.[0]).slice(0, REV_N) : [];
      const keep = new Set(target);
      const turn = rebCount++ % TRANCHES;
      tranches.forEach((t, ti) => {
        // 大盤在 200 日均線之下：每一批都換現金；否則只換輪到的那一批（還是現金的批次也一起買進）
        if (rs.trendOk && ti !== turn && t.pos.length) return;
        const tag = TRANCHES > 1 ? `（第 ${ti + 1} 批）` : '';
        for (const p of t.pos) {
          if (keep.has(p.code)) continue;
          const px = kOf(p.code).get(D)?.[0] ?? [...kOf(p.code).entries()].filter(([d]) => d < D).at(-1)?.[1][3] ?? p.cost;
          const value = sellValue(px, p.shares, STOCK_TAX);
          t.cash += value;
          trades.push({ date: D, book: 'stocks', code: p.code, name: names[p.code] ?? '', side: 'sell', price: r2(px), pnl: r2(value - p.paid), note: (rs.trendOk ? '掉出營收選股名單，開盤賣' : '大盤在 200 日均線之下，換現金') + tag });
        }
        const kept = t.pos.filter((p) => keep.has(p.code));
        const have = new Set(kept.map((p) => p.code));
        const fresh = target.filter((c) => !have.has(c));
        const pos = [...kept];
        if (fresh.length) {
          const each = t.cash / fresh.length;
          for (const code of fresh) {
            const px = kOf(code).get(D)![0];
            const shares = maxShares(px, each);
            if (!shares) continue;
            const paid = buyCost(px, shares);
            t.cash -= paid;
            trades.push({ date: D, book: 'stocks', code, name: names[code] ?? '', side: 'buy', price: r2(px), pnl: null, note: '新進營收選股名單，開盤買' + tag });
            pos.push({ code, shares, cost: px, paid });
          }
        }
        t.pos = pos;
        t.since = pos.length ? i : null;
      });
    }

    const L = kOf('00631L').get(D);

    // ---- 趨勢：昨天收盤在 200 日均線之上就持有 00631L（比例依波動調整），否則現金；今天開盤換
    if (L) {
      const want = trendWeight(i - 1);
      const val = trCash + trShares * L[0];
      const cur = val > 0 ? (trShares * L[0]) / val : 0;
      const full = want === 0 || cur === 0;
      if ((full && want !== cur && (want === 0 ? trShares > 0 : want >= 0.2)) || (!full && Math.abs(want - cur) > 0.2)) {
        const target = maxShares(L[0], want * val);
        const diff = target - trShares;
        const why = want === 0 ? '加權指數昨天跌破 200 日均線，換現金' : cur === 0 ? `加權指數在 200 日均線之上，買進（持有 ${Math.round(want * 100)}%）` : `波動變化，持有比例 ${Math.round(cur * 100)}% → ${Math.round(want * 100)}%`;
        if (diff > 0) {
          const cost = buyCost(L[0], diff);
          trCash -= cost;
          trCost += cost;
          trShares += diff;
          trSince ??= D;
          trades.push({ date: D, book: 'trend', code: '00631L', name: '元大台灣50正2', side: 'buy', price: r2(L[0]), pnl: null, note: why });
        } else if (diff < 0) {
          const sell = -diff;
          const value = sellValue(L[0], sell, ETF_TAX);
          const basis = (trCost * sell) / trShares;
          trCash += value;
          trCost -= basis;
          trShares -= sell;
          if (!trShares) (trSince = null), (trCost = 0);
          trades.push({ date: D, book: 'trend', code: '00631L', name: '元大台灣50正2', side: 'sell', price: r2(L[0]), pnl: r2(value - basis), note: why });
        }
      }
    }

    // ---- 每天收盤的帳戶價值
    let stockVal = 0;
    for (const t of tranches) stockVal += t.cash;
    for (const p of tranches.flatMap((t) => t.pos)) stockVal += p.shares * (kOf(p.code).get(D)?.[3] ?? [...kOf(p.code).entries()].filter(([d]) => d <= D).at(-1)?.[1][3] ?? p.cost);
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
    ? { stocks: r5(last[2] / (CAPITAL * W.stocks) - 1), dayTrade: 0, trend: r5(last[4] / (CAPITAL * W.trend) - 1) }
    : { stocks: 0, dayTrade: 0, trend: 0 },
  // 同期間把 100 萬買加權指數放著
  benchmark: last ? r5(last[5] / CAPITAL - 1) : 0,
  maxDD: r5(maxDD),
  stats: { stocks: bookStat('stocks'), dayTrade: bookStat('dayTrade'), trend: bookStat('trend') },
  // 趨勢部位：目前持有什麼、下一個交易日該持有什麼（看最新收盤與 200 日均線）
  trend: (() => {
    const li = cal.length - 1;
    return { holding: trShares > 0, since: trSince, nextHold: aboveMa(li), nextWeight: r5(trendWeight(li)), vol20: r5(vol20[li]), volMed: r5(volMed[li + 1] ?? volMed[li]), close: r2(taiex[li][4]), ma: r2(maOf(li)), dist: r5(taiex[li][4] / maOf(li) - 1), asOf: cal[li] };
  })(),
  monthly,
  curve: equityRows,
  positions: [...tranches.flatMap((t) => t.pos).reduce((m, p) => {
    const o = m.get(p.code);
    if (o) (o.cost = (o.cost * o.shares + p.cost * p.shares) / (o.shares + p.shares)), (o.shares += p.shares), (o.paid += p.paid);
    else m.set(p.code, { ...p });
    return m;
  }, new Map<string, Pos>()).values()].map((p) => {
    const k = [...kOf(p.code).entries()].filter(([d]) => d <= lastDay).at(-1)?.[1];
    return { code: p.code, name: names[p.code] ?? '', shares: p.shares, cost: r2(p.cost), price: k ? r2(k[3]) : null, ret: k ? r5(k[3] / p.cost - 1) : null };
  }),
  heldSince: (() => {
    const xs = tranches.map((t) => t.since).filter((x): x is number => x != null);
    return xs.length ? cal[Math.min(...xs)] : null;
  })(),
  tranches: TRANCHES,
  sellOn: TRANCHES > 1 ? `每月 12 日後第一個交易日換其中一批（共 ${TRANCHES} 批輪流，每批抱 ${TRANCHES} 個月）` : '每月 12 日後第一個交易日換股',
  trades: trades.slice(-60).reverse(),
  tradeCount: trades.length,
};
writeFileSync(join(dir, process.env.PAPER_OUT ?? 'paper.json'), JSON.stringify(out));
console.log(`模擬帳戶：${out.days} 天（${out.start ?? '—'} ～ ${out.asOf ?? '—'}），總報酬 ${out.ret}，大盤 ${out.benchmark}，最大回落 ${out.maxDD}，交易 ${trades.length} 筆`);
console.log('  各部位：', JSON.stringify(out.books), JSON.stringify(out.stats));
