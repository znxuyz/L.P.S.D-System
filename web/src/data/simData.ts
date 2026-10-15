/**
 * 模擬盤用的資料（部署時由 scripts/sim-daily.ts、sim-news.ts、names.ts 產生）：
 * - data/simday/<YYYY-MM>.json：每天全市場開高低收量與昨收（排行榜、偽即時行情）
 * - data/news/<年>.json：新聞標題
 * - data/names.json：股票名稱（含已下市）
 */

export type DayRow = [number, number, number, number, number, number];

export interface SimMonth {
  codes: string[];
  /** 日期 → 每檔一列 [開, 高, 低, 收, 張, 昨收] 或 0（沒成交）。 */
  days: Record<string, Array<DayRow | 0>>;
}

/** [日期, "HH:MM", 重要度 1～3, 標題] */
export type NewsItem = [string, string, 1 | 2 | 3, string];

const json = <T>(url: string): Promise<T | null> =>
  fetch(url, { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null);

let names: Promise<Record<string, string>> | null = null;
export function loadNames(): Promise<Record<string, string>> {
  names ??= json<Record<string, string>>('data/names.json').then((n) => n ?? {});
  return names;
}

const months = new Map<string, Promise<SimMonth | null>>();
export function loadSimMonth(month: string): Promise<SimMonth | null> {
  let p = months.get(month);
  if (!p) {
    p = json<SimMonth>(`data/simday/${month}.json`).then((j) => (j && Array.isArray(j.codes) ? j : null));
    months.set(month, p);
    // 最多留 3 個月在記憶體
    if (months.size > 3) months.delete(months.keys().next().value!);
  }
  return p;
}

const news = new Map<string, Promise<NewsItem[]>>();
export function loadNews(year: string): Promise<NewsItem[]> {
  let p = news.get(year);
  if (!p) {
    p = json<NewsItem[]>(`data/news/${year}.json`).then((j) => (Array.isArray(j) ? j : []));
    news.set(year, p);
  }
  return p;
}

/** 新聞時間（"09:00"）換成盤中第幾分鐘。 */
export function newsMinute(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h - 9) * 60 + m;
}

/**
 * 當時看得到的基本面（scripts/sim-fund.ts 產生）。
 * q：[季別, 公布日, 營收, 毛利, 營業利益, 稅後淨利, EPS, 營業現金流]（單季，千元；公布日之前看不到）
 * r：[日期, 近四季 EPS, 現金股利, 每股淨值]（有變化的日子才有一筆）
 */
export type FundQuarter = [string, string, number | null, number | null, number | null, number | null, number | null, number | null];
export interface SimFund {
  q: FundQuarter[];
  r: Array<[string, number | null, number | null, number | null]>;
}

const funds = new Map<string, Promise<SimFund | null>>();
export function loadSimFund(code: string): Promise<SimFund | null> {
  let p = funds.get(code);
  if (!p) {
    p = json<SimFund>(`data/simfund/${encodeURIComponent(code)}.json`).then((j) => (j && Array.isArray(j.q) && Array.isArray(j.r) ? j : null));
    funds.set(code, p);
    if (funds.size > 30) funds.delete(funds.keys().next().value!);
  }
  return p;
}

/** 模擬盤五大選股（scripts/sim-screen.ts 產生）：日期 → 策略 → [[代號, [欄位值…]]]（那一天收盤後的結果）。 */
export interface SimScreenMonth {
  days: Record<string, Record<string, Array<[string, string[]]>>>;
}
const screens = new Map<string, Promise<SimScreenMonth | null>>();
export function loadSimScreen(month: string): Promise<SimScreenMonth | null> {
  let p = screens.get(month);
  if (!p) {
    p = json<SimScreenMonth>(`data/simscreen/${month}.json`).then((j) => (j && typeof j.days === 'object' ? j : null));
    screens.set(month, p);
    if (screens.size > 4) screens.delete(screens.keys().next().value!);
  }
  return p;
}
