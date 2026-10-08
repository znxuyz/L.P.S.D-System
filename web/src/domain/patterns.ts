import type { Candle } from './technicals';
import { detectCandles } from './candlesticks';

/**
 * K 線型態自動辨識：先用「轉折點」（ZigZag）找出波段高低點，再從轉折點組合出常見型態，
 * 每個型態附上確認條件、目標價、失效價與後續情境。
 *
 * 型態判讀本來就有主觀成分，這裡用固定規則，結果只供參考。
 * 所有索引都是整段日 K 陣列裡的位置（i）。
 */

export type Bias = 'bull' | 'bear' | 'neutral';

export interface Pivot {
  i: number;
  price: number;
  kind: 'H' | 'L';
  /** 最後一個轉折還沒被反向走勢確認。 */
  tentative?: boolean;
}

export interface PatternLine {
  a: [number, number];
  b: [number, number];
  /** 往右延伸到圖的右邊（例如通道、頸線）。 */
  extend?: boolean;
  dash?: boolean;
  label?: string;
  /** 標籤寫在線的起點（左邊），例如費波納契各層，避免擠在右邊價格軸。 */
  labelAt?: 'start';
}

export interface PatternPoint {
  i: number;
  p: number;
  label: string;
  pos: 'above' | 'below';
}

export interface Scenario {
  when: string;
  then: string;
  bias: Bias;
}

/** 價格區間（例如尚未回補的缺口），從 i 畫到圖的右邊。 */
export interface PatternZone {
  i: number;
  lo: number;
  hi: number;
  label: string;
}

export interface Pattern {
  id:
    | 'channel'
    | 'double-bottom'
    | 'double-top'
    | 'hs-top'
    | 'hs-bottom'
    | 'triangle'
    | 'wave'
    | 'gap'
    | 'volume'
    | 'candle'
    | 'flag'
    | 'wedge'
    | 'broadening'
    | 'island'
    | 'rounding'
    | 'cup'
    | 'v-reversal'
    | 'triple'
    | 'fib'
    | 'vprofile'
    | 'boll'
    | 'deduct';
  name: string;
  bias: Bias;
  status: string;
  lines: PatternLine[];
  points: PatternPoint[];
  zones?: PatternZone[];
  /** 折線或曲線（例如圓弧、布林通道），每條是一串 [索引, 價格]。 */
  paths?: Array<{ pts: Array<[number, number]>; dash?: boolean; width?: number }>;
  /** 分價量表：每個價格區間的成交量（0～1 為相對最大值的比例）。 */
  hbars?: Array<{ lo: number; hi: number; v: number; poc?: boolean; inValue?: boolean }>;
  /** 小標記（例如 K 棒訊號、扣抵位置）：只畫一個符號＋短字。 */
  marks?: Array<{ i: number; p: number; label: string; pos: 'above' | 'below'; bias: Bias }>;
  /** 一句話說明目前的狀況。 */
  summary: string;
  scenarios: Scenario[];
}

const f2 = (v: number) => (v >= 100 ? v.toFixed(1) : v.toFixed(2));

/** 平均真實區間（ATR）。 */
export function atr(c: Candle[], n = 14): number {
  const tr = c.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - c[i].close), Math.abs(x.low - c[i].close)));
  const last = tr.slice(-n);
  return last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
}

/**
 * ZigZag 轉折點：價格從上一個極值反向走超過 threshold（比例）才算一個轉折。
 * 高點用最高價、低點用最低價；最後一個極值標為 tentative。
 */
export function zigzag(c: Candle[], threshold: number): Pivot[] {
  if (c.length < 3) return [];
  const out: Pivot[] = [];
  let dir: 1 | -1 | 0 = 0;
  let hi = { i: 0, p: c[0].high };
  let lo = { i: 0, p: c[0].low };
  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    if (dir === 0) {
      if (x.high > hi.p) hi = { i, p: x.high };
      if (x.low < lo.p) lo = { i, p: x.low };
      if (hi.p >= lo.p * (1 + threshold)) {
        // 第一段走勢：先出現低點就是往上，先出現高點就是往下
        if (lo.i < hi.i) {
          out.push({ i: lo.i, price: lo.p, kind: 'L' });
          dir = 1;
        } else {
          out.push({ i: hi.i, price: hi.p, kind: 'H' });
          dir = -1;
        }
      }
      continue;
    }
    if (dir === 1) {
      if (x.high > hi.p) hi = { i, p: x.high };
      else if (x.low <= hi.p * (1 - threshold)) {
        out.push({ i: hi.i, price: hi.p, kind: 'H' });
        dir = -1;
        lo = { i, p: x.low };
      }
    } else {
      if (x.low < lo.p) lo = { i, p: x.low };
      else if (x.high >= lo.p * (1 + threshold)) {
        out.push({ i: lo.i, price: lo.p, kind: 'L' });
        dir = 1;
        hi = { i, p: x.high };
      }
    }
  }
  // 最後一段還沒反轉的極值
  if (dir === 1) out.push({ i: hi.i, price: hi.p, kind: 'H', tentative: true });
  else if (dir === -1) out.push({ i: lo.i, price: lo.p, kind: 'L', tentative: true });
  return out;
}

/** 轉折門檻：約 2.2 倍 ATR，介於 4%～15%（波動大的股票門檻較高，避免小波動被當成轉折）。 */
export function swingThreshold(c: Candle[]): number {
  const last = c[c.length - 1].close;
  return Math.min(0.15, Math.max(0.04, (2.2 * atr(c)) / last));
}

/** 最小平方法直線：回傳 y = a + b·x。 */
function fit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (xs[k] - mx) * (ys[k] - my);
    den += (xs[k] - mx) ** 2;
  }
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
}

// ------------------------------------------------------------ 趨勢通道

function channel(c: Candle[], window = 60): Pattern | null {
  const n = Math.min(window, c.length);
  if (n < 20) return null;
  const start = c.length - n;
  const xs = Array.from({ length: n }, (_, k) => start + k);
  const { a, b } = fit(xs, xs.map((i) => c[i].close));
  const line = (i: number) => a + b * i;
  const up = Math.max(...xs.map((i) => c[i].high - line(i)));
  const dn = Math.min(...xs.map((i) => c[i].low - line(i)));
  const last = c.length - 1;
  const mid = line(last);
  const upper = mid + up;
  const lower = mid + dn;
  const slopePct = (b / mid) * 100;
  const kind = slopePct > 0.08 ? 'up' : slopePct < -0.08 ? 'down' : 'flat';
  const name = kind === 'up' ? '上升通道' : kind === 'down' ? '下降通道' : '水平區間（箱型）';
  const pos = (c[last].close - lower) / Math.max(1e-9, upper - lower);
  const where = pos >= 0.8 ? '靠近上緣' : pos <= 0.2 ? '靠近下緣' : '在通道中段';
  const bias: Bias = kind === 'up' ? 'bull' : kind === 'down' ? 'bear' : 'neutral';
  return {
    id: 'channel',
    name,
    bias,
    status: `近 ${n} 日`,
    lines: [
      { a: [start, line(start) + up], b: [last, upper], extend: true, label: '上緣' },
      { a: [start, line(start)], b: [last, mid], extend: true, dash: true },
      { a: [start, line(start) + dn], b: [last, lower], extend: true, label: '下緣' },
    ],
    points: [],
    summary: `近 ${n} 日的${name}，每天平均${slopePct >= 0 ? '上升' : '下降'} ${Math.abs(slopePct).toFixed(2)}%；目前股價${where}（通道 ${Math.round(pos * 100)}% 位置），上緣約 ${f2(upper)}、下緣約 ${f2(lower)}。`,
    scenarios:
      kind === 'flat'
        ? [
            { when: `收盤帶量突破箱頂 ${f2(upper)}`, then: `整理結束向上，目標約 ${f2(upper + (upper - lower))}（一個箱子的高度）`, bias: 'bull' },
            { when: '在箱頂與箱底之間來回', then: '區間操作：靠近箱底偏買、靠近箱頂偏賣', bias: 'neutral' },
            { when: `收盤跌破箱底 ${f2(lower)}`, then: `整理結束向下，目標約 ${f2(lower - (upper - lower))}`, bias: 'bear' },
          ]
        : [
            { when: `收盤站上通道上緣 ${f2(upper)}`, then: kind === 'down' ? '下降趨勢可能結束，留意是否轉成盤整或反轉向上' : '加速上漲（噴出），但也容易過熱，留意量能是否跟上', bias: 'bull' },
            { when: `回到下緣 ${f2(lower)} 附近不破`, then: kind === 'down' ? '下降通道裡的反彈點，力道通常有限' : '通道內的支撐買點，跌破才代表趨勢轉弱', bias: kind === 'down' ? 'neutral' : 'bull' },
            { when: `收盤跌破下緣 ${f2(lower)}`, then: kind === 'up' ? '上升趨勢被破壞，可能轉為盤整或下跌' : '弱勢延續、可能加速下跌', bias: 'bear' },
          ],
  };
}

// ------------------------------------------------------------ W 底 / M 頭

function doubleBottom(c: Candle[], piv: Pivot[], top: boolean): Pattern | null {
  const last = c.length - 1;
  const A = top ? 'H' : 'L';
  for (let k = piv.length - 1; k >= 2; k--) {
    const [p1, mid, p2] = [piv[k - 2], piv[k - 1], piv[k]];
    if (p1.kind !== A || p2.kind !== A || mid.kind === A) continue;
    if (p2.i < last - 80) break;
    const ref = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
    const similar = Math.abs(p1.price - p2.price) / ref <= 0.04;
    const depth = top ? (ref - mid.price) / ref : (mid.price - ref) / ref;
    if (!similar || depth < 0.06 || p2.i - p1.i < 8) continue;
    const neck = mid.price;
    const height = Math.abs(neck - ref);
    const target = top ? neck - height : neck + height;
    const stop = top ? ref * 1.03 : ref * 0.97;
    let status = '形成中';
    for (let i = p2.i + 1; i <= last; i++) {
      const cl = c[i].close;
      if (top ? cl > stop : cl < stop) {
        status = '已失效';
        break;
      }
      if (top ? cl < neck : cl > neck) status = '已確認（突破頸線）';
    }
    const name = top ? 'M 頭（雙重頂）' : 'W 底（雙重底）';
    const label = top ? ['左頭', '右頭'] : ['左腳', '右腳'];
    return {
      id: top ? 'double-top' : 'double-bottom',
      name,
      bias: status === '已失效' ? 'neutral' : top ? 'bear' : 'bull',
      status,
      lines: [{ a: [p1.i, neck], b: [last, neck], extend: true, dash: true, label: `頸線 ${f2(neck)}` }],
      points: [
        { i: p1.i, p: p1.price, label: label[0], pos: top ? 'above' : 'below' },
        { i: p2.i, p: p2.price, label: label[1], pos: top ? 'above' : 'below' },
      ],
      summary: `${c[p1.i].date} 與 ${c[p2.i].date} 兩次${top ? '在 ' + f2(ref) + ' 附近漲不上去' : '在 ' + f2(ref) + ' 附近跌不下去'}，中間${top ? '回落' : '反彈'}到頸線 ${f2(neck)}。目前${status}。`,
      scenarios: top
        ? [
            { when: `收盤跌破頸線 ${f2(neck)}`, then: `M 頭確認，滿足點約 ${f2(target)}（頸線減去頭部到頸線的距離）`, bias: 'bear' },
            { when: `跌破後反彈回測頸線不過`, then: '頸線由支撐變壓力，是常見的確認訊號', bias: 'bear' },
            { when: `收盤站上 ${f2(stop)}（右頭上方 3%）`, then: '型態失效，可能續創新高', bias: 'bull' },
          ]
        : [
            { when: `收盤站上頸線 ${f2(neck)}，最好伴隨量增`, then: `W 底確認，滿足點約 ${f2(target)}（頸線加上底部到頸線的距離）`, bias: 'bull' },
            { when: `突破後回測頸線不破`, then: '頸線由壓力變支撐，是較穩的進場位置', bias: 'bull' },
            { when: `收盤跌破 ${f2(stop)}（右腳下方 3%）`, then: '型態失效，可能續創新低', bias: 'bear' },
          ],
    };
  }
  return null;
}

// ------------------------------------------------------------ 頭肩頂 / 頭肩底

function headShoulders(c: Candle[], piv: Pivot[], top: boolean): Pattern | null {
  const last = c.length - 1;
  const A = top ? 'H' : 'L';
  for (let k = piv.length - 1; k >= 4; k--) {
    const [s1, n1, hd, n2, s2] = piv.slice(k - 4, k + 1);
    if (s1.kind !== A || hd.kind !== A || s2.kind !== A) continue;
    if (s2.i < last - 100) break;
    const higher = (a: number, b: number) => (top ? a > b : a < b);
    const headBeyond = top ? hd.price / Math.max(s1.price, s2.price) - 1 : 1 - hd.price / Math.min(s1.price, s2.price);
    if (!higher(hd.price, s1.price) || !higher(hd.price, s2.price) || headBeyond < 0.03) continue;
    if (Math.abs(s1.price - s2.price) / hd.price > 0.06) continue;
    const slope = (n2.price - n1.price) / (n2.i - n1.i);
    const neckAt = (i: number) => n1.price + slope * (i - n1.i);
    const height = Math.abs(hd.price - neckAt(hd.i));
    const neckNow = neckAt(last);
    const target = top ? neckNow - height : neckNow + height;
    let status = '形成中';
    for (let i = s2.i + 1; i <= last; i++) {
      const cl = c[i].close;
      if (top ? cl > hd.price : cl < hd.price) {
        status = '已失效';
        break;
      }
      if (top ? cl < neckAt(i) : cl > neckAt(i)) status = '已確認（突破頸線）';
    }
    const name = top ? '頭肩頂' : '頭肩底';
    const pos = top ? 'above' : 'below';
    return {
      id: top ? 'hs-top' : 'hs-bottom',
      name,
      bias: status === '已失效' ? 'neutral' : top ? 'bear' : 'bull',
      status,
      lines: [{ a: [n1.i, n1.price], b: [n2.i, n2.price], extend: true, dash: true, label: `頸線 ${f2(neckNow)}` }],
      points: [
        { i: s1.i, p: s1.price, label: '左肩', pos },
        { i: hd.i, p: hd.price, label: '頭', pos },
        { i: s2.i, p: s2.price, label: '右肩', pos },
      ],
      summary: `左肩 ${f2(s1.price)}、頭 ${f2(hd.price)}、右肩 ${f2(s2.price)}，頸線目前約 ${f2(neckNow)}。目前${status}。`,
      scenarios: top
        ? [
            { when: `收盤跌破頸線 ${f2(neckNow)}`, then: `頭肩頂確認，滿足點約 ${f2(target)}（頸線減去頭到頸線的距離）`, bias: 'bear' },
            { when: '右肩成交量明顯小於左肩', then: '買盤後繼無力，型態可信度較高', bias: 'bear' },
            { when: `收盤站上頭部 ${f2(hd.price)}`, then: '型態失效', bias: 'bull' },
          ]
        : [
            { when: `收盤站上頸線 ${f2(neckNow)}，最好伴隨量增`, then: `頭肩底確認，滿足點約 ${f2(target)}`, bias: 'bull' },
            { when: '右肩回測時量縮', then: '賣壓減輕，型態可信度較高', bias: 'bull' },
            { when: `收盤跌破頭部 ${f2(hd.price)}`, then: '型態失效', bias: 'bear' },
          ],
    };
  }
  return null;
}

// ------------------------------------------------------------ 三角收斂

function triangle(c: Candle[], piv: Pivot[]): Pattern | null {
  const last = c.length - 1;
  const recent = piv.filter((p) => p.i >= last - 90);
  const hs = recent.filter((p) => p.kind === 'H').slice(-3);
  const ls = recent.filter((p) => p.kind === 'L').slice(-3);
  if (hs.length < 2 || ls.length < 2) return null;
  const start = Math.min(hs[0].i, ls[0].i);
  if (last - start < 15) return null;
  const H = fit(hs.map((p) => p.i), hs.map((p) => p.price));
  const L = fit(ls.map((p) => p.i), ls.map((p) => p.price));
  const ref = c[last].close;
  const sh = (H.b / ref) * 100;
  const sl = (L.b / ref) * 100;
  const flat = 0.06;
  let kind: 'sym' | 'asc' | 'desc' | null = null;
  if (Math.abs(sh) < flat && sl > flat) kind = 'asc';
  else if (Math.abs(sl) < flat && sh < -flat) kind = 'desc';
  else if (sh < -flat && sl > flat) kind = 'sym';
  if (!kind) return null;
  const up = (i: number) => H.a + H.b * i;
  const dn = (i: number) => L.a + L.b * i;
  if (up(last) <= dn(last)) return null;
  const name = kind === 'asc' ? '上升三角形' : kind === 'desc' ? '下降三角形' : '對稱三角形（收斂）';
  const height = up(start) - dn(start);
  const cl = c[last].close;
  const status = cl > up(last) ? '已向上突破' : cl < dn(last) ? '已向下跌破' : '收斂中';
  const bias: Bias = status === '已向上突破' ? 'bull' : status === '已向下跌破' ? 'bear' : kind === 'asc' ? 'bull' : kind === 'desc' ? 'bear' : 'neutral';
  return {
    id: 'triangle',
    name,
    bias,
    status,
    lines: [
      { a: [start, up(start)], b: [last, up(last)], extend: true, label: '上緣' },
      { a: [start, dn(start)], b: [last, dn(last)], extend: true, label: '下緣' },
    ],
    points: [],
    summary: `${kind === 'asc' ? '高點持平、低點墊高，買方較積極' : kind === 'desc' ? '低點持平、高點下移，賣方較積極' : '高點下移、低點墊高，多空力道收斂'}。上緣約 ${f2(up(last))}、下緣約 ${f2(dn(last))}，目前${status}。`,
    scenarios: [
      { when: `收盤突破上緣 ${f2(up(last))}，量增`, then: `向上突破，量測目標約 ${f2(up(last) + height)}（三角形開口高度）`, bias: 'bull' },
      { when: `收盤跌破下緣 ${f2(dn(last))}`, then: `向下跌破，量測目標約 ${f2(dn(last) - height)}`, bias: 'bear' },
      { when: '量能持續萎縮、價格貼近頂點', then: '即將表態，突破方向通常就是接下來的走勢', bias: 'neutral' },
    ],
  };
}

// ------------------------------------------------------------ 波浪（艾略特）

function waves(piv: Pivot[]): Pattern | null {
  // 從最近的轉折往回找：0 起點後 1~5 浪，檢查三條鐵律
  for (const n of [5, 4, 3]) {
    if (piv.length < n + 1) continue;
    const seq = piv.slice(-(n + 1));
    const upTrend = seq[0].kind === 'L';
    const v = seq.map((p) => (upTrend ? p.price : -p.price));
    // 交錯高低
    if (!seq.every((p, k) => k === 0 || p.kind !== seq[k - 1].kind)) continue;
    const ok =
      v[1] > v[0] &&
      v[2] > v[0] && // 第 2 浪不跌破起點
      (n < 3 || v[3] > v[1]) &&
      (n < 4 || v[4] > v[1]) && // 第 4 浪不和第 1 浪重疊
      (n < 5 || v[5] > v[3]);
    if (!ok) continue;
    const len = (a: number, b: number) => Math.abs(v[b] - v[a]);
    if (n >= 5 && len(2, 3) < Math.min(len(0, 1), len(4, 5))) continue; // 第 3 浪不能最短
    if (n >= 3 && len(2, 3) < len(0, 1) * 0.6) continue;
    const pos: 'above' | 'below' = upTrend ? 'above' : 'below';
    const points: PatternPoint[] = seq.map((p, k) => ({
      i: p.i,
      p: p.price,
      label: String(k),
      pos: (k % 2 === 1) === upTrend ? pos : pos === 'above' ? 'below' : 'above',
    }));
    const lines: PatternLine[] = seq.slice(1).map((p, k) => ({ a: [seq[k].i, seq[k].price], b: [p.i, p.price] }));
    const lastTentative = seq[n].tentative;
    const cur = lastTentative ? n : n + 1;
    const dirWord = upTrend ? '上漲' : '下跌';
    const w1 = len(0, 1);
    const p0 = seq[0].price;
    const sign = upTrend ? 1 : -1;
    const nextNote: Record<number, string> = {
      2: '第 2 浪修正：通常回檔第 1 浪的 50%～61.8%，不會跌破起點',
      3: '第 3 浪：通常最長、最有力，常見長度為第 1 浪的 1.618 倍',
      4: '第 4 浪修正：通常較平緩，不應跌進第 1 浪的高點',
      5: '第 5 浪：最後一段推升，常出現價漲量縮的背離',
      6: `5 浪可能已走完，接下來容易出現 A-B-C 三段${upTrend ? '修正' : '反彈'}`,
    };
    const scen: Scenario[] = [];
    if (cur === 3) scen.push({ when: `${upTrend ? '站上' : '跌破'}第 1 浪端點 ${f2(seq[1].price)}`, then: `第 3 浪展開，參考目標 ${f2(p0 + sign * 1.618 * w1)}`, bias: upTrend ? 'bull' : 'bear' });
    if (cur === 4 || cur === 2) scen.push({ when: `修正守住 ${f2(cur === 2 ? p0 : seq[1].price)}`, then: `波浪結構維持，之後可望走第 ${cur + 1} 浪`, bias: upTrend ? 'bull' : 'bear' });
    if (cur === 5) scen.push({ when: `${upTrend ? '突破' : '跌破'}第 3 浪端點 ${f2(seq[3].price)}`, then: '第 5 浪延伸，但要留意量價背離', bias: upTrend ? 'bull' : 'bear' });
    if (cur >= 6) scen.push({ when: '出現 A-B-C 修正', then: `修正幅度常見為整段 5 浪的 38.2%～61.8%`, bias: upTrend ? 'bear' : 'bull' });
    scen.push({
      when: `${upTrend ? '跌破' : '站上'} ${f2(cur <= 3 ? p0 : seq[1].price)}`,
      then: '目前的波浪數法不成立，需要重新數',
      bias: 'neutral',
    });
    return {
      id: 'wave',
      name: `艾略特波浪（${dirWord}推動浪）`,
      bias: cur >= 6 ? 'neutral' : upTrend ? 'bull' : 'bear',
      status: cur >= 6 ? '5 浪可能已完成' : `可能在第 ${cur} 浪`,
      lines,
      points,
      summary: `${nextNote[Math.min(cur, 6)]}。波浪數法有主觀成分，同一段走勢常有不同數法。`,
      scenarios: scen,
    };
  }
  return null;
}


// ------------------------------------------------------------ 跳空缺口

export interface Gap {
  i: number;
  dir: 'up' | 'down';
  /** 缺口原本的上下緣。 */
  lo: number;
  hi: number;
  /** 還沒被回補的部分（完全回補時 lo ≥ hi）。 */
  openLo: number;
  openHi: number;
  filled: boolean;
  /** 回補的那一天。 */
  filledAt?: number;
  kind: '突破缺口' | '中繼缺口' | '竭盡缺口' | '普通缺口';
  volRatio: number;
}

const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

/** 找出跳空缺口與回補狀態。缺口太小（< 0.3%）忽略。 */
export function findGaps(c: Candle[], lookback = 120): Gap[] {
  const out: Gap[] = [];
  for (let i = Math.max(1, c.length - lookback); i < c.length; i++) {
    const prev = c[i - 1];
    const cur = c[i];
    const up = cur.low > prev.high * 1.003;
    const down = cur.high < prev.low * 0.997;
    if (!up && !down) continue;
    const lo = up ? prev.high : cur.high;
    const hi = up ? cur.low : prev.low;
    let openLo = lo;
    let openHi = hi;
    let filledAt: number | undefined;
    for (let j = i + 1; j < c.length; j++) {
      // 往上的缺口被往下的價格回補；往下的缺口被往上的價格回補
      if (up) openHi = Math.min(openHi, c[j].low);
      else openLo = Math.max(openLo, c[j].high);
      if (openLo >= openHi) {
        filledAt = j;
        break;
      }
    }
    const vol20 = avg(c.slice(Math.max(0, i - 20), i).map((x) => x.volume));
    const volRatio = vol20 > 0 ? cur.volume / vol20 : 1;
    const win = c.slice(Math.max(0, i - 20), i);
    const rangeHi = Math.max(...win.map((x) => x.high));
    const rangeLo = Math.min(...win.map((x) => x.low));
    // 缺口前一段的漲跌幅，用來分辨中繼（趨勢中途）與竭盡（走了一大段之後）
    const before = c[Math.max(0, i - 30)].close;
    const run = (prev.close - before) / before;
    let kind: Gap['kind'] = '普通缺口';
    const breaks = up ? cur.low > rangeHi : cur.high < rangeLo;
    const prior = up ? run : -run;
    if (filledAt !== undefined && filledAt - i <= 5 && prior > 0.2) kind = '竭盡缺口';
    else if (breaks && prior < 0.1 && volRatio >= 1.3) kind = '突破缺口';
    else if (prior >= 0.1) kind = '中繼缺口';
    out.push({ i, dir: up ? 'up' : 'down', lo, hi, openLo, openHi, filled: filledAt !== undefined, filledAt, kind, volRatio });
  }
  return out;
}

function gaps(c: Candle[]): Pattern | null {
  const all = findGaps(c);
  if (!all.length) return null;
  const last = c.length - 1;
  const close = c[last].close;
  const open = all.filter((g) => !g.filled);
  const recentFilled = all.filter((g) => g.filled && g.filledAt! >= last - 20);
  // 圖上只畫還沒回補、離現價最近的 3 個缺口（30% 以內）
  const dist = (g: Gap) => Math.min(Math.abs(g.openLo - close), Math.abs(g.openHi - close)) / close;
  const shown = open
    .filter((g) => dist(g) < 0.3)
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, 3);
  const below = shown.filter((g) => g.openHi <= close).sort((a, b) => b.openHi - a.openHi)[0];
  const above = shown.filter((g) => g.openLo >= close).sort((a, b) => a.openLo - b.openLo)[0];
  const newest = all[all.length - 1];
  const fresh = newest.i >= last - 3 ? newest : null;
  let bias: Bias = 'neutral';
  if (fresh && !fresh.filled) bias = fresh.dir === 'up' ? 'bull' : 'bear';
  else if (below && !above) bias = 'bull';
  else if (above && !below) bias = 'bear';
  const word = (g: Gap) => `${g.dir === 'up' ? '向上' : '向下'}${g.kind}（${c[g.i].date.slice(5).replace('-', '/')}，${f2(g.openLo)}～${f2(g.openHi)}）`;
  const parts: string[] = [];
  if (fresh) parts.push(`最近出現${word(fresh)}，當天量為均量 ${fresh.volRatio.toFixed(1)} 倍${fresh.filled ? '，已回補' : ''}`);
  parts.push(`近半年共 ${all.length} 個缺口，${open.length} 個還沒回補`);
  if (recentFilled.length) parts.push(`近 20 日回補了 ${recentFilled.length} 個`);
  const scen: Scenario[] = [];
  if (below)
    scen.push(
      { when: `回測下方缺口 ${f2(below.openLo)}～${f2(below.openHi)} 不補`, then: '缺口成為支撐，多方仍強', bias: 'bull' },
      { when: `跌破 ${f2(below.openLo)}（缺口完全回補）`, then: below.kind === '突破缺口' ? '突破失敗，常見回到原本的整理區間' : '支撐失守，短線轉弱', bias: 'bear' },
    );
  if (above)
    scen.push(
      { when: `反彈到上方缺口 ${f2(above.openLo)}～${f2(above.openHi)} 過不去`, then: '缺口成為壓力，反彈有限', bias: 'bear' },
      { when: `站上 ${f2(above.openHi)}（缺口完全回補）`, then: '套牢區被消化，壓力減輕', bias: 'bull' },
    );
  if (fresh && !fresh.filled && fresh.kind === '突破缺口')
    scen.push({ when: '三天內不回補', then: '突破缺口成立，常是一段行情的起點', bias: fresh.dir === 'up' ? 'bull' : 'bear' });
  if (!scen.length) scen.push({ when: '出現新的跳空', then: '帶量且三天內不回補較可信；缺口很快被回補常是假突破', bias: 'neutral' });
  return {
    id: 'gap',
    name: '跳空缺口',
    bias,
    status: open.length ? `${open.length} 個未回補` : '都已回補',
    lines: [],
    points: [],
    zones: shown.map((g) => ({ i: g.i, lo: g.openLo, hi: g.openHi, label: `${g.dir === 'up' ? '↑' : '↓'}缺口` })),
    summary: parts.join('；') + '。',
    scenarios: scen,
  };
}

// ------------------------------------------------------------ 量價關係

/** OBV（能量潮）：收漲加量、收跌減量。 */
export function obv(c: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < c.length; i++) out.push(out[i - 1] + Math.sign(c[i].close - c[i - 1].close) * c[i].volume);
  return out;
}

function volumePrice(c: Candle[]): Pattern | null {
  if (c.length < 40) return null;
  const last = c.length - 1;
  const vol20 = avg(c.slice(-21, -1).map((x) => x.volume));
  if (!(vol20 > 0)) return null;
  const v5 = avg(c.slice(-5).map((x) => x.volume));
  const vPrev = avg(c.slice(-10, -5).map((x) => x.volume));
  const p5 = (c[last].close - c[last - 5].close) / c[last - 5].close;
  const volUp = v5 > vPrev * 1.15;
  const volDown = v5 < vPrev * 0.85;
  const priceUp = p5 > 0.01;
  const priceDown = p5 < -0.01;
  let rel = '價量持平';
  let bias: Bias = 'neutral';
  let relNote = '價格與成交量都沒有明顯變化';
  if (priceUp && volUp) [rel, bias, relNote] = ['價漲量增', 'bull', '上漲有量能支持，屬於健康的攻擊'];
  else if (priceUp && volDown) [rel, bias, relNote] = ['價漲量縮', 'neutral', '漲勢缺乏追價，留意上漲動能減弱（量價背離）'];
  else if (priceDown && volUp) [rel, bias, relNote] = ['價跌量增', 'bear', '賣壓湧出，短線偏弱'];
  else if (priceDown && volDown) [rel, bias, relNote] = ['價跌量縮', 'neutral', '賣壓減輕，屬於量縮整理，止跌要看能否放量轉強'];

  const points: PatternPoint[] = [];
  const notes: string[] = [];
  const scen: Scenario[] = [];
  // 近 10 日的爆量 K 棒
  for (let i = last - 9; i <= last; i++) {
    const base = avg(c.slice(Math.max(0, i - 20), i).map((x) => x.volume));
    const ratio = base > 0 ? c[i].volume / base : 1;
    if (ratio < 2.5) continue;
    const body = (c[i].close - c[i].open) / c[i].open;
    const kind = body >= 0.03 ? '爆量長紅' : body <= -0.03 ? '爆量長黑' : '爆量';
    points.push({ i, p: c[i].high, label: kind.replace('爆量', '') || '爆量', pos: 'above' });
    notes.push(`${c[i].date.slice(5).replace('-', '/')} ${kind}（均量 ${ratio.toFixed(1)} 倍）`);
    const hi20 = Math.max(...c.slice(Math.max(0, i - 20), i).map((x) => x.high));
    if (kind === '爆量長黑' && c[i].high >= hi20 * 0.97) scen.push({ when: `${c[i].date.slice(5).replace('-', '/')} 高檔爆量長黑的低點 ${f2(c[i].low)} 被跌破`, then: '高檔出貨訊號確認，短線容易回檔', bias: 'bear' });
    if (kind === '爆量長紅' && c[i].close >= hi20) scen.push({ when: `守住 ${c[i].date.slice(5).replace('-', '/')} 爆量長紅的低點 ${f2(c[i].low)}`, then: '帶量突破有效，主力成本區形成支撐', bias: 'bull' });
  }
  // 頂背離：創 20 日新高，但量比前一個高點時少
  const closes = c.map((x) => x.close);
  const hi20 = Math.max(...closes.slice(-21, -1));
  if (c[last].close > hi20) {
    const prevHighIdx = closes.slice(-60, -10).reduce((best, v, k, arr) => (v > arr[best] ? k : best), 0) + c.length - 60;
    const vNow = avg(c.slice(-3).map((x) => x.volume));
    const vThen = avg(c.slice(Math.max(0, prevHighIdx - 1), prevHighIdx + 2).map((x) => x.volume));
    if (vThen > 0 && vNow < vThen * 0.7) {
      notes.push('價格創 20 日新高，但量比前波高點少 30% 以上（量價背離）');
      scen.push({ when: '新高後量能持續萎縮', then: '追價意願不足，容易形成假突破', bias: 'bear' });
    }
  }
  // OBV 和價格的方向（近 20 日）
  const o = obv(c);
  const oChg = o[last] - o[last - 20];
  const pChg = c[last].close - c[last - 20].close;
  if (pChg > 0 && oChg < 0) notes.push('近 20 日價格上漲但 OBV 下降，資金沒有跟進');
  else if (pChg < 0 && oChg > 0) notes.push('近 20 日價格下跌但 OBV 上升，可能有資金逢低承接');
  const lowVol = v5 < vol20 * 0.6;
  if (lowVol) notes.push(`近 5 日均量只有 20 日均量的 ${Math.round((v5 / vol20) * 100)}%，量縮整理`);
  if (lowVol) scen.push({ when: '量縮後出現帶量長紅', then: '整理結束、表態向上的機率提高', bias: 'bull' });
  if (!scen.length)
    scen.push(
      { when: '價漲量增延續', then: '趨勢健康，可續抱', bias: 'bull' },
      { when: '價漲量縮、或高檔爆量長黑', then: '漲勢可能進入尾聲', bias: 'bear' },
    );
  return {
    id: 'volume',
    name: '量價分析',
    bias,
    status: rel,
    lines: [],
    points,
    summary: `近 5 日${rel}：${relNote}。${notes.length ? notes.join('；') + '。' : ''}`,
    scenarios: scen,
  };
}

// ------------------------------------------------------------ 楔形 / 擴散喇叭

function wedges(c: Candle[], piv: Pivot[]): Pattern | null {
  const last = c.length - 1;
  const recent = piv.filter((p) => p.i >= last - 90);
  const hs = recent.filter((p) => p.kind === 'H').slice(-3);
  const ls = recent.filter((p) => p.kind === 'L').slice(-3);
  if (hs.length < 2 || ls.length < 2) return null;
  const start = Math.min(hs[0].i, ls[0].i);
  if (last - start < 15) return null;
  const H = fit(hs.map((p) => p.i), hs.map((p) => p.price));
  const L = fit(ls.map((p) => p.i), ls.map((p) => p.price));
  const ref = c[last].close;
  const sh = (H.b / ref) * 100;
  const sl = (L.b / ref) * 100;
  const flat = 0.06;
  const up = (i: number) => H.a + H.b * i;
  const dn = (i: number) => L.a + L.b * i;
  const cl = c[last].close;
  const lines: PatternLine[] = [
    { a: [start, up(start)], b: [last, up(last)], extend: true, label: '上緣' },
    { a: [start, dn(start)], b: [last, dn(last)], extend: true, label: '下緣' },
  ];
  if (sh > flat && sl < -flat) {
    return {
      id: 'broadening',
      name: '擴散喇叭型',
      bias: 'neutral',
      status: '震盪加劇',
      lines,
      points: [],
      summary: `高點越來越高、低點越來越低，波動放大、多空都不穩定，常出現在頭部區。上緣約 ${f2(up(last))}、下緣約 ${f2(dn(last))}。`,
      scenarios: [
        { when: `跌破下緣 ${f2(dn(last))}`, then: '喇叭頂確認，下跌力道通常不小', bias: 'bear' },
        { when: `站上上緣 ${f2(up(last))}`, then: '少見的向上突破，但波動仍大', bias: 'bull' },
        { when: '在上下緣之間來回', then: '不適合追價，等方向明確', bias: 'neutral' },
      ],
    };
  }
  const rising = sh > flat && sl > flat && sl > sh;
  const falling = sh < -flat && sl < -flat && sh < sl;
  if (!rising && !falling || up(last) <= dn(last)) return null;
  const status = cl > up(last) ? '已向上突破' : cl < dn(last) ? '已向下跌破' : '收斂中';
  return {
    id: 'wedge',
    name: rising ? '上升楔形' : '下降楔形',
    bias: rising ? (status === '已向上突破' ? 'bull' : 'bear') : status === '已向下跌破' ? 'bear' : 'bull',
    status,
    lines,
    points: [],
    summary: rising
      ? `高點、低點都在墊高，但低點墊高得更快、越收越窄，上漲力道在減弱，通常向下跌破。目前${status}。`
      : `高點、低點都在下移，但高點下移得更快、越收越窄，跌勢在減緩，通常向上突破。目前${status}。`,
    scenarios: rising
      ? [
          { when: `跌破下緣 ${f2(dn(last))}`, then: '上升楔形確認，常回到楔形起漲點附近', bias: 'bear' },
          { when: `帶量站上上緣 ${f2(up(last))}`, then: '型態失效，反而加速上漲', bias: 'bull' },
        ]
      : [
          { when: `站上上緣 ${f2(up(last))}`, then: '下降楔形確認，常反彈回楔形起跌點附近', bias: 'bull' },
          { when: `跌破下緣 ${f2(dn(last))}`, then: '型態失效，跌勢延續', bias: 'bear' },
        ],
  };
}

// ------------------------------------------------------------ 旗形 / 三角旗

function flags(c: Candle[]): Pattern | null {
  const last = c.length - 1;
  // 旗桿：近 35 天內，15 天以內漲跌 15% 以上；旗面：之後 5～20 天的整理
  for (let end = last - 5; end >= Math.max(15, last - 25); end--) {
    for (const dir of [1, -1] as const) {
      let s = end;
      for (let k = end - 1; k >= end - 15 && k >= 0; k--) if (dir * (c[k].close - c[s].close) < 0) s = k;
      const pole = (c[end].close - c[s].close) / c[s].close;
      if (dir * pole < 0.15 || end - s < 3) continue;
      const body = c.slice(end + 1);
      if (body.length < 5 || body.length > 20) continue;
      const hi = Math.max(...body.map((x) => x.high));
      const lo = Math.min(...body.map((x) => x.low));
      const poleLen = Math.abs(c[end].close - c[s].close);
      if (hi - lo > poleLen * 0.5) continue;
      // 旗面不能吐回太多
      if (dir === 1 ? lo < c[end].close - poleLen * 0.5 : hi > c[end].close + poleLen * 0.5) continue;
      const xs = body.map((_, k) => end + 1 + k);
      const H = fit(xs, body.map((x) => x.high));
      const L = fit(xs, body.map((x) => x.low));
      const pennant = H.b < 0 && L.b > 0;
      const cl = c[last].close;
      const top = H.a + H.b * last;
      const bot = L.a + L.b * last;
      const broke = dir === 1 ? cl > top : cl < bot;
      const failed = dir === 1 ? cl < bot : cl > top;
      const target = dir === 1 ? top + poleLen : bot - poleLen;
      const name = `${dir === 1 ? '上升' : '下降'}${pennant ? '三角旗' : '旗形'}`;
      return {
        id: 'flag',
        name,
        bias: failed ? 'neutral' : dir === 1 ? 'bull' : 'bear',
        status: broke ? '已突破' : failed ? '已失效' : '整理中',
        lines: [
          { a: [s, c[s].close], b: [end, c[end].close], label: '旗桿' },
          { a: [end + 1, H.a + H.b * (end + 1)], b: [last, top], extend: true },
          { a: [end + 1, L.a + L.b * (end + 1)], b: [last, bot], extend: true },
        ],
        points: [],
        summary: `${body.length + end - s} 天前開始，${end - s} 天內${dir === 1 ? '急漲' : '急跌'} ${Math.abs(pole * 100).toFixed(0)}%（旗桿），之後 ${body.length} 天小幅整理（旗面）。旗形是中繼型態，突破後常再走一段和旗桿差不多的距離。`,
        scenarios: [
          { when: `${dir === 1 ? '帶量突破' : '跌破'}旗面 ${f2(dir === 1 ? top : bot)}`, then: `延續原趨勢，等幅目標約 ${f2(target)}`, bias: dir === 1 ? 'bull' : 'bear' },
          { when: `反向${dir === 1 ? '跌破' : '突破'} ${f2(dir === 1 ? bot : top)}`, then: '旗形失敗，原趨勢可能結束', bias: dir === 1 ? 'bear' : 'bull' },
          { when: '整理超過 3～4 週還沒突破', then: '動能消退，旗形的參考性降低', bias: 'neutral' },
        ],
      };
    }
  }
  return null;
}

// ------------------------------------------------------------ 島狀反轉

function island(c: Candle[]): Pattern | null {
  const gs = findGaps(c, 160);
  for (let k = gs.length - 1; k >= 1; k--) {
    const b = gs[k];
    for (let j = k - 1; j >= 0; j--) {
      const a = gs[j];
      if (b.i - a.i > 20) break;
      if (a.dir === b.dir) continue;
      // 島的期間至少 1 天，兩個缺口重疊在差不多的價位
      const top = a.dir === 'up';
      const seg = c.slice(a.i, b.i);
      if (!seg.length) continue;
      const islandLo = Math.min(...seg.map((x) => x.low));
      const islandHi = Math.max(...seg.map((x) => x.high));
      const ok = top ? islandLo > Math.max(c[a.i - 1].high, c[b.i].high) : islandHi < Math.min(c[a.i - 1].low, c[b.i].low);
      if (!ok || b.i < c.length - 60) continue;
      return {
        id: 'island',
        name: top ? '島狀反轉（頂部）' : '島狀反轉（底部）',
        bias: b.filled ? 'neutral' : top ? 'bear' : 'bull',
        status: b.filled ? '第二個缺口已回補（效力減弱）' : '成立',
        lines: [],
        points: [],
        zones: [
          { i: a.i, lo: Math.min(a.lo, a.hi), hi: Math.max(a.lo, a.hi), label: '缺口 1' },
          { i: b.i, lo: Math.min(b.lo, b.hi), hi: Math.max(b.lo, b.hi), label: '缺口 2' },
        ],
        summary: `${c[a.i].date.slice(5).replace('-', '/')} 跳空${top ? '向上' : '向下'}、${c[b.i].date.slice(5).replace('-', '/')} 又反向跳空，中間 ${b.i - a.i} 天像一座孤島，是強烈的${top ? '頭部' : '底部'}反轉訊號。`,
        scenarios: [
          { when: `第二個缺口 ${f2(Math.min(b.lo, b.hi))}～${f2(Math.max(b.lo, b.hi))} 不被回補`, then: top ? '反轉確認，下跌容易持續' : '反轉確認，上漲容易持續', bias: top ? 'bear' : 'bull' },
          { when: '價格回補第二個缺口', then: '島狀反轉失效', bias: 'neutral' },
        ],
      };
    }
  }
  return null;
}

// ------------------------------------------------------------ 圓弧底 / 圓弧頂、杯柄

/** 二次曲線 y = a + b·x + c·x² 的最小平方解，回傳係數與 R²。 */
function quadFit(xs: number[], ys: number[]): { a: number; b: number; c: number; r2: number } {
  const n = xs.length;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = 0; k < n; k++) {
    const x = xs[k];
    const y = ys[k];
    s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    t0 += y; t1 += x * y; t2 += x * x * y;
  }
  // 解 3×3 正規方程
  const m = [[n, s1, s2, t0], [s1, s2, s3, t1], [s2, s3, s4, t2]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col || !m[col][col]) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  const [a, b, cc] = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  const my = t0 / n;
  let ssr = 0;
  let sst = 0;
  for (let k = 0; k < n; k++) {
    const fy = a + b * xs[k] + cc * xs[k] ** 2;
    ssr += (ys[k] - fy) ** 2;
    sst += (ys[k] - my) ** 2;
  }
  return { a, b, c: cc, r2: sst ? 1 - ssr / sst : 0 };
}

function rounding(c: Candle[]): Pattern | null {
  const last = c.length - 1;
  for (const n of [120, 90, 60]) {
    if (c.length < n) continue;
    const start = last - n + 1;
    const xs = Array.from({ length: n }, (_, k) => k);
    const ys = xs.map((k) => c[start + k].close);
    const q = quadFit(xs, ys);
    if (q.r2 < 0.75) continue;
    const vx = -q.b / (2 * q.c);
    if (!(vx > n * 0.3 && vx < n * 0.75)) continue;
    const vy = q.a + q.b * vx + q.c * vx * vx;
    const edge = (ys[0] + ys[n - 1]) / 2;
    const depth = Math.abs(edge - vy) / edge;
    if (depth < 0.08) continue;
    const bottom = q.c > 0;
    const pts: Array<[number, number]> = xs.filter((k) => k % 3 === 0 || k === n - 1).map((k) => [start + k, q.a + q.b * k + q.c * k * k]);
    const rim = ys[0];
    const cl = c[last].close;
    // 杯柄：圓弧底右側接近左緣高點後，小幅回檔整理
    const recentHi = Math.max(...c.slice(last - 15, last + 1).map((x) => x.high));
    const handle = bottom && recentHi >= rim * 0.95 && cl < recentHi * 0.98 && cl > recentHi - (rim - vy) / 2;
    if (handle) {
      return {
        id: 'cup',
        name: '杯柄型態',
        bias: 'bull',
        status: cl > recentHi ? '已突破杯緣' : '杯柄整理中',
        lines: [{ a: [start, rim], b: [last, rim], extend: true, dash: true, label: `杯緣 ${f2(Math.max(rim, recentHi))}` }],
        points: [],
        paths: [{ pts }],
        summary: `近 ${n} 天形成圓弧形的杯身（深度 ${(depth * 100).toFixed(0)}%），右側回到杯緣附近後小幅回檔（杯柄）。杯柄型態是常見的多頭續漲型態。`,
        scenarios: [
          { when: `帶量突破杯緣 ${f2(Math.max(rim, recentHi))}`, then: `型態完成，目標約 ${f2(Math.max(rim, recentHi) + (rim - vy))}（杯深）`, bias: 'bull' },
          { when: `杯柄跌破杯身一半 ${f2((rim + vy) / 2)}`, then: '杯柄太深，型態失效', bias: 'bear' },
        ],
      };
    }
    return {
      id: 'rounding',
      name: bottom ? '圓弧底' : '圓弧頂',
      bias: bottom ? 'bull' : 'bear',
      status: bottom ? (cl > rim ? '已突破起跌點' : '打底中') : cl < rim ? '已跌破起漲點' : '築頂中',
      lines: [],
      points: [],
      paths: [{ pts }],
      summary: `近 ${n} 天的價格呈${bottom ? '碗狀（先跌後漲、轉折平緩）' : '倒碗狀（先漲後跌、轉折平緩）'}，曲線吻合度 ${Math.round(q.r2 * 100)}%。圓弧型態形成慢，但反轉通常比較紮實。`,
      scenarios: bottom
        ? [
            { when: `站上左側起跌點 ${f2(rim)}`, then: '圓弧底完成，常展開較長的上升段', bias: 'bull' },
            { when: `跌破弧底 ${f2(vy)}`, then: '型態失效', bias: 'bear' },
          ]
        : [
            { when: `跌破左側起漲點 ${f2(rim)}`, then: '圓弧頂完成，下跌常持續較久', bias: 'bear' },
            { when: `站上弧頂 ${f2(vy)}`, then: '型態失效', bias: 'bull' },
          ],
    };
  }
  return null;
}

// ------------------------------------------------------------ V 型反轉

function vReversal(c: Candle[]): Pattern | null {
  const last = c.length - 1;
  const win = c.slice(-40);
  const off = c.length - win.length;
  let lowK = 0;
  let highK = 0;
  win.forEach((x, k) => {
    if (x.low < win[lowK].low) lowK = k;
    if (x.high > win[highK].high) highK = k;
  });
  for (const bottom of [true, false]) {
    const k = bottom ? lowK : highK;
    const pivot = bottom ? win[k].low : win[k].high;
    if (k < 5 || win.length - 1 - k < 3) continue;
    const pre = win.slice(Math.max(0, k - 15), k);
    const startP = bottom ? Math.max(...pre.map((x) => x.high)) : Math.min(...pre.map((x) => x.low));
    const fall = Math.abs(startP - pivot) / startP;
    if (fall < 0.15) continue;
    const now = c[last].close;
    const back = Math.abs(now - pivot) / Math.abs(startP - pivot);
    if (back < 0.75) continue;
    const i = off + k;
    return {
      id: 'v-reversal',
      name: bottom ? 'V 型反轉' : '倒 V 型反轉',
      bias: bottom ? 'bull' : 'bear',
      status: `已收復 ${Math.round(back * 100)}%`,
      lines: [],
      points: [{ i, p: pivot, label: bottom ? 'V 底' : '倒 V 頂', pos: bottom ? 'below' : 'above' }],
      summary: `${bottom ? '急跌' : '急漲'} ${Math.round(fall * 100)}% 到 ${f2(pivot)} 後，又快速${bottom ? '漲回' : '跌回'}原本跌幅的 ${Math.round(back * 100)}%，沒有打底（築頂）的過程。V 型反轉力道強，但也容易出現劇烈回測。`,
      scenarios: [
        { when: `${bottom ? '站上' : '跌破'}起點 ${f2(startP)}`, then: bottom ? '完全收復跌幅，多方掌控' : '完全吐回漲幅，空方掌控', bias: bottom ? 'bull' : 'bear' },
        { when: `回測一半位置 ${f2((startP + pivot) / 2)} 守不住`, then: '反轉力道不足，可能二次探底（頂）', bias: bottom ? 'bear' : 'bull' },
      ],
    };
  }
  return null;
}

// ------------------------------------------------------------ 三重頂 / 三重底

function triple(c: Candle[], piv: Pivot[]): Pattern | null {
  const last = c.length - 1;
  for (let k = piv.length - 1; k >= 4; k--) {
    const seq = piv.slice(k - 4, k + 1);
    const top = seq[0].kind === 'H';
    const peaks = [seq[0], seq[2], seq[4]];
    const troughs = [seq[1], seq[3]];
    if (seq[4].i < last - 100) break;
    const ref = top ? Math.max(...peaks.map((p) => p.price)) : Math.min(...peaks.map((p) => p.price));
    if (peaks.some((p) => Math.abs(p.price - ref) / ref > 0.04)) continue;
    const neck = top ? Math.min(...troughs.map((p) => p.price)) : Math.max(...troughs.map((p) => p.price));
    if (Math.abs(neck - ref) / ref < 0.06) continue;
    const cl = c[last].close;
    const status = top ? (cl < neck ? '已確認（跌破頸線）' : '形成中') : cl > neck ? '已確認（突破頸線）' : '形成中';
    const target = top ? neck - (ref - neck) : neck + (neck - ref);
    return {
      id: 'triple',
      name: top ? '三重頂' : '三重底',
      bias: top ? 'bear' : 'bull',
      status,
      lines: [{ a: [seq[0].i, neck], b: [last, neck], extend: true, dash: true, label: `頸線 ${f2(neck)}` }],
      points: peaks.map((p, n) => ({ i: p.i, p: p.price, label: `${n + 1}`, pos: top ? 'above' : 'below' })),
      summary: `三次${top ? '在 ' + f2(ref) + ' 附近漲不上去' : '在 ' + f2(ref) + ' 附近跌不下去'}，${top ? '壓力' : '支撐'}非常明確。目前${status}。`,
      scenarios: [
        { when: `${top ? '跌破' : '站上'}頸線 ${f2(neck)}`, then: `型態確認，目標約 ${f2(target)}`, bias: top ? 'bear' : 'bull' },
        { when: `${top ? '站上' : '跌破'} ${f2(top ? ref * 1.03 : ref * 0.97)}`, then: '型態失效', bias: top ? 'bull' : 'bear' },
      ],
    };
  }
  return null;
}

// ------------------------------------------------------------ 費波納契回檔

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function fibonacci(c: Candle[]): Pattern | null {
  const win = c.slice(-120);
  const off = c.length - win.length;
  let hi = 0;
  let lo = 0;
  win.forEach((x, k) => {
    if (x.high > win[hi].high) hi = k;
    if (x.low < win[lo].low) lo = k;
  });
  const H = win[hi].high;
  const L = win[lo].low;
  if ((H - L) / L < 0.1) return null;
  const upMove = lo < hi; // 先低後高 = 上漲段，量測回檔
  const level = (r: number) => (upMove ? H - (H - L) * r : L + (H - L) * r);
  const cl = c[c.length - 1].close;
  const lines: PatternLine[] = FIB_RATIOS.map((r) => ({ a: [off + Math.min(hi, lo), level(r)], b: [c.length - 1, level(r)], extend: true, dash: r !== 0 && r !== 1, label: `${(r * 100).toFixed(1).replace('.0', '')}% ${f2(level(r))}`, labelAt: 'start' }));
  // 目前價格落在哪兩條之間
  const sorted = FIB_RATIOS.map((r) => ({ r, p: level(r) })).sort((a, b) => a.p - b.p);
  const below = [...sorted].reverse().find((x) => x.p <= cl);
  const above = sorted.find((x) => x.p > cl);
  const pct = (r: number) => `${(r * 100).toFixed(1).replace('.0', '')}%`;
  return {
    id: 'fib',
    name: '費波納契回檔',
    bias: 'neutral',
    status: upMove ? '上漲段的回檔' : '下跌段的反彈',
    lines,
    points: [],
    summary: `以近半年${upMove ? '低點 ' + f2(L) + ' 到高點 ' + f2(H) : '高點 ' + f2(H) + ' 到低點 ' + f2(L)} 這段計算。目前 ${f2(cl)}${below ? `，下方是 ${pct(below.r)}（${f2(below.p)}）` : ''}${above ? `、上方是 ${pct(above.r)}（${f2(above.p)}）` : ''}。38.2%、50%、61.8% 是最常見的${upMove ? '回檔支撐' : '反彈壓力'}。`,
    scenarios: upMove
      ? [
          { when: `回檔守住 38.2%（${f2(level(0.382))}）`, then: '強勢回檔，上漲趨勢健康', bias: 'bull' },
          { when: `回到 50%～61.8%（${f2(level(0.5))}～${f2(level(0.618))}）止穩`, then: '正常回檔，常見的承接區', bias: 'bull' },
          { when: `跌破 78.6%（${f2(level(0.786))}）`, then: '漲勢幾乎被吃光，趨勢可能反轉', bias: 'bear' },
        ]
      : [
          { when: `反彈不過 38.2%（${f2(level(0.382))}）`, then: '弱勢反彈，跌勢未止', bias: 'bear' },
          { when: `站上 61.8%（${f2(level(0.618))}）`, then: '反彈力道強，可能扭轉跌勢', bias: 'bull' },
        ],
  };
}

// ------------------------------------------------------------ 分價量表

function volumeProfile(c: Candle[], window = 120, bins = 24): Pattern | null {
  const win = c.slice(-window);
  const lo = Math.min(...win.map((x) => x.low));
  const hi = Math.max(...win.map((x) => x.high));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  for (const x of win) {
    // 把每天的量平均分到當天最高到最低之間的價格區間
    const a = Math.max(0, Math.floor((x.low - lo) / step));
    const b = Math.min(bins - 1, Math.floor((x.high - lo) / step));
    for (let k = a; k <= b; k++) vol[k] += x.volume / (b - a + 1);
  }
  const max = Math.max(...vol);
  const poc = vol.indexOf(max);
  // 價值區：從最大量往兩側擴到 70% 成交量
  const total = vol.reduce((s, v) => s + v, 0);
  let va = vol[poc];
  let l = poc;
  let h = poc;
  while (va < total * 0.7 && (l > 0 || h < bins - 1)) {
    const nl = l > 0 ? vol[l - 1] : -1;
    const nh = h < bins - 1 ? vol[h + 1] : -1;
    if (nh >= nl) va += vol[++h];
    else va += vol[--l];
  }
  const cl = c[c.length - 1].close;
  const pocLo = lo + poc * step;
  const pocHi = pocLo + step;
  const vaLo = lo + l * step;
  const vaHi = lo + (h + 1) * step;
  const where = cl > vaHi ? '在價值區之上' : cl < vaLo ? '在價值區之下' : '在價值區內';
  return {
    id: 'vprofile',
    name: '分價量表',
    bias: cl > pocHi ? 'bull' : cl < pocLo ? 'bear' : 'neutral',
    status: where,
    lines: [],
    points: [],
    hbars: vol.map((v, k) => ({ lo: lo + k * step, hi: lo + (k + 1) * step, v: v / max, poc: k === poc, inValue: k >= l && k <= h })),
    summary: `近 ${win.length} 天成交最密集的價位在 ${f2(pocLo)}～${f2(pocHi)}（最大量區），70% 的量落在 ${f2(vaLo)}～${f2(vaHi)}（價值區）。目前股價${where}。`,
    scenarios: [
      { when: `股價在最大量區 ${f2(pocLo)} 之上`, then: '大量區變成支撐（多數人有賺），回測不破偏多', bias: 'bull' },
      { when: `股價在最大量區 ${f2(pocHi)} 之下`, then: '大量區變成套牢壓力，反彈到這裡容易遇到解套賣壓', bias: 'bear' },
      { when: '在成交量很少的價位', then: '籌碼真空，價格容易快速通過', bias: 'neutral' },
    ],
  };
}

// ------------------------------------------------------------ 布林通道

function bollinger(c: Candle[], n = 20, k = 2): Pattern | null {
  if (c.length < n + 5) return null;
  const mid: Array<[number, number]> = [];
  const upB: Array<[number, number]> = [];
  const dnB: Array<[number, number]> = [];
  let width = 0;
  const widths: number[] = [];
  for (let i = n - 1; i < c.length; i++) {
    const w = c.slice(i - n + 1, i + 1).map((x) => x.close);
    const m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    mid.push([i, m]);
    upB.push([i, m + k * sd]);
    dnB.push([i, m - k * sd]);
    width = (2 * k * sd) / m;
    widths.push(width);
  }
  const last = c.length - 1;
  const cl = c[last].close;
  const [, u] = upB[upB.length - 1];
  const [, d] = dnB[dnB.length - 1];
  const [, m] = mid[mid.length - 1];
  const recentW = widths.slice(-120);
  const squeeze = width <= Math.min(...recentW) * 1.1;
  const pos = (cl - d) / Math.max(1e-9, u - d);
  return {
    id: 'boll',
    name: '布林通道（20, 2）',
    bias: cl > m ? 'bull' : 'bear',
    status: squeeze ? '帶寬壓縮' : pos > 1 ? '突破上軌' : pos < 0 ? '跌破下軌' : `位置 ${Math.round(pos * 100)}%`,
    lines: [],
    points: [],
    paths: [{ pts: upB }, { pts: mid, dash: true, width: 1 }, { pts: dnB }],
    summary: `上軌 ${f2(u)}、中軌 ${f2(m)}、下軌 ${f2(d)}，帶寬 ${(width * 100).toFixed(1)}%${squeeze ? '，是近半年最窄，常是大行情的前兆' : ''}。`,
    scenarios: [
      { when: '沿著上軌一路走', then: '強勢多頭（「開口沿軌」），不要輕易猜頭', bias: 'bull' },
      { when: `跌回中軌 ${f2(m)} 之下`, then: '短線轉弱，中軌由支撐變壓力', bias: 'bear' },
      { when: '帶寬壓縮到極窄後放量', then: '往放量的方向出現一段行情', bias: 'neutral' },
    ],
  };
}

// ------------------------------------------------------------ 均線扣抵

function deduction(c: Candle[]): Pattern | null {
  const last = c.length - 1;
  const cl = c[last].close;
  const marks: NonNullable<Pattern['marks']> = [];
  const lines: string[] = [];
  const scen: Scenario[] = [];
  for (const n of [20, 60, 120]) {
    const i = last - n + 1;
    if (i < 0) continue;
    const ded = c[i].close;
    // 接下來 5 天會被扣掉的價格（平均）
    const next = c.slice(i, i + 5).map((x) => x.close);
    const nextAvg = next.reduce((a, b) => a + b, 0) / next.length;
    const dir = cl > nextAvg ? '上彎' : cl < nextAvg ? '下彎' : '走平';
    marks.push({ i, p: c[i].low, label: `扣${n}`, pos: 'below', bias: cl > ded ? 'bull' : 'bear' });
    lines.push(`${n} 日線明天扣 ${f2(ded)}（${c[i].date.slice(5).replace('-', '/')}），接下來 5 天平均扣 ${f2(nextAvg)}，現價${cl >= nextAvg ? '較高' : '較低'} → 均線傾向${dir}`);
    scen.push({ when: `股價維持在 ${f2(nextAvg)} 之上`, then: `${n} 日線會${cl > nextAvg ? '持續上彎' : '止跌轉平'}，對${cl > nextAvg ? '多方有利' : '空方壓力減輕'}`, bias: cl > nextAvg ? 'bull' : 'neutral' });
  }
  if (!marks.length) return null;
  const ups = marks.filter((m) => m.bias === 'bull').length;
  return {
    id: 'deduct',
    name: '均線扣抵',
    bias: ups >= 2 ? 'bull' : ups === 0 ? 'bear' : 'neutral',
    status: `${ups} / ${marks.length} 條均線將上彎`,
    lines: [],
    points: [],
    marks,
    summary: `扣抵值是均線明天要減掉的那天價格：現價比扣抵值高，均線就會往上。${lines.join('；')}。`,
    scenarios: scen,
  };
}

// ------------------------------------------------------------ K 棒訊號（包成型態卡片）

function candleCard(c: Candle[]): Pattern | null {
  const sig = detectCandles(c, 60);
  if (!sig.length) return null;
  const recent = sig.filter((s) => s.i >= c.length - 10);
  const latest = sig[sig.length - 1];
  return {
    id: 'candle',
    name: 'K 棒訊號',
    bias: recent.length ? recent[recent.length - 1].bias : 'neutral',
    status: recent.length ? `近 10 日 ${recent.length} 個` : '近 10 日沒有',
    lines: [],
    points: [],
    marks: sig.map((s) => ({ i: s.i, p: s.bias === 'bull' ? c[s.i].low : c[s.i].high, label: s.name, pos: s.bias === 'bull' ? 'below' : 'above', bias: s.bias })),
    summary: `近 60 日共 ${sig.length} 個 K 棒訊號，最近一個是 ${c[latest.i].date.slice(5).replace('-', '/')} 的「${latest.name}」：${latest.note}。單根 K 棒的訊號要搭配位置（高檔或低檔）與隔天的確認。`,
    scenarios: (recent.length ? recent : [latest]).slice(-4).map((s) => ({ when: `${c[s.i].date.slice(5).replace('-', '/')} ${s.name}`, then: s.note, bias: s.bias })),
  };
}

/** 每種型態固定一個顏色（多空看狀態標籤），避免同方向的型態疊在一起分不清楚。 */
export const PATTERN_COLORS: Record<Pattern['id'], string> = {
  channel: '#8ff0ff',
  wave: '#ffd166',
  'double-bottom': '#ff8fd8',
  'double-top': '#ff8fd8',
  'hs-top': '#ffa36b',
  'hs-bottom': '#ffa36b',
  triangle: '#b9f27c',
  gap: '#e2e8f0',
  volume: '#c4b5fd',
  candle: '#fde68a',
  flag: '#fca5a5',
  wedge: '#86efac',
  broadening: '#fdba74',
  island: '#f0abfc',
  rounding: '#67e8f9',
  cup: '#67e8f9',
  'v-reversal': '#fda4af',
  triple: '#ff8fd8',
  fib: '#fbbf24',
  vprofile: '#94a3b8',
  boll: '#a5b4fc',
  deduct: '#f9a8d4',
};

/** 預設不畫在圖上的圖層（輔助線比較佔畫面，需要時再勾選）。 */
export const DEFAULT_HIDDEN: ReadonlySet<Pattern['id']> = new Set(['vprofile', 'boll', 'deduct', 'fib', 'candle']);

/** 偵測所有型態（只看最近一年內）。 */
export function detectPatterns(all: Candle[]): { pivots: Pivot[]; patterns: Pattern[] } {
  if (all.length < 30) return { pivots: [], patterns: [] };
  const off = Math.max(0, all.length - 250);
  const c = all.slice(off);
  const piv = zigzag(c, swingThreshold(c));
  const found = [
    channel(c),
    headShoulders(c, piv, true),
    headShoulders(c, piv, false),
    doubleBottom(c, piv, true),
    doubleBottom(c, piv, false),
    triangle(c, piv),
    waves(piv),
    gaps(c),
    volumePrice(c),
    wedges(c, piv),
    flags(c),
    island(c),
    rounding(c),
    vReversal(c),
    triple(c, piv),
    candleCard(c),
    fibonacci(c),
    volumeProfile(c),
    bollinger(c),
    deduction(c),
  ].filter((p): p is Pattern => !!p);
  // 頭肩和雙重頂底同時成立時，留下頭肩（比較完整的型態）
  const hs = found.some((p) => p.id === 'hs-top' || p.id === 'hs-bottom');
  let patterns = found.filter((p) => !(hs && (p.id === 'double-top' || p.id === 'double-bottom')));
  // 三重頂底成立時，雙重頂底通常是其中一部分
  if (patterns.some((p) => p.id === 'triple')) patterns = patterns.filter((p) => p.id !== 'double-top' && p.id !== 'double-bottom');
  // W 底和 M 頭同時出現時，只留比較新的那個（第二個底／頭比較晚的）
  const dt = patterns.find((p) => p.id === 'double-top');
  const db = patterns.find((p) => p.id === 'double-bottom');
  if (dt && db) {
    const lastOf = (p: Pattern) => Math.max(...p.points.map((pt) => pt.i));
    patterns = patterns.filter((p) => p !== (lastOf(dt) >= lastOf(db) ? db : dt));
  }
  // 換回整段陣列的索引
  const shift = (i: number) => i + off;
  for (const p of patterns) {
    p.lines = p.lines.map((l) => ({ ...l, a: [shift(l.a[0]), l.a[1]], b: [shift(l.b[0]), l.b[1]] }));
    p.points = p.points.map((pt) => ({ ...pt, i: shift(pt.i) }));
    p.zones = p.zones?.map((z) => ({ ...z, i: shift(z.i) }));
    p.paths = p.paths?.map((path) => ({ ...path, pts: path.pts.map(([i, v]) => [shift(i), v] as [number, number]) }));
    p.marks = p.marks?.map((m) => ({ ...m, i: shift(m.i) }));
  }
  return { pivots: piv.map((p) => ({ ...p, i: shift(p.i) })), patterns };
}

/** 型態辭典：什麼條件會形成什麼圖、之後常見的走法。 */
export const PATTERN_GUIDE: Array<{ name: string; bias: Bias; shape: string; when: string; then: string }> = [
  { name: '上升通道', bias: 'bull', shape: '高點、低點都一路墊高，可畫出兩條平行上升線', when: '回到下緣不破、量縮', then: '順勢偏多；跌破下緣代表趨勢轉弱' },
  { name: '下降通道', bias: 'bear', shape: '高點、低點都一路下移', when: '反彈到上緣過不去', then: '順勢偏空；站上上緣才可能反轉' },
  { name: '箱型整理', bias: 'neutral', shape: '在固定的高低價之間來回', when: '帶量突破箱頂或跌破箱底', then: '突破方向通常延續，目標約一個箱子的高度' },
  { name: 'W 底（雙重底）', bias: 'bull', shape: '兩個差不多低的低點，中間反彈形成頸線', when: '收盤帶量站上頸線', then: '底部確認，目標 ≈ 頸線 + 底到頸線的距離' },
  { name: 'M 頭（雙重頂）', bias: 'bear', shape: '兩個差不多高的高點，中間回落形成頸線', when: '收盤跌破頸線', then: '頭部確認，目標 ≈ 頸線 − 頭到頸線的距離' },
  { name: '頭肩底', bias: 'bull', shape: '三個低點，中間最低（頭），兩側較高（肩）', when: '站上連接兩個反彈高點的頸線', then: '常見的大底型態，突破後回測頸線不破更可靠' },
  { name: '頭肩頂', bias: 'bear', shape: '三個高點，中間最高，兩側較低', when: '跌破連接兩個回檔低點的頸線', then: '常見的頭部型態，右肩量縮更可信' },
  { name: '上升三角形', bias: 'bull', shape: '高點持平、低點墊高', when: '帶量突破水平壓力', then: '多半向上突破，目標 ≈ 三角形開口高度' },
  { name: '下降三角形', bias: 'bear', shape: '低點持平、高點下移', when: '跌破水平支撐', then: '多半向下跌破' },
  { name: '對稱三角形', bias: 'neutral', shape: '高點下移、低點墊高，越收越窄', when: '價格貼近頂點、量縮', then: '突破方向就是接下來的走勢，假突破也常見' },
  { name: '突破缺口', bias: 'neutral', shape: '整理區間後帶量跳空，脫離原本的區間', when: '三天內不回補', then: '常是新一段行情的起點，缺口成為支撐（或壓力）' },
  { name: '中繼缺口', bias: 'neutral', shape: '趨勢走到一半出現的跳空', when: '缺口不被回補', then: '趨勢延續；常用缺口前的漲幅估算後面的距離' },
  { name: '竭盡缺口', bias: 'neutral', shape: '走了一大段之後的跳空，常伴隨爆量', when: '幾天內就被回補', then: '趨勢可能結束，留意反轉' },
  { name: '缺口回補', bias: 'neutral', shape: '價格回到跳空前的價位，把缺口填滿', when: '向上缺口被完全回補', then: '原本的突破失敗、支撐失守；向下缺口回補則是壓力被消化' },
  { name: '價漲量增', bias: 'bull', shape: '價格上漲、成交量放大', when: '突破壓力時特別明顯', then: '健康的攻擊，趨勢容易延續' },
  { name: '價漲量縮', bias: 'neutral', shape: '價格上漲、成交量萎縮', when: '在高檔出現', then: '追價意願不足（量價背離），漲勢可能趨緩' },
  { name: '價跌量增', bias: 'bear', shape: '價格下跌、成交量放大', when: '跌破支撐時', then: '賣壓湧出，短線偏弱' },
  { name: '價跌量縮', bias: 'neutral', shape: '價格下跌、成交量萎縮', when: '回檔到支撐附近', then: '賣壓減輕的量縮整理，等放量表態' },
  { name: '爆量長黑', bias: 'bear', shape: '成交量是均量數倍、收一根長黑 K', when: '出現在高檔', then: '常見的出貨訊號，跌破長黑低點更確認' },
  { name: '爆量長紅', bias: 'bull', shape: '成交量是均量數倍、收一根長紅 K', when: '突破整理區間時', then: '主力進場的攻擊訊號，長紅低點成為支撐' },
  { name: '旗形 / 三角旗', bias: 'neutral', shape: '急漲（跌）一段（旗桿）後，短期小幅反向或收斂整理（旗面）', when: '順著旗桿方向突破旗面', then: '中繼型態，突破後常再走一段旗桿長度' },
  { name: '上升楔形', bias: 'bear', shape: '高低點都墊高，但越收越窄', when: '跌破下緣', then: '漲勢力竭，常回到楔形起點' },
  { name: '下降楔形', bias: 'bull', shape: '高低點都下移，但越收越窄', when: '站上上緣', then: '跌勢減緩，常反彈回楔形起點' },
  { name: '擴散喇叭型', bias: 'bear', shape: '高點越來越高、低點越來越低', when: '跌破下緣', then: '多出現在頭部，波動大、不易操作' },
  { name: '島狀反轉', bias: 'neutral', shape: '一段走勢被前後兩個反向缺口隔開，像孤島', when: '第二個缺口不回補', then: '強烈反轉訊號' },
  { name: '圓弧底 / 圓弧頂', bias: 'neutral', shape: '價格呈碗狀（倒碗狀）緩慢轉折', when: '站上（跌破）起始點', then: '形成慢但反轉紮實，常有較長的趨勢' },
  { name: '杯柄型態', bias: 'bull', shape: '圓弧底（杯身）加上右側小幅回檔（杯柄）', when: '帶量突破杯緣', then: '多頭續漲型態，目標約一個杯深' },
  { name: 'V 型反轉', bias: 'neutral', shape: '急跌後沒有打底就急漲回來（或反過來）', when: '收復大部分跌幅', then: '力道強但容易劇烈回測' },
  { name: '三重頂 / 三重底', bias: 'neutral', shape: '三次在差不多的價位折返', when: '跌破（站上）頸線', then: '比雙重頂底更明確的反轉' },
  { name: '費波納契回檔', bias: 'neutral', shape: '一段漲幅的 23.6%、38.2%、50%、61.8%、78.6% 位置', when: '回檔到 38.2%～61.8% 止穩', then: '常見的支撐（反彈時則是壓力）' },
  { name: '分價量表', bias: 'neutral', shape: '每個價位累積的成交量', when: '股價在大量區之上或之下', then: '大量區在下方是支撐、在上方是套牢壓力' },
  { name: '布林通道', bias: 'neutral', shape: '20 日均線 ± 2 倍標準差', when: '帶寬壓縮後放量', then: '往放量方向出現行情；沿上軌走是強勢' },
  { name: '均線扣抵', bias: 'neutral', shape: '均線明天要減掉的那天價格', when: '現價高於扣抵值', then: '均線會上彎；可以預先知道均線方向' },
  { name: '艾略特 5 波', bias: 'neutral', shape: '推動浪 1-2-3-4-5，接著 A-B-C 修正', when: '第 2 浪不破起點、第 3 浪不是最短、第 4 浪不碰第 1 浪高點', then: '第 3 浪通常最強；第 5 浪後容易修正' },
];
