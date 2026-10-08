import { kd, macd, rsi, type Candle } from '../domain/technicals';
import type { ChipSeries } from '../data/chipSeries';

/**
 * K 線圖下方的副圖：成交量、MACD、KD、RSI、法人買賣超、千張大戶、相對強弱。
 * 所有數列都和整段日 K 對齊（同樣的索引），畫圖時再取顯示中的範圍。
 */

export type SubPane = 'vol' | 'macd' | 'kd' | 'rsi' | 'inst' | 'big' | 'rs';

export const SUB_LABEL: Record<SubPane, string> = {
  vol: '成交量',
  macd: 'MACD',
  kd: 'KD',
  rsi: 'RSI',
  inst: '法人買賣超',
  big: '千張大戶',
  rs: '相對強弱',
};

export interface SubSeries {
  name: string;
  color: string;
  kind: 'line' | 'bar';
  values: (number | null)[];
  /** 柱狀圖正負用不同顏色（例如 MACD 柱、法人買賣超）。 */
  signed?: boolean;
}

export interface SubData {
  series: SubSeries[];
  /** 參考線（例如 KD 的 20 / 80）。 */
  refs?: number[];
  /** 固定的縱軸範圍；沒有就用顯示範圍內的最大最小值。 */
  domain?: [number, number];
  /** 以顯示範圍第一個有值的點為 100 重新換算（相對強弱）。 */
  normalize?: boolean;
  unit: string;
  digits: number;
  /** 一句話說明怎麼看。 */
  hint: string;
}

const LINE_A = '#8ff0ff';
const LINE_B = '#ffd166';

export function buildSub(kind: SubPane, all: Candle[], chips: ChipSeries | null | undefined, taiex: Map<string, number> | null | undefined): SubData | string {
  const closes = all.map((c) => c.close);
  switch (kind) {
    case 'macd': {
      const m = macd(closes);
      return {
        series: [
          { name: 'MACD 柱', color: '', kind: 'bar', values: m.hist, signed: true },
          { name: 'DIF', color: LINE_A, kind: 'line', values: m.dif },
          { name: 'MACD', color: LINE_B, kind: 'line', values: m.dea },
        ],
        refs: [0],
        unit: '',
        digits: 2,
        hint: 'DIF 由下往上穿過 MACD（黃金交叉）偏多；柱狀體由負轉正代表動能轉強',
      };
    }
    case 'kd': {
      const s = kd(all);
      return {
        series: [
          { name: 'K', color: LINE_A, kind: 'line', values: s.k },
          { name: 'D', color: LINE_B, kind: 'line', values: s.d },
        ],
        refs: [20, 80],
        domain: [0, 100],
        unit: '',
        digits: 1,
        hint: 'K 在 20 以下黃金交叉偏多、80 以上死亡交叉偏空；80 以上持續稱為高檔鈍化',
      };
    }
    case 'rsi': {
      return {
        series: [
          { name: 'RSI 6', color: LINE_B, kind: 'line', values: rsi(closes, 6) },
          { name: 'RSI 14', color: LINE_A, kind: 'line', values: rsi(closes, 14) },
        ],
        refs: [30, 50, 70],
        domain: [0, 100],
        unit: '',
        digits: 1,
        hint: '70 以上過熱、30 以下超賣；50 以上屬於強勢區',
      };
    }
    case 'inst': {
      if (chips === undefined) return '法人資料載入中…';
      if (!chips?.inst.length) return '這檔股票沒有法人買賣超資料';
      const byDate = new Map(chips.inst);
      return {
        series: [{ name: '外資＋投信', color: '', kind: 'bar', values: all.map((c) => byDate.get(c.date) ?? null), signed: true }],
        refs: [0],
        unit: '張',
        digits: 0,
        hint: '外資加投信每天的買賣超；連續紅柱代表法人持續買進',
      };
    }
    case 'big': {
      if (chips === undefined) return '集保資料載入中…';
      if (!chips?.big.length) return '這檔股票還沒有千張大戶資料（集保資料仍在回補）';
      // 每週一筆，之間沿用上一週的值
      const weeks = [...chips.big].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      let k = -1;
      const values = all.map((c) => {
        while (k + 1 < weeks.length && weeks[k + 1][0] <= c.date) k++;
        return k >= 0 ? weeks[k][1] : null;
      });
      return {
        series: [{ name: '千張大戶持股', color: LINE_A, kind: 'line', values }],
        unit: '%',
        digits: 2,
        hint: '持股 1,000 張以上的股東占比，每週更新；持續上升代表籌碼往大戶集中',
      };
    }
    case 'rs': {
      if (taiex === undefined) return '加權指數資料載入中…';
      if (!taiex?.size) return '沒有加權指數資料';
      return {
        series: [{ name: '相對加權指數', color: LINE_A, kind: 'line', values: all.map((c) => (taiex.get(c.date) ? c.close / taiex.get(c.date)! : null)) }],
        refs: [100],
        normalize: true,
        unit: '',
        digits: 1,
        hint: '以畫面最左邊為 100：高於 100 代表這段期間漲得比大盤多（強於大盤）',
      };
    }
    default:
      return '';
  }
}
