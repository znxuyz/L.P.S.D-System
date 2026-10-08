import type { Candle } from './technicals';
import type { Bias } from './patterns';

/**
 * K 棒組合訊號：單根到三根 K 棒的經典型態（錘子、吞噬、晨星…）。
 * 需要「前面是上漲或下跌」的才有意義的型態，會先看前 5 天的走勢。
 */

export interface CandleSignal {
  i: number;
  name: string;
  bias: Bias;
  /** 這個訊號代表什麼、接下來要看什麼。 */
  note: string;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const upper = (c: Candle) => c.high - Math.max(c.open, c.close);
const lower = (c: Candle) => Math.min(c.open, c.close) - c.low;
const red = (c: Candle) => c.close > c.open;
const black = (c: Candle) => c.close < c.open;
const mid = (c: Candle) => (c.open + c.close) / 2;

export function detectCandles(c: Candle[], lookback = 60): CandleSignal[] {
  const out: CandleSignal[] = [];
  const start = Math.max(5, c.length - lookback);
  for (let i = start; i < c.length; i++) {
    const x = c[i];
    const p = c[i - 1];
    const pp = c[i - 2];
    const bodies = c.slice(Math.max(0, i - 20), i).map(body);
    const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(1, bodies.length) || x.close * 0.01;
    const trend = (c[i - 1].close - c[i - 5].close) / c[i - 5].close;
    const down = trend < -0.03;
    const up = trend > 0.03;
    const r = range(x);
    if (r <= 0) continue;
    const add = (name: string, bias: Bias, note: string) => out.push({ i, name, bias, note });

    // ---- 三根
    if (i >= 2) {
      const bigPP = body(pp) >= avgBody * 1.2;
      const smallP = body(p) <= body(pp) * 0.35;
      if (down && bigPP && black(pp) && smallP && Math.max(p.open, p.close) <= pp.close && red(x) && x.close > mid(pp)) {
        add('晨星', 'bull', '長黑後出現小 K（猶豫），再被長紅收復一半以上，底部反轉訊號；隔天守住長紅低點更確認');
        continue;
      }
      if (up && bigPP && red(pp) && smallP && Math.min(p.open, p.close) >= pp.close && black(x) && x.close < mid(pp)) {
        add('夜星', 'bear', '長紅後出現小 K，再被長黑吃掉一半以上，頭部反轉訊號；跌破長黑低點更確認');
        continue;
      }
      const three = [pp, p, x];
      if (three.every((k) => red(k) && body(k) >= avgBody * 0.8) && pp.close < p.close && p.close < x.close && p.open > pp.open && x.open > p.open && p.open <= pp.close && x.open <= p.close) {
        add('三白兵', 'bull', '連三根實體紅 K、一根比一根高，買盤穩定進場；若量能遞減或上影線變長，留意追高');
        continue;
      }
      if (three.every((k) => black(k) && body(k) >= avgBody * 0.8) && pp.close > p.close && p.close > x.close && p.open < pp.open && x.open < p.open && p.open >= pp.close && x.open >= p.close) {
        add('三黑鴉', 'bear', '連三根實體黑 K、一根比一根低，賣壓持續；常是轉弱的開始');
        continue;
      }
      // 跳空並列：跳空後兩根同色、開盤價接近的 K 棒，屬於延續型態
      if (red(p) && red(x) && p.low > pp.high && Math.abs(x.open - p.open) / p.open < 0.01 && Math.abs(body(x) - body(p)) <= body(p) * 0.5) {
        add('向上跳空並列紅K', 'bull', '跳空後連兩根開盤相近的紅 K，多方延續；缺口不被回補就維持強勢');
        continue;
      }
      if (black(p) && black(x) && p.high < pp.low && Math.abs(x.open - p.open) / p.open < 0.01 && Math.abs(body(x) - body(p)) <= body(p) * 0.5) {
        add('向下跳空並列黑K', 'bear', '跳空後連兩根開盤相近的黑 K，空方延續');
        continue;
      }
    }

    // ---- 兩根
    if (black(p) && red(x) && x.open <= p.close && x.close >= p.open && body(x) > body(p) * 1.05 && body(p) >= avgBody * 0.5) {
      add('多頭吞噬', down ? 'bull' : 'neutral', `紅 K 實體完全包住前一根黑 K${down ? '，出現在下跌後是止跌反轉訊號' : '，不在低檔時參考性較低'}`);
      continue;
    }
    if (red(p) && black(x) && x.open >= p.close && x.close <= p.open && body(x) > body(p) * 1.05 && body(p) >= avgBody * 0.5) {
      add('空頭吞噬', up ? 'bear' : 'neutral', `黑 K 實體完全包住前一根紅 K${up ? '，出現在上漲後是見頂訊號' : '，不在高檔時參考性較低'}`);
      continue;
    }
    if (body(p) >= avgBody * 1.5 && body(x) <= body(p) * 0.5 && Math.max(x.open, x.close) <= Math.max(p.open, p.close) && Math.min(x.open, x.close) >= Math.min(p.open, p.close)) {
      if (black(p) && down) {
        add('多頭孕線', 'bull', '長黑之後的小 K 被包在裡面，跌勢減緩；隔天收高才算轉強');
        continue;
      }
      if (red(p) && up) {
        add('空頭孕線', 'bear', '長紅之後的小 K 被包在裡面，漲勢減緩；隔天收低才算轉弱');
        continue;
      }
    }

    // ---- 單根
    const b = body(x);
    if (b <= r * 0.1) {
      add('十字星', up ? 'bear' : down ? 'bull' : 'neutral', `開收盤幾乎相同，多空拉鋸${up ? '；出現在漲多後要留意轉折' : down ? '；出現在跌深後可能止跌' : ''}`);
      continue;
    }
    if (lower(x) >= b * 2 && upper(x) <= Math.max(b * 0.3, r * 0.1)) {
      if (down) add('錘子線', 'bull', '長下影線代表低檔有買盤承接，止跌訊號；隔天收紅更確認');
      else if (up) add('吊人線', 'bear', '高檔出現長下影線，盤中曾大跌，留意買盤轉弱');
      else add('長下影線', 'neutral', '盤中殺低後被拉回，下方有支撐');
      continue;
    }
    if (upper(x) >= b * 2 && lower(x) <= Math.max(b * 0.3, r * 0.1)) {
      if (up) add('流星線', 'bear', '高檔長上影線，衝高後被賣回，上方賣壓重');
      else if (down) add('倒狀鎚子', 'bull', '低檔長上影線，買盤開始試探，需要隔天收高確認');
      continue;
    }
  }
  return out;
}

export const CANDLE_GUIDE: Array<{ name: string; bias: Bias; shape: string; then: string }> = [
  { name: '錘子線 / 吊人線', bias: 'neutral', shape: '小實體、長下影線（至少實體 2 倍）、幾乎沒有上影線', then: '低檔出現是止跌（錘子）；高檔出現是警訊（吊人）' },
  { name: '流星線 / 倒狀鎚子', bias: 'neutral', shape: '小實體、長上影線、幾乎沒有下影線', then: '高檔出現代表賣壓重（流星）；低檔出現是試探性買盤（倒鎚）' },
  { name: '十字星', bias: 'neutral', shape: '開盤 ≈ 收盤，上下都有影線', then: '多空拉鋸，出現在趨勢末端常是轉折' },
  { name: '多頭吞噬 / 空頭吞噬', bias: 'neutral', shape: '第二根 K 棒的實體完全包住第一根、顏色相反', then: '低檔多頭吞噬是反轉向上；高檔空頭吞噬是反轉向下' },
  { name: '多頭孕線 / 空頭孕線', bias: 'neutral', shape: '長 K 之後的小 K 被包在前一根實體裡', then: '原本的趨勢力道減弱，要等隔天方向確認' },
  { name: '晨星 / 夜星', bias: 'neutral', shape: '長 K → 小 K（猶豫）→ 反向長 K 收復一半以上', then: '經典的三根 K 反轉型態，晨星看漲、夜星看跌' },
  { name: '三白兵 / 三黑鴉', bias: 'neutral', shape: '連三根同色實體 K，一根比一根高（低）', then: '趨勢確立；三白兵要留意量能，三黑鴉常是轉弱開始' },
  { name: '跳空並列', bias: 'neutral', shape: '跳空後連兩根同色、開盤價相近的 K 棒', then: '延續型態，原本的方向繼續' },
];
