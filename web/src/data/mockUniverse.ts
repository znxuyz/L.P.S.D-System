import { MOCK_ETFS } from './mockEtfs';
import { createRng } from './random';
import type { Fundamentals, IndustryMeta, StockEvent, StockMeta, Universe } from './types';

/**
 * Mock 股票池。代號與名稱是真實的台股，市值、股價只是量級上合理的示意值，
 * 不代表任何實際行情。
 */

/** 第五個欄位可以覆寫個股的週轉率（日均成交額 ÷ 市值）。 */
type Row = [code: string, name: string, marketCap: number, price: number, turnoverRate?: number];

interface IndustrySeed extends IndustryMeta {
  /** 日均成交額 ÷ 市值，決定這個產業平常的成交活躍度。 */
  turnoverRate: number;
  rows: Row[];
}

const SEEDS: IndustrySeed[] = [
  {
    id: 'semi', name: '半導體', short: '半導', turnoverRate: 0.0035,
    rows: [
      ['2330', '台積電', 280000, 1080, 0.0011], ['2454', '聯發科', 21000, 1320], ['3711', '日月光投控', 7200, 166],
      ['2303', '聯電', 5800, 46.5], ['2379', '瑞昱', 2900, 565], ['3034', '聯詠', 2600, 428],
      ['3661', '世芯-KY', 2500, 3150], ['5274', '信驊', 2400, 6450], ['6488', '環球晶', 1800, 380],
      ['5347', '世界', 1800, 108], ['3529', '力旺', 1700, 2280], ['2408', '南亞科', 1600, 52],
      ['3443', '創意', 1500, 1120], ['6415', '矽力*-KY', 1300, 360], ['2344', '華邦電', 1200, 27],
    ],
  },
  {
    id: 'comp', name: '電子零組件', short: '零組', turnoverRate: 0.012,
    rows: [
      ['2308', '台達電', 12000, 462], ['2327', '國巨', 3500, 170], ['2383', '台光電', 2600, 720],
      ['3037', '欣興', 2500, 165], ['2059', '川湖', 2400, 2530], ['3533', '嘉澤', 1200, 1320],
      ['3044', '健鼎', 1200, 230], ['8046', '南電', 900, 140], ['3324', '雙鴻', 700, 790],
      ['6269', '台郡', 300, 88],
    ],
  },
  {
    id: 'pc', name: '電腦週邊', short: '電腦', turnoverRate: 0.018,
    rows: [
      ['2382', '廣達', 11000, 285], ['2357', '華碩', 4300, 580], ['6669', '緯穎', 4000, 2300],
      ['3231', '緯創', 3800, 131], ['3017', '奇鋐', 2600, 670], ['2301', '光寶科', 2400, 104],
      ['2376', '技嘉', 1800, 285], ['2356', '英業達', 1600, 44], ['2324', '仁寶', 1300, 29.5],
      ['2353', '宏碁', 1200, 40],
    ],
  },
  {
    id: 'oe', name: '其他電子', short: '其電', turnoverRate: 0.006,
    rows: [
      ['2317', '鴻海', 30000, 216], ['2360', '致茂', 1500, 355], ['3036', '文曄', 1300, 130],
      ['2354', '鴻準', 1000, 70], ['6414', '樺漢', 450, 290],
    ],
  },
  {
    id: 'net', name: '通信網路', short: '通網', turnoverRate: 0.005,
    rows: [
      ['2412', '中華電', 10000, 129], ['2345', '智邦', 4500, 800], ['3045', '台灣大', 3700, 105],
      ['4904', '遠傳', 3000, 82], ['6285', '啟碁', 600, 155], ['5388', '中磊', 280, 110],
      ['3596', '智易', 260, 120],
    ],
  },
  {
    id: 'opto', name: '光電', short: '光電', turnoverRate: 0.012,
    rows: [
      ['3008', '大立光', 3000, 2250], ['3481', '群創', 1500, 15.2], ['2409', '友達', 1300, 13.6],
      ['6176', '瑞儀', 420, 95], ['3406', '玉晶光', 400, 400], ['2393', '億光', 200, 45],
    ],
  },
  {
    id: 'fin', name: '金融', short: '金融', turnoverRate: 0.0025,
    rows: [
      ['2881', '富邦金', 12000, 88], ['2882', '國泰金', 10000, 68], ['2891', '中信金', 8000, 41],
      ['2886', '兆豐金', 6000, 42], ['2884', '玉山金', 5000, 30], ['2885', '元大金', 4500, 35],
      ['5880', '合庫金', 4000, 26], ['2892', '第一金', 4000, 28.5], ['2880', '華南金', 3700, 29],
      ['2883', '凱基金', 2800, 16.5], ['2890', '永豐金', 2800, 24], ['2887', '台新金', 2500, 19],
    ],
  },
  {
    id: 'ship', name: '航運', short: '航運', turnoverRate: 0.015,
    rows: [
      ['2603', '長榮', 4500, 210], ['2609', '陽明', 2300, 66], ['2618', '長榮航', 2200, 36],
      ['2615', '萬海', 2000, 72], ['2610', '華航', 1400, 23], ['2606', '裕民', 400, 52],
      ['2637', '慧洋-KY', 400, 60],
    ],
  },
  {
    id: 'plastic', name: '塑化', short: '塑化', turnoverRate: 0.005,
    rows: [
      ['6505', '台塑化', 4200, 44], ['1303', '南亞', 3500, 44], ['1301', '台塑', 2400, 38],
      ['1326', '台化', 2000, 34], ['1304', '台聚', 200, 17], ['1308', '亞聚', 100, 17.5],
    ],
  },
  {
    id: 'steel', name: '鋼鐵', short: '鋼鐵', turnoverRate: 0.008,
    rows: [
      ['2002', '中鋼', 3500, 22.5], ['2027', '大成鋼', 700, 34], ['2006', '東和鋼鐵', 500, 68],
      ['2014', '中鴻', 300, 20], ['2031', '新光鋼', 150, 42],
    ],
  },
  {
    id: 'bio', name: '生技醫療', short: '生技', turnoverRate: 0.015,
    rows: [
      ['6446', '藥華藥', 1600, 520], ['1795', '美時', 1000, 360], ['4743', '合一', 600, 75],
      ['6472', '保瑞', 400, 610], ['4147', '中裕', 300, 60], ['1760', '寶齡富錦', 300, 110],
      ['6550', '北極星藥業-KY', 300, 30], ['4123', '晟德', 200, 45],
    ],
  },
  {
    id: 'mech', name: '電機機械', short: '電機', turnoverRate: 0.025,
    rows: [
      ['1519', '華城', 2000, 640], ['1590', '亞德客-KY', 2000, 1000], ['1504', '東元', 1200, 56],
      ['1503', '士電', 1200, 230], ['1513', '中興電', 1000, 200], ['2049', '上銀', 900, 250],
    ],
  },
  {
    id: 'trad', name: '傳產', short: '傳產', turnoverRate: 0.004,
    rows: [
      ['1216', '統一', 4300, 76], ['2207', '和泰車', 3500, 640], ['2912', '統一超', 2800, 270],
      ['1101', '台泥', 2000, 27], ['1402', '遠東新', 1700, 32], ['1102', '亞泥', 1500, 43],
      ['1476', '儒鴻', 1300, 480], ['9910', '豐泰', 1200, 140], ['9904', '寶成', 1000, 34],
    ],
  },
];

/** 各產業基本面的典型範圍：本益比、EPS 年增率（%）、殖利率（%）、連續配息年數、技術面偏多的機率。 */
interface Profile {
  pe: [number, number];
  yoy: [number, number];
  yld: [number, number];
  years: [number, number];
  bull: number;
}

const PROFILES: Record<string, Profile> = {
  semi: { pe: [14, 34], yoy: [-10, 60], yld: [1, 3.2], years: [5, 22], bull: 0.55 },
  comp: { pe: [12, 26], yoy: [-10, 45], yld: [2, 4.5], years: [6, 20], bull: 0.45 },
  pc: { pe: [11, 22], yoy: [0, 65], yld: [2, 5], years: [8, 22], bull: 0.6 },
  oe: { pe: [9, 18], yoy: [-5, 30], yld: [3, 5.5], years: [8, 20], bull: 0.5 },
  net: { pe: [15, 28], yoy: [-5, 45], yld: [2, 4.8], years: [10, 22], bull: 0.5 },
  opto: { pe: [7, 20], yoy: [-40, 30], yld: [2, 6], years: [3, 15], bull: 0.3 },
  fin: { pe: [8, 14], yoy: [-10, 30], yld: [4, 7], years: [10, 22], bull: 0.45 },
  ship: { pe: [3, 9], yoy: [-60, 40], yld: [3, 11], years: [2, 12], bull: 0.25 },
  plastic: { pe: [15, 40], yoy: [-50, 10], yld: [1, 4], years: [10, 30], bull: 0.2 },
  steel: { pe: [10, 30], yoy: [-40, 20], yld: [2, 5], years: [5, 25], bull: 0.25 },
  bio: { pe: [20, 60], yoy: [-20, 80], yld: [0, 2], years: [0, 8], bull: 0.4 },
  mech: { pe: [15, 35], yoy: [10, 80], yld: [1, 3], years: [5, 20], bull: 0.7 },
  trad: { pe: [10, 20], yoy: [-10, 15], yld: [3, 6], years: [10, 25], bull: 0.35 },
};

/** 示意用的特殊事件（模擬，不代表實際公告）。 */
const EVENTS: Record<string, StockEvent[]> = {
  '2330': ['guidance-up'],
  '3661': ['guidance-up'],
  '2345': ['guidance-up'],
  '2382': ['guidance-up'],
  '2887': ['merger'],
  '2890': ['merger'],
  '1402': ['merger'],
  '1519': ['subsidy'],
  '1513': ['subsidy'],
  '1503': ['subsidy'],
  '2002': ['subsidy'],
};

function fundamentalsFor(industryId: string, code: string, price: number, rng: () => number): Fundamentals {
  const p = PROFILES[industryId] ?? PROFILES.oe;
  const between = ([lo, hi]: [number, number]) => lo + (hi - lo) * rng();
  const pe = between(p.pe);
  const eps4q = price / pe;
  const yld = between(p.yld);
  const dividend = (price * yld) / 100;
  const low3y = price * (0.55 + rng() * 0.42);
  const high3y = price * (1.04 + rng() * 0.8);
  const bullish = rng() < p.bull;
  const ma5 = price * (bullish ? 0.975 + rng() * 0.02 : 0.99 + rng() * 0.04);
  const ma20 = ma5 * (bullish ? 0.95 + rng() * 0.04 : 0.99 + rng() * 0.05);
  const ma60 = ma20 * (bullish ? 0.9 + rng() * 0.08 : 0.98 + rng() * 0.06);
  return {
    eps4q,
    epsYoY: between(p.yoy),
    dividend,
    payoutRatio: Math.min(120, (dividend / eps4q) * 100),
    dividendYears: Math.round(between(p.years)),
    fcfPositive: rng() < 0.75,
    // 技術面偏多的股票，基本面也較常同步改善
    grossMarginChg: (rng() - (bullish ? 0.25 : 0.5)) * 6,
    opMarginChg: (rng() - (bullish ? 0.25 : 0.5)) * 5,
    low3y,
    high3y,
    high52w: price * (bullish ? 1.0 + rng() * 0.08 : 1.05 + rng() * 0.35),
    high20: price * (bullish ? 0.97 + rng() * 0.035 : 1.01 + rng() * 0.06),
    ma5,
    ma20,
    ma60,
    instBuyDays: Math.round((rng() - (bullish ? 0.25 : 0.6)) * 12),
    bigHolderChg: (rng() - (bullish ? 0.3 : 0.6)) * 3,
    events: EVENTS[code] ?? [],
    pe5y: peBand(code, pe),
  };
}

/**
 * 示意的 5 年本益比分布：每檔股票有自己的「常態本益比」，
 * 用獨立的亂數產生，不影響其他模擬數字。
 */
export function peBand(code: string, pe: number): Fundamentals['pe5y'] {
  let seed = 0;
  for (const c of code) seed = (seed * 131 + c.charCodeAt(0)) >>> 0;
  const r = createRng(seed ^ 0x5eed);
  // 常態本益比落在目前本益比的 0.75～1.35 倍：有的股票現在偏貴、有的偏便宜
  const center = pe * (0.75 + r() * 0.6);
  const q = (k: number) => Math.round(center * k * (0.96 + r() * 0.08) * 10) / 10;
  return [q(0.62), q(0.84), q(1), q(1.2), q(1.65)];
}

/**
 * 股票池以外的股票（個股分析頁可以查全市場）的示意基本面：以代號為種子，結果固定。
 * 有證交所的本益比、殖利率時，EPS 與股利會用真實數字換算。
 */
export function externalFundamentals(code: string, industryId: string, price: number, real?: { pe?: number; yieldPct?: number }): Fundamentals {
  let seed = 0;
  for (const c of code) seed = (seed * 131 + c.charCodeAt(0)) >>> 0;
  const f = fundamentalsFor(industryId, code, price, createRng(seed ^ 0xbeef));
  if (real?.pe && real.pe > 0) {
    f.eps4q = price / real.pe;
    f.pe5y = peBand(code, real.pe);
  }
  if (real?.yieldPct !== undefined && real.yieldPct >= 0) f.dividend = (price * real.yieldPct) / 100;
  f.payoutRatio = f.eps4q > 0 ? Math.min(120, (f.dividend / f.eps4q) * 100) : 0;
  return f;
}

/** 股票池 20 日平均成交額總和的目標值（億元），讓數字接近台股實際量級。 */
const TARGET_AVG_TURNOVER = 3400;

export function buildMockUniverse(seed = 20260930): Universe {
  const rng = createRng(seed);
  const industries: IndustryMeta[] = SEEDS.map(({ id, name, short }) => ({ id, name, short }));

  const raw = SEEDS.flatMap((ind) =>
    ind.rows.map(([code, name, marketCap, price, rate]) => ({
      code,
      name,
      industryId: ind.id,
      marketCap,
      prevClose: price,
      // 個股的活躍度在產業平均上下浮動，小型股通常週轉較快。
      rawTurnover: marketCap * (rate ?? ind.turnoverRate) * (0.6 + rng() * 0.8) * (marketCap < 1000 ? 1.6 : 1),
    })),
  );
  const scale = TARGET_AVG_TURNOVER / raw.reduce((sum, s) => sum + s.rawTurnover, 0);

  // 基本面用獨立的亂數序列，調整基本面時不會改變行情
  const fRng = createRng(seed + 1);
  const stocks: StockMeta[] = raw.map(({ rawTurnover, ...rest }) => ({
    ...rest,
    avgTurnover20: rawTurnover * scale,
    fundamentals: fundamentalsFor(rest.industryId, rest.code, rest.prevClose, fRng),
  }));

  return { industries, stocks, etfs: MOCK_ETFS, index: { name: '加權指數', prevClose: 23850.42 } };
}
