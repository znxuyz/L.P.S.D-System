import type { Candle } from './technicals';

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
  id: 'channel' | 'double-bottom' | 'double-top' | 'hs-top' | 'hs-bottom' | 'triangle' | 'wave' | 'gap' | 'volume';
  name: string;
  bias: Bias;
  status: string;
  lines: PatternLine[];
  points: PatternPoint[];
  zones?: PatternZone[];
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
};

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
  ].filter((p): p is Pattern => !!p);
  // 頭肩和雙重頂底同時成立時，留下頭肩（比較完整的型態）
  const hs = found.some((p) => p.id === 'hs-top' || p.id === 'hs-bottom');
  let patterns = found.filter((p) => !(hs && (p.id === 'double-top' || p.id === 'double-bottom')));
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
  { name: '艾略特 5 波', bias: 'neutral', shape: '推動浪 1-2-3-4-5，接著 A-B-C 修正', when: '第 2 浪不破起點、第 3 浪不是最短、第 4 浪不碰第 1 浪高點', then: '第 3 浪通常最強；第 5 浪後容易修正' },
];
