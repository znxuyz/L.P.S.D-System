import type { Fundamentals, StockEvent } from '../data/types';
import type { Tilt } from './technicals';
import { createRng } from '../data/random';

/**
 * 新聞：關鍵字判斷利多 / 利空，以及模擬模式用的示意新聞。
 * 真實新聞之後接上來源後，直接用 classifyHeadline 標記即可。
 */

export interface NewsItem {
  date: string;
  title: string;
  source: string;
  tilt: Tilt;
}

const BULL = ['調升', '上修', '創新高', '成長', '大單', '擴產', '獲利', '加碼', '買超', '漲停', '受惠', '轉盈', '補助', '得標', '併購', '優於預期', '強勁', '利多'];
const BEAR = ['下修', '衰退', '虧損', '減產', '賣超', '跌停', '裁員', '砍單', '罰款', '延遲', '利空', '不如預期', '下滑', '調降', '疲弱', '訴訟', '停工'];

export function classifyHeadline(title: string): Tilt {
  const b = BULL.filter((w) => title.includes(w)).length;
  const s = BEAR.filter((w) => title.includes(w)).length;
  return b > s ? 'bull' : s > b ? 'bear' : 'neutral';
}

const EVENT_NEWS: Record<StockEvent, string[]> = {
  'guidance-up': ['{n}法說會調升全年營收展望，毛利率優於預期', '{n}接獲大單，外資上修目標價'],
  merger: ['{n}宣布併購案，擴大市場版圖', '{n}啟動資產活化，處分不動產挹注獲利'],
  subsidy: ['{n}受惠政策補助，綠能與國防訂單成長', '{n}得標公共工程，營運動能轉強'],
};

const GENERIC = [
  '{n}公布上月營收，年增 {g}%',
  '{n}股東會通過配息案',
  '{n}董事會決議資本支出計畫',
  '外資報告：{n}評等維持中立',
  '{n}產品報價下滑，短線獲利恐受壓',
  '{n}新產能明年開出，法人看好成長',
  '{n}遭客戶砍單傳聞，公司澄清',
];

/** 模擬模式的示意新聞：依代號固定產生，事件股會出現對應的新聞。 */
export function mockNews(code: string, name: string, f: Fundamentals | undefined, today: string): NewsItem[] {
  let seed = 0;
  for (const c of code) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rng = createRng(seed);
  const titles: string[] = [];
  for (const e of f?.events ?? []) titles.push(...EVENT_NEWS[e]);
  const pool = [...GENERIC];
  while (titles.length < 6 && pool.length) titles.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  const d = new Date(`${today}T00:00:00Z`);
  return titles.map((t, i) => {
    const title = t.replace('{n}', name).replace('{g}', String(Math.round(5 + rng() * 40)));
    d.setUTCDate(d.getUTCDate() - (i === 0 ? 0 : 1 + Math.floor(rng() * 3)));
    return { date: d.toISOString().slice(0, 10), title, source: '示意新聞', tilt: classifyHeadline(title) };
  });
}

/** 外部新聞與資料頁面的連結。 */
export function newsLinks(code: string): Array<{ label: string; href: string }> {
  return [
    { label: 'Yahoo 股市新聞', href: `https://tw.stock.yahoo.com/quote/${code}/news` },
    { label: '鉅亨網個股新聞', href: `https://www.cnyes.com/twstock/${code}/news` },
    { label: 'Goodinfo 個股資料', href: `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}` },
    { label: '公開資訊觀測站', href: 'https://mops.twse.com.tw/mops/' },
  ];
}
