import type { EtfMeta, HoldingChange, HoldingChangeKind } from './types';

type BaseEtf = Omit<EtfMeta, 'changes' | 'rebalance'>;

/**
 * Mock ETF 清單。代號與名稱是真實的台股 ETF，股價、規模、配息、費用率與成分股權重
 * 只是量級上合理的示意值，不代表實際資料。成分股只列出在股票池內的前幾大。
 */
const BASE: BaseEtf[] = [
  {
    code: '0050', name: '元大台灣50', category: 'market', underlying: '臺灣 50 指數',
    prevClose: 195.6, avgTurnover20: 60, aum: 5200, expenseRatio: 0.36,
    dividendPerYear: 3.0, frequency: '半年', dividendYears: 20, fillRate: 100, holders: 100,
    holdings: [
      { code: '2330', weight: 48.5 }, { code: '2317', weight: 5.2 }, { code: '2454', weight: 4.6 },
      { code: '2308', weight: 2.5 }, { code: '2382', weight: 2.1 }, { code: '2881', weight: 1.9 },
      { code: '2891', weight: 1.7 }, { code: '3711', weight: 1.5 }, { code: '2882', weight: 1.4 },
      { code: '2303', weight: 1.3 },
    ],
  },
  {
    code: '006208', name: '富邦台50', category: 'market', underlying: '臺灣 50 指數',
    prevClose: 112.3, avgTurnover20: 8, aum: 1850, expenseRatio: 0.24,
    dividendPerYear: 2.5, frequency: '半年', dividendYears: 12, fillRate: 100, holders: 32,
    holdings: [
      { code: '2330', weight: 48.4 }, { code: '2317', weight: 5.2 }, { code: '2454', weight: 4.6 },
      { code: '2308', weight: 2.5 }, { code: '2382', weight: 2.1 }, { code: '2881', weight: 1.9 },
      { code: '2891', weight: 1.7 }, { code: '3711', weight: 1.5 },
    ],
  },
  {
    code: '0056', name: '元大高股息', category: 'dividend', underlying: '臺灣高股息指數',
    prevClose: 37.2, avgTurnover20: 35, aum: 4300, expenseRatio: 0.75,
    dividendPerYear: 2.6, frequency: '季', dividendYears: 18, fillRate: 75, holders: 110,
    holdings: [
      { code: '2382', weight: 4.2 }, { code: '3231', weight: 3.8 }, { code: '2357', weight: 3.5 },
      { code: '2324', weight: 3.3 }, { code: '2356', weight: 3.1 }, { code: '3034', weight: 3.0 },
      { code: '2379', weight: 2.8 }, { code: '2886', weight: 2.5 }, { code: '2301', weight: 2.4 },
    ],
  },
  {
    code: '00878', name: '國泰永續高股息', category: 'dividend', underlying: 'MSCI 臺灣 ESG 永續高股息精選 30 指數',
    prevClose: 22.5, avgTurnover20: 30, aum: 4000, expenseRatio: 0.48,
    dividendPerYear: 1.5, frequency: '季', dividendYears: 5, fillRate: 80, holders: 160,
    holdings: [
      { code: '2357', weight: 5.0 }, { code: '2382', weight: 4.6 }, { code: '3231', weight: 4.4 },
      { code: '2886', weight: 4.2 }, { code: '2891', weight: 4.0 }, { code: '2412', weight: 3.8 },
      { code: '1101', weight: 3.2 }, { code: '2880', weight: 3.0 }, { code: '5880', weight: 2.8 },
    ],
  },
  {
    code: '00919', name: '群益台灣精選高息', category: 'dividend', underlying: '臺灣精選高息指數',
    prevClose: 23.1, avgTurnover20: 40, aum: 3500, expenseRatio: 0.53,
    dividendPerYear: 2.2, frequency: '季', dividendYears: 3, fillRate: 65, holders: 90,
    holdings: [
      { code: '2603', weight: 10.0 }, { code: '2609', weight: 9.5 }, { code: '2303', weight: 9.0 },
      { code: '2454', weight: 6.5 }, { code: '2615', weight: 5.0 }, { code: '3034', weight: 4.0 },
      { code: '2379', weight: 3.5 },
    ],
  },
  {
    code: '00929', name: '復華台灣科技優息', category: 'dividend', underlying: '臺灣科技優息指數',
    prevClose: 19.0, avgTurnover20: 20, aum: 1700, expenseRatio: 0.6,
    dividendPerYear: 1.4, frequency: '月', dividendYears: 2, fillRate: 60, holders: 70,
    holdings: [
      { code: '2303', weight: 6.0 }, { code: '2454', weight: 5.5 }, { code: '3034', weight: 5.0 },
      { code: '2379', weight: 4.5 }, { code: '3231', weight: 4.0 }, { code: '2357', weight: 3.8 },
      { code: '3711', weight: 3.5 },
    ],
  },
  {
    code: '00940', name: '元大台灣價值高息', category: 'dividend', underlying: '臺灣價值高息指數',
    prevClose: 9.8, avgTurnover20: 25, aum: 1000, expenseRatio: 0.47,
    dividendPerYear: 0.6, frequency: '月', dividendYears: 1, fillRate: 55, holders: 75,
    holdings: [
      { code: '2603', weight: 8.0 }, { code: '2609', weight: 7.0 }, { code: '2615', weight: 5.0 },
      { code: '2886', weight: 4.5 }, { code: '2880', weight: 4.0 }, { code: '2002', weight: 3.5 },
    ],
  },
  {
    code: '00713', name: '元大台灣高息低波', category: 'dividend', underlying: '臺灣指數公司特選高股息低波動指數',
    prevClose: 55.4, avgTurnover20: 5, aum: 1500, expenseRatio: 0.66,
    dividendPerYear: 3.5, frequency: '季', dividendYears: 7, fillRate: 90, holders: 20,
    holdings: [
      { code: '2412', weight: 9.0 }, { code: '3045', weight: 6.5 }, { code: '4904', weight: 6.0 },
      { code: '2912', weight: 5.0 }, { code: '1216', weight: 4.5 }, { code: '2886', weight: 4.0 },
    ],
  },
  {
    code: '00881', name: '國泰台灣科技龍頭', category: 'theme', underlying: '臺灣科技龍頭指數',
    prevClose: 25.4, avgTurnover20: 6, aum: 420, expenseRatio: 0.53,
    dividendPerYear: 0.8, frequency: '半年', dividendYears: 4, fillRate: 100, holders: 25,
    holdings: [
      { code: '2330', weight: 30.0 }, { code: '2454', weight: 12.0 }, { code: '2317', weight: 10.0 },
      { code: '2308', weight: 5.0 }, { code: '2382', weight: 4.5 }, { code: '2345', weight: 3.0 },
    ],
  },
  {
    code: '00891', name: '中信關鍵半導體', category: 'theme', underlying: 'ICE FactSet 臺灣核心半導體指數',
    prevClose: 19.2, avgTurnover20: 8, aum: 300, expenseRatio: 0.6,
    dividendPerYear: 0.9, frequency: '季', dividendYears: 3, fillRate: 85, holders: 15,
    holdings: [
      { code: '2330', weight: 22.0 }, { code: '2454', weight: 18.0 }, { code: '2303', weight: 10.0 },
      { code: '3711', weight: 8.0 }, { code: '3034', weight: 6.0 }, { code: '2379', weight: 5.0 },
      { code: '3661', weight: 4.0 },
    ],
  },
  {
    code: '00892', name: '富邦台灣半導體', category: 'theme', underlying: 'ICE FactSet 臺灣 ESG 永續關鍵半導體指數',
    prevClose: 23.0, avgTurnover20: 5, aum: 200, expenseRatio: 0.55,
    dividendPerYear: 0.5, frequency: '半年', dividendYears: 4, fillRate: 100, holders: 8,
    holdings: [
      { code: '2330', weight: 25.0 }, { code: '2454', weight: 17.0 }, { code: '3711', weight: 9.0 },
      { code: '2303', weight: 8.0 }, { code: '6488', weight: 5.0 }, { code: '5274', weight: 4.0 },
    ],
  },
  {
    code: '00679B', name: '元大美債20年', category: 'bond', underlying: 'ICE 美國政府 20 年期以上債券指數',
    prevClose: 27.1, avgTurnover20: 15, aum: 1200, expenseRatio: 0.18,
    dividendPerYear: 1.2, frequency: '季', dividendYears: 7, fillRate: 70, holders: 15, holdings: [],
  },
  {
    code: '00937B', name: '群益ESG投等債20+', category: 'bond', underlying: 'ICE ESG 20 年期以上 BBB 級美元公司債指數',
    prevClose: 15.5, avgTurnover20: 10, aum: 1300, expenseRatio: 0.22,
    dividendPerYear: 0.85, frequency: '月', dividendYears: 2, fillRate: 60, holders: 12, holdings: [],
  },
  {
    code: '00687B', name: '國泰20年美債', category: 'bond', underlying: 'ICE 美國政府 20 年期以上債券指數',
    prevClose: 29.3, avgTurnover20: 6, aum: 600, expenseRatio: 0.2,
    dividendPerYear: 1.1, frequency: '季', dividendYears: 6, fillRate: 75, holders: 5, holdings: [],
  },
];

/** 最近 n 個交易日（不含今天，跳過週末），由新到舊。 */
function recentTradingDays(n: number, from = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(from);
  while (out.length < n) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const DAYS = recentTradingDays(5);

type Row = [kind: HoldingChangeKind, code: string, before: number, after: number];
const on = (date: string, rows: Row[]): HoldingChange[] => rows.map(([kind, code, before, after]) => ({ date, code, kind, before, after }));

/** 被動式 ETF：最近一次指數調整（模擬）。 */
const REBALANCE: Record<string, { schedule: string; last: string; next?: string; changes: HoldingChange[] }> = {
  '0050': {
    schedule: '每季調整（3、6、9、12 月）', last: '2026-09-18', next: '2026-12-18',
    changes: on('2026-09-18', [['add', '2345', 0, 0.9], ['add', '6669', 0, 0.8], ['remove', '2603', 1.0, 0], ['remove', '1101', 0.4, 0], ['increase', '2330', 47.2, 48.5]]),
  },
  '006208': {
    schedule: '每季調整（3、6、9、12 月）', last: '2026-09-18', next: '2026-12-18',
    changes: on('2026-09-18', [['add', '2345', 0, 0.9], ['add', '6669', 0, 0.8], ['remove', '2603', 1.0, 0], ['remove', '1101', 0.4, 0]]),
  },
  '0056': {
    schedule: '每半年調整（6、12 月）', last: '2026-06-19', next: '2026-12-18',
    changes: on('2026-06-19', [['add', '2301', 0, 2.4], ['add', '2886', 0, 2.5], ['remove', '2603', 3.0, 0], ['remove', '2609', 2.6, 0], ['increase', '2382', 3.1, 4.2], ['decrease', '3034', 3.8, 3.0]]),
  },
  '00878': {
    schedule: '每半年調整（5、11 月）', last: '2026-05-29', next: '2026-11-27',
    changes: on('2026-05-29', [['add', '5880', 0, 2.8], ['remove', '2615', 2.2, 0], ['increase', '2357', 4.1, 5.0], ['decrease', '2412', 4.6, 3.8]]),
  },
  '00919': {
    schedule: '每半年調整（5、12 月）', last: '2026-05-22', next: '2026-12-18',
    changes: on('2026-05-22', [['add', '2454', 0, 6.5], ['add', '2379', 0, 3.5], ['remove', '2382', 5.0, 0], ['increase', '2603', 7.5, 10.0]]),
  },
  '00929': {
    schedule: '每年調整（6 月）', last: '2026-06-15', next: '2027-06-15',
    changes: on('2026-06-15', [['add', '3711', 0, 3.5], ['remove', '2324', 3.0, 0], ['increase', '2303', 4.8, 6.0]]),
  },
  '00940': {
    schedule: '每半年調整（5、11 月）', last: '2026-05-20', next: '2026-11-19',
    changes: on('2026-05-20', [['add', '2002', 0, 3.5], ['decrease', '2880', 4.6, 4.0], ['increase', '2603', 6.5, 8.0]]),
  },
  '00713': {
    schedule: '每季調整（3、6、9、12 月）', last: '2026-09-18', next: '2026-12-18',
    changes: on('2026-09-18', [['add', '2912', 0, 5.0], ['remove', '1301', 2.8, 0], ['increase', '2412', 8.2, 9.0]]),
  },
  '00881': {
    schedule: '每半年調整（6、12 月）', last: '2026-06-19', next: '2026-12-18',
    changes: on('2026-06-19', [['add', '2345', 0, 3.0], ['remove', '2409', 1.5, 0], ['increase', '2454', 10.5, 12.0]]),
  },
  '00891': {
    schedule: '每季調整（3、6、9、12 月）', last: '2026-09-18', next: '2026-12-18',
    changes: on('2026-09-18', [['add', '3661', 0, 4.0], ['remove', '2408', 3.2, 0], ['decrease', '2330', 23.5, 22.0]]),
  },
  '00892': {
    schedule: '每半年調整（6、12 月）', last: '2026-06-19', next: '2026-12-18',
    changes: on('2026-06-19', [['add', '5274', 0, 4.0], ['remove', '2344', 2.5, 0]]),
  },
  '00679B': { schedule: '每月依指數調整債券組合', last: '2026-09-30', changes: [] },
  '00937B': { schedule: '每月依指數調整債券組合', last: '2026-09-30', changes: [] },
  '00687B': { schedule: '每月依指數調整債券組合', last: '2026-09-30', changes: [] },
};

/** 主動式 ETF：經理人自行選股，每日公告持股（模擬）。 */
const ACTIVE: EtfMeta[] = [
  {
    code: '00980A', name: '主動野村臺灣優選', category: 'active', underlying: '經理人主動選股（台股）',
    prevClose: 12.8, avgTurnover20: 12, aum: 180, expenseRatio: 0.79,
    dividendPerYear: 0.3, frequency: '半年', dividendYears: 1, fillRate: 100, holders: 18,
    holdings: [
      { code: '2330', weight: 9.5 }, { code: '2454', weight: 5.0 }, { code: '2308', weight: 4.5 }, { code: '2382', weight: 4.0 },
      { code: '3017', weight: 3.5 }, { code: '2345', weight: 3.2 }, { code: '1519', weight: 3.0 }, { code: '3661', weight: 2.8 },
    ],
    changes: [
      ...on(DAYS[0], [['increase', '2345', 2.6, 3.2], ['increase', '3017', 3.0, 3.5], ['decrease', '2454', 5.6, 5.0]]),
      ...on(DAYS[1], [['add', '1519', 0, 3.0], ['remove', '2603', 1.8, 0]]),
      ...on(DAYS[2], [['increase', '3661', 2.2, 2.8], ['decrease', '2308', 5.0, 4.5]]),
      ...on(DAYS[3], [['increase', '2382', 3.4, 4.0]]),
      ...on(DAYS[4], [['remove', '2409', 1.2, 0], ['increase', '2330', 9.0, 9.5]]),
    ],
  },
  {
    code: '00981A', name: '主動統一台股增長', category: 'active', underlying: '經理人主動選股（台股）',
    prevClose: 14.2, avgTurnover20: 25, aum: 450, expenseRatio: 0.89,
    dividendPerYear: 0, frequency: '年', dividendYears: 0, fillRate: 0, holders: 35,
    holdings: [
      { code: '2330', weight: 9.0 }, { code: '2382', weight: 6.0 }, { code: '6669', weight: 5.0 }, { code: '3017', weight: 4.5 },
      { code: '2345', weight: 4.0 }, { code: '2383', weight: 3.5 }, { code: '1513', weight: 3.0 }, { code: '3231', weight: 3.0 },
    ],
    changes: [
      ...on(DAYS[0], [['increase', '3017', 3.8, 4.5], ['increase', '1513', 2.4, 3.0], ['decrease', '3231', 3.6, 3.0]]),
      ...on(DAYS[1], [['increase', '2345', 3.3, 4.0], ['remove', '2609', 1.5, 0]]),
      ...on(DAYS[2], [['add', '2383', 0, 3.5], ['decrease', '2330', 9.6, 9.0]]),
      ...on(DAYS[3], [['increase', '6669', 4.4, 5.0]]),
      ...on(DAYS[4], [['remove', '2002', 1.0, 0], ['increase', '2382', 5.5, 6.0]]),
    ],
  },
  {
    code: '00982A', name: '主動群益台灣強棒', category: 'active', underlying: '經理人主動選股（台股）',
    prevClose: 11.6, avgTurnover20: 15, aum: 220, expenseRatio: 0.84,
    dividendPerYear: 0.25, frequency: '季', dividendYears: 1, fillRate: 90, holders: 22,
    holdings: [
      { code: '2330', weight: 9.8 }, { code: '2454', weight: 6.0 }, { code: '2308', weight: 5.0 }, { code: '2345', weight: 4.0 },
      { code: '3661', weight: 3.5 }, { code: '2059', weight: 3.0 }, { code: '5274', weight: 3.0 },
    ],
    changes: [
      ...on(DAYS[0], [['increase', '2345', 3.4, 4.0], ['add', '5274', 0, 3.0]]),
      ...on(DAYS[1], [['decrease', '2454', 6.5, 6.0]]),
      ...on(DAYS[2], [['increase', '3661', 2.9, 3.5], ['remove', '2615', 1.4, 0]]),
      ...on(DAYS[3], [['increase', '2059', 2.4, 3.0], ['decrease', '2308', 5.5, 5.0]]),
      ...on(DAYS[4], [['remove', '1101', 0.8, 0]]),
    ],
  },
  {
    code: '00984A', name: '主動安聯台灣高息', category: 'active', underlying: '經理人主動選股（台股高股息）',
    prevClose: 10.4, avgTurnover20: 8, aum: 120, expenseRatio: 0.84,
    dividendPerYear: 0.72, frequency: '月', dividendYears: 1, fillRate: 70, holders: 16,
    holdings: [
      { code: '2886', weight: 5.0 }, { code: '2891', weight: 4.5 }, { code: '2412', weight: 4.0 }, { code: '2382', weight: 4.0 },
      { code: '3231', weight: 3.5 }, { code: '2357', weight: 3.5 }, { code: '1216', weight: 3.0 }, { code: '2603', weight: 3.0 },
    ],
    changes: [
      ...on(DAYS[0], [['decrease', '2603', 3.6, 3.0], ['increase', '2891', 4.0, 4.5]]),
      ...on(DAYS[1], [['add', '1216', 0, 3.0]]),
      ...on(DAYS[2], [['increase', '2382', 3.5, 4.0], ['remove', '2609', 1.2, 0]]),
      ...on(DAYS[3], [['decrease', '2412', 4.5, 4.0]]),
      ...on(DAYS[4], [['increase', '2886', 4.4, 5.0]]),
    ],
  },
];

export const MOCK_ETFS: EtfMeta[] = [
  ...BASE.map((e) => {
    const r = REBALANCE[e.code];
    return { ...e, rebalance: r ? { schedule: r.schedule, last: r.last, next: r.next } : undefined, changes: r?.changes ?? [] };
  }),
  ...ACTIVE.map((e) => ({ ...e, rebalance: { schedule: '每日公告持股，經理人隨時調整', last: DAYS[0] } })),
];

export const ETF_CATEGORY_LABEL = { market: '市值型', dividend: '高股息', theme: '主題型', active: '主動式', bond: '債券型' } as const;
