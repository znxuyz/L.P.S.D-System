/**
 * 技術指標：由日 K 計算均線、RSI、MACD、KD、布林通道與支撐壓力，
 * 每個指標給出「偏多 / 偏空 / 中性」的判斷與一句說明。
 */

export interface Candle {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（張） */
  volume: number;
}

export type Tilt = 'bull' | 'bear' | 'neutral';

export interface Signal {
  id: 'ma' | 'rsi' | 'macd' | 'kd' | 'boll' | 'volume' | 'level';
  name: string;
  value: string;
  tilt: Tilt;
  note: string;
}

export interface TechSeries {
  ma5: (number | null)[];
  ma20: (number | null)[];
  ma60: (number | null)[];
}

export interface TechReport {
  series: TechSeries;
  signals: Signal[];
  support: number;
  resistance: number;
}

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/** Wilder RSI。 */
export function rsi(closes: number[], n = 14): number[] {
  const out: number[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      out.push(50);
      continue;
    }
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    out.push(loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

export function macd(closes: number[]): { dif: number[]; dea: number[]; hist: number[] } {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const dif = closes.map((_, i) => fast[i] - slow[i]);
  const dea = ema(dif, 9);
  return { dif, dea, hist: dif.map((v, i) => v - dea[i]) };
}

/** 台股常用的 KD（9, 3, 3）。 */
export function kd(candles: Candle[], n = 9): { k: number[]; d: number[] } {
  const k: number[] = [];
  const d: number[] = [];
  candles.forEach((c, i) => {
    const win = candles.slice(Math.max(0, i - n + 1), i + 1);
    const hi = Math.max(...win.map((x) => x.high));
    const lo = Math.min(...win.map((x) => x.low));
    const rsv = hi === lo ? 50 : ((c.close - lo) / (hi - lo)) * 100;
    const pk = i === 0 ? 50 : k[i - 1];
    const pd = i === 0 ? 50 : d[i - 1];
    k.push((pk * 2) / 3 + rsv / 3);
    d.push((pd * 2) / 3 + k[i] / 3);
  });
  return { k, d };
}

const last = <T>(arr: T[], back = 0): T => arr[arr.length - 1 - back];
const f1 = (v: number) => v.toFixed(1);

export function analyzeTechnicals(candles: Candle[]): TechReport | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const series: TechSeries = { ma5: sma(closes, 5), ma20: sma(closes, 20), ma60: sma(closes, 60) };
  const price = last(closes);
  const signals: Signal[] = [];

  // 均線排列
  const m5 = last(series.ma5)!;
  const m20 = last(series.ma20)!;
  const m60 = last(series.ma60) ?? m20;
  const bullAlign = price > m5 && m5 > m20 && m20 > m60;
  const bearAlign = price < m5 && m5 < m20 && m20 < m60;
  signals.push({
    id: 'ma',
    name: '均線排列',
    value: bullAlign ? '多頭排列' : bearAlign ? '空頭排列' : price >= m20 ? '站上月線' : '跌破月線',
    tilt: bullAlign || (!bearAlign && price >= m20) ? 'bull' : 'bear',
    note: `收盤 ${f1(price)}、5 日 ${f1(m5)}、20 日 ${f1(m20)}、60 日 ${f1(m60)}`,
  });

  // RSI
  const r = last(rsi(closes));
  signals.push({
    id: 'rsi',
    name: 'RSI(14)',
    value: f1(r),
    tilt: r >= 80 ? 'bear' : r <= 20 ? 'bull' : r >= 50 ? 'bull' : 'bear',
    note: r >= 80 ? '過熱，短線留意拉回' : r <= 20 ? '超賣，可能出現反彈' : r >= 50 ? '強勢區（50 以上）' : '弱勢區（50 以下）',
  });

  // MACD
  const m = macd(closes);
  const h0 = last(m.hist);
  const h1 = last(m.hist, 1);
  const cross = h1 <= 0 && h0 > 0 ? '黃金交叉' : h1 >= 0 && h0 < 0 ? '死亡交叉' : '';
  signals.push({
    id: 'macd',
    name: 'MACD',
    value: cross || (h0 > 0 ? '柱狀體為正' : '柱狀體為負'),
    tilt: h0 > 0 ? 'bull' : 'bear',
    note: `DIF ${last(m.dif).toFixed(2)}、MACD ${last(m.dea).toFixed(2)}${h0 > h1 ? '，動能增強' : '，動能減弱'}`,
  });

  // KD
  const s = kd(candles);
  const k0 = last(s.k);
  const d0 = last(s.d);
  const kCross = last(s.k, 1) <= last(s.d, 1) && k0 > d0 ? '黃金交叉' : last(s.k, 1) >= last(s.d, 1) && k0 < d0 ? '死亡交叉' : '';
  signals.push({
    id: 'kd',
    name: 'KD(9)',
    value: `K ${f1(k0)} / D ${f1(d0)}`,
    tilt: k0 >= 80 && kCross !== '黃金交叉' ? 'neutral' : k0 > d0 ? 'bull' : 'bear',
    note: kCross || (k0 >= 80 ? '高檔鈍化區' : k0 <= 20 ? '低檔區' : k0 > d0 ? 'K 在 D 之上' : 'K 在 D 之下'),
  });

  // 布林通道
  const win = closes.slice(-20);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
  const pb = sd === 0 ? 0.5 : (price - (mean - 2 * sd)) / (4 * sd);
  signals.push({
    id: 'boll',
    name: '布林通道',
    value: `位置 ${Math.round(pb * 100)}%`,
    tilt: pb > 1 ? 'neutral' : pb >= 0.5 ? 'bull' : pb < 0 ? 'neutral' : 'bear',
    note: pb > 1 ? '突破上軌，強勢但易震盪' : pb < 0 ? '跌破下軌，弱勢但可能反彈' : pb >= 0.5 ? '在中軌之上' : '在中軌之下',
  });

  // 量能
  const vols = candles.map((c) => c.volume);
  const v20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, vols.length - 1));
  const vr = v20 > 0 ? last(vols) / v20 : 1;
  const up = price >= last(closes, 1);
  signals.push({
    id: 'volume',
    name: '量能',
    value: `${vr.toFixed(2)} 倍均量`,
    tilt: vr >= 1.3 ? (up ? 'bull' : 'bear') : 'neutral',
    note: vr >= 1.3 ? (up ? '價漲量增' : '價跌量增，賣壓出籠') : vr <= 0.7 ? '量縮觀望' : '量能平穩',
  });

  // 支撐壓力：近 20 日低點 / 高點（不含今天）
  const prev = candles.slice(-21, -1);
  const support = Math.min(...prev.map((c) => c.low));
  const resistance = Math.max(...prev.map((c) => c.high));
  signals.push({
    id: 'level',
    name: '支撐 / 壓力',
    value: `${f1(support)} / ${f1(resistance)}`,
    tilt: price > resistance ? 'bull' : price < support ? 'bear' : 'neutral',
    note: price > resistance ? '突破近 20 日高點' : price < support ? '跌破近 20 日低點' : `距壓力 ${f1(((resistance - price) / price) * 100)}%、距支撐 ${f1(((price - support) / price) * 100)}%`,
  });

  return { series, signals, support, resistance };
}
