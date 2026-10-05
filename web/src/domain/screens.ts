import type { Fundamentals, StockEvent, Universe } from '../data/types';
import type { MarketMetrics, StockMetrics } from './metrics';

/**
 * 五大核心選股
 *
 * 每個策略由幾個條件組成。條件用「即時股價 + 盤前的基本面 / 籌碼資料」判斷，
 * 所以本益比、殖利率、股價位階會隨盤中價格變動。
 *
 * - match = 'all'：所有條件都通過才算符合（例如低基期低本益比）。
 * - match = 'any'：任一條件通過就算符合（特殊事件，三種事件擇一即可）。
 * 只差一個條件的股票標為「接近」，方便觀察即將進入名單的標的。
 */

export type StrategyId = 'value' | 'growth' | 'income' | 'event' | 'technical';

export interface StockView {
  stock: StockMetrics;
  f: Fundamentals;
  /** 即時本益比。 */
  pe: number;
  /** 即時殖利率（%）。 */
  yieldPct: number;
  /** 近 3 年股價位階（0 = 最低，1 = 最高）。 */
  pos3y: number;
  /** 現價 ÷ 一年高點。 */
  toHigh52w: number;
  /** 目前本益比在自身近 5 年分布中的位置（0 = 最便宜，1 = 最貴）；沒有歷史資料時為 null。 */
  pePct: number | null;
  /** 同產業本益比中位數（有獲利的股票）；沒有時為 null。 */
  industryPe: number | null;
}

export interface Check {
  pass: boolean;
  value: string;
}

export interface Criterion {
  label: string;
  test: (v: StockView) => Check;
}

export interface Column {
  label: string;
  value: (v: StockView) => string;
}

export interface Strategy {
  id: StrategyId;
  name: string;
  en: string;
  idea: string;
  ideaDetail: string;
  pros: string;
  cons: string;
  fit: string;
  match: 'all' | 'any';
  criteria: Criterion[];
  /** 表格裡顯示的關鍵數字。 */
  columns: Column[];
  /** 同分時的排序依據（越大越前面）。 */
  rank: (v: StockView) => number;
}

export type ScreenStatus = 'match' | 'near' | 'miss';

export interface ScreenRow {
  view: StockView;
  checks: Check[];
  passed: number;
  status: ScreenStatus;
}

const EVENT_LABEL: Record<StockEvent, string> = {
  'guidance-up': '法說會展望調升',
  merger: '企業併購 / 資產活化',
  subsidy: '政策補貼',
};

const n1 = (v: number) => v.toFixed(1);
const signed1 = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
const hasEvent = (e: StockEvent) => (v: StockView): Check => ({ pass: v.f.events.includes(e), value: v.f.events.includes(e) ? '有' : '—' });

export const STRATEGIES: Strategy[] = [
  {
    id: 'value',
    name: '低基期低本益比',
    en: 'Value',
    idea: '買低賣高（撿便宜）',
    ideaDetail: '尋找明珠落塵的轉機股',
    pros: '安全邊際最高，下行風險低、補漲空間大',
    cons: '時間成本高，容易掉入不漲的「價值陷阱」',
    fit: '穩健型投資人，喜歡左側交易、逢低布局者',
    match: 'all',
    criteria: [
      {
        label: '股價處於自身近 3 年低檔（區間 30% 以下）',
        test: (v) => ({ pass: v.pos3y <= 0.3, value: `位階 ${Math.round(v.pos3y * 100)}%` }),
      },
      {
        // 不同產業的合理本益比差很多（金融 10 倍、半導體 20 倍以上都常見），
        // 所以和這檔股票自己的歷史比；沒有歷史時改和同產業比。
        label: '本益比處於自身近 5 年低檔（30% 分位以下）',
        test: (v) => {
          if (!(v.pe > 0)) return { pass: false, value: '虧損' };
          if (v.pePct !== null) return { pass: v.pePct <= 0.3, value: `${n1(v.pe)} 倍・分位 ${Math.round(v.pePct * 100)}%` };
          if (v.industryPe !== null) return { pass: v.pe < v.industryPe * 0.8, value: `${n1(v.pe)} 倍・產業 ${n1(v.industryPe)} 倍` };
          return { pass: v.pe < 12, value: `${n1(v.pe)} 倍` };
        },
      },
      {
        label: '連續多年配息、現金流為正',
        test: (v) => ({ pass: v.f.dividendYears >= 5 && v.f.fcfPositive, value: `${v.f.dividendYears} 年・${v.f.fcfPositive ? '正' : '負'}` }),
      },
    ],
    columns: [
      { label: '本益比', value: (v) => n1(v.pe) },
      { label: '本益比 5 年分位', value: (v) => (v.pePct === null ? '—' : `${Math.round(v.pePct * 100)}%`) },
      { label: '3 年位階', value: (v) => `${Math.round(v.pos3y * 100)}%` },
    ],
    rank: (v) => -(v.pePct ?? 1),
  },
  {
    id: 'growth',
    name: '動能與成長',
    en: 'Growth',
    idea: '買高賣更高',
    ideaDetail: '追逐產業風口與爆發力',
    pros: '賺錢速度最快，容易抓到當期超級飆股',
    cons: '波動極大，成長一旦減速股價易崩跌',
    fit: '積極型投資人，追求資產快速翻倍者',
    match: 'all',
    criteria: [
      { label: '近四季 EPS 年增 > 20%', test: (v) => ({ pass: v.f.epsYoY > 20, value: `${signed1(v.f.epsYoY)}%` }) },
      {
        label: '毛利率與營益率提升',
        test: (v) => ({ pass: v.f.grossMarginChg > 0 && v.f.opMarginChg > 0, value: `${signed1(v.f.grossMarginChg)} / ${signed1(v.f.opMarginChg)}` }),
      },
      { label: '股價接近一年新高（RS 強）', test: (v) => ({ pass: v.toHigh52w >= 0.95, value: `距高點 ${n1((1 - v.toHigh52w) * 100)}%` }) },
    ],
    columns: [
      { label: 'EPS 年增', value: (v) => `${signed1(v.f.epsYoY)}%` },
      { label: '毛利率變化', value: (v) => `${signed1(v.f.grossMarginChg)}` },
      { label: '距一年高', value: (v) => `${n1((1 - v.toHigh52w) * 100)}%` },
    ],
    rank: (v) => v.f.epsYoY,
  },
  {
    id: 'income',
    name: '高股息存股',
    en: 'Income',
    idea: '穩定護航',
    ideaDetail: '把股票當作會生息的資產',
    pros: '波動低、心態安穩，能提供穩定的被動收入',
    cons: '資產增長較慢，多數時候會錯失大牛市',
    fit: '退休族、小資族，重視防禦大於進攻者',
    match: 'all',
    criteria: [
      { label: '殖利率 > 5%', test: (v) => ({ pass: v.yieldPct > 5, value: `${n1(v.yieldPct)}%` }) },
      {
        label: '股利發放率 50%–80%',
        test: (v) => ({ pass: v.f.payoutRatio >= 50 && v.f.payoutRatio <= 80, value: `${Math.round(v.f.payoutRatio)}%` }),
      },
      { label: '連續 10 年以上配息', test: (v) => ({ pass: v.f.dividendYears >= 10, value: `${v.f.dividendYears} 年` }) },
    ],
    columns: [
      { label: '殖利率', value: (v) => `${n1(v.yieldPct)}%` },
      { label: '發放率', value: (v) => `${Math.round(v.f.payoutRatio)}%` },
      { label: '連續配息', value: (v) => `${v.f.dividendYears} 年` },
    ],
    rank: (v) => v.yieldPct,
  },
  {
    id: 'event',
    name: '特殊事件',
    en: 'Event-Driven',
    idea: '危機即轉機',
    ideaDetail: '賺取特定事件的市場價差',
    pros: '獲利爆發力強，有時可不受大盤跌勢影響',
    cons: '資訊不對稱嚴重，事件進展可能不如預期',
    fit: '專業交易員，喜歡解讀新聞與局勢者',
    match: 'any',
    criteria: [
      { label: EVENT_LABEL['guidance-up'], test: hasEvent('guidance-up') },
      { label: EVENT_LABEL.merger, test: hasEvent('merger') },
      { label: '政策補貼（如綠能、軍工）', test: hasEvent('subsidy') },
    ],
    columns: [
      { label: '事件', value: (v) => v.f.events.map((e) => EVENT_LABEL[e]).join('、') || '—' },
      { label: '成交 / 常態', value: (v) => `${(v.stock.share / Math.max(1e-9, v.stock.baseShare)).toFixed(2)} 倍` },
    ],
    rank: (v) => v.stock.share / Math.max(1e-9, v.stock.baseShare),
  },
  {
    id: 'technical',
    name: '籌碼與技術',
    en: 'Technical',
    idea: '跟隨聰明錢',
    ideaDetail: '價格與量能反應一切',
    pros: '操作週期短，資金運用效率最高',
    cons: '容易遇到主力騙線，或遭遇假突破',
    fit: '專職交易者，能嚴格執行停損的短線客',
    match: 'all',
    criteria: [
      { label: '法人（外資 / 投信）連買', test: (v) => ({ pass: v.f.instBuyDays >= 3, value: v.f.instBuyDays >= 0 ? `連買 ${v.f.instBuyDays} 天` : `連賣 ${-v.f.instBuyDays} 天` }) },
      { label: '千張大戶持股比率上升', test: (v) => ({ pass: v.f.bigHolderChg > 0, value: `${signed1(v.f.bigHolderChg)} 百分點` }) },
      {
        label: '均線多頭排列、帶量突破',
        test: (v) => {
          const p = v.stock.price;
          const aligned = p > v.f.ma5 && v.f.ma5 > v.f.ma20 && v.f.ma20 > v.f.ma60;
          const volume = v.stock.share >= v.stock.baseShare * 1.2;
          const breakout = p >= v.f.high20;
          return { pass: aligned && volume && breakout, value: `${aligned ? '多頭' : '未排列'}・${volume ? '量增' : '量平'}・${breakout ? '突破' : '未突破'}` };
        },
      },
    ],
    columns: [
      { label: '法人', value: (v) => (v.f.instBuyDays >= 0 ? `連買 ${v.f.instBuyDays}` : `連賣 ${-v.f.instBuyDays}`) },
      { label: '大戶變化', value: (v) => signed1(v.f.bigHolderChg) },
      { label: '量能', value: (v) => `${(v.stock.share / Math.max(1e-9, v.stock.baseShare)).toFixed(2)} 倍` },
    ],
    rank: (v) => v.f.instBuyDays + v.f.bigHolderChg * 2,
  },
];

export function strategyById(id: StrategyId): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

/** 目前本益比在 5 年分布中的位置：在五個分位點之間線性內插。 */
export function pePercentile(pe: number, band: Fundamentals['pe5y']): number | null {
  if (!band || !(pe > 0)) return null;
  const qs = [0, 0.25, 0.5, 0.75, 1];
  if (pe <= band[0]) return 0;
  if (pe >= band[4]) return 1;
  for (let i = 1; i < band.length; i++) {
    if (pe <= band[i]) return qs[i - 1] + ((pe - band[i - 1]) / Math.max(1e-9, band[i] - band[i - 1])) * 0.25;
  }
  return 1;
}

/** 各產業本益比中位數（只算有獲利的股票）。 */
export function industryPeMedians(metrics: MarketMetrics, universe: Universe): Map<string, number> {
  const byInd = new Map<string, number[]>();
  for (const meta of universe.stocks) {
    const s = metrics.stockByCode.get(meta.code);
    const f = meta.fundamentals;
    if (!s || !f || f.eps4q <= 0) continue;
    const arr = byInd.get(meta.industryId) ?? [];
    arr.push(s.price / f.eps4q);
    byInd.set(meta.industryId, arr);
  }
  const out = new Map<string, number>();
  for (const [id, arr] of byInd) {
    const sorted = arr.sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    out.set(id, sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2);
  }
  return out;
}

export function stockView(stock: StockMetrics, f: Fundamentals, industryPe: number | null = null): StockView {
  const range = Math.max(1e-9, f.high3y - f.low3y);
  const pe = f.eps4q > 0 ? stock.price / f.eps4q : Infinity;
  return {
    stock,
    f,
    pe,
    yieldPct: (f.dividend / stock.price) * 100,
    pos3y: Math.max(0, Math.min(1, (stock.price - f.low3y) / range)),
    toHigh52w: stock.price / Math.max(f.high52w, stock.high),
    pePct: pePercentile(pe, f.pe5y),
    industryPe,
  };
}

/** 跑一個策略：回傳至少通過一個條件的股票，符合 → 接近 → 其他，同級依策略排序。 */
export function runScreen(strategy: Strategy, metrics: MarketMetrics, universe: Universe): ScreenRow[] {
  const rows: ScreenRow[] = [];
  const indPe = industryPeMedians(metrics, universe);
  for (const meta of universe.stocks) {
    const stock = metrics.stockByCode.get(meta.code);
    if (!stock || !meta.fundamentals) continue;
    const view = stockView(stock, meta.fundamentals, indPe.get(meta.industryId) ?? null);
    const checks = strategy.criteria.map((c) => c.test(view));
    const passed = checks.filter((c) => c.pass).length;
    if (passed === 0) continue;
    const total = checks.length;
    const status: ScreenStatus =
      strategy.match === 'any' ? 'match' : passed === total ? 'match' : passed === total - 1 ? 'near' : 'miss';
    rows.push({ view, checks, passed, status });
  }
  const order: Record<ScreenStatus, number> = { match: 0, near: 1, miss: 2 };
  return rows.sort(
    (a, b) => order[a.status] - order[b.status] || b.passed - a.passed || strategy.rank(b.view) - strategy.rank(a.view),
  );
}
