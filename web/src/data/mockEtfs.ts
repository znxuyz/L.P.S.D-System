import type { EtfMeta } from './types';

/**
 * Mock ETF 清單。代號與名稱是真實的台股 ETF，股價、規模、配息、費用率與成分股權重
 * 只是量級上合理的示意值，不代表實際資料。成分股只列出在股票池內的前幾大。
 */
export const MOCK_ETFS: EtfMeta[] = [
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

export const ETF_CATEGORY_LABEL = { market: '市值型', dividend: '高股息', theme: '主題型', bond: '債券型' } as const;
