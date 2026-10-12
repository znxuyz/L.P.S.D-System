/** 模擬盤的圖表（SVG 字串）。 */
import { scaleBand, scaleLinear } from 'd3';
import { SESSION_MINUTES, clock, type IntradayPath } from '../../domain/intraday';
import { emaSeries, type Candle } from '../../domain/technicals';
import { pct, price } from '../format';
import { money } from './util';

const BARS = 120;

/** 日 K（只到現在）＋EMA 20／60／120＋成交量。不畫月份刻度（會洩漏日期）。 */
export function candleSvg(visible: Candle[], w: number, h: number): string {
  const n = Math.min(BARS, visible.length);
  const off = visible.length - n;
  const c = visible.slice(off);
  const closes = visible.map((x) => x.close);
  // 指數移動平均（EMA）用全部歷史算，越近的價格權重越大，比簡單均線反應快
  const ma20 = emaSeries(closes, 20).slice(off);
  const ma60 = emaSeries(closes, 60).slice(off);
  const ma120 = emaSeries(closes, 120).slice(off);
  const pad = { l: 6, r: 52, t: 8, b: 10 };
  const volH = Math.round((h - pad.t - pad.b) * 0.2);
  const pb = h - pad.b - volH - 8;
  const x = scaleBand<number>().domain(c.map((_, i) => i)).range([pad.l, w - pad.r]).padding(0.25);
  const vals = [...c.flatMap((b) => [b.high, b.low]), ...ma20, ...ma60, ...ma120].filter((v): v is number => v != null);
  const y = scaleLinear().domain([Math.min(...vals), Math.max(...vals)]).nice(5).range([pb, pad.t]);
  const yv = scaleLinear().domain([0, Math.max(1, ...c.map((b) => b.volume))]).range([h - pad.b, h - pad.b - volH]);
  const bw = x.bandwidth();
  const cx = (i: number) => x(i)! + bw / 2;
  let body = '';
  c.forEach((b, i) => {
    const k = b.close >= b.open ? 'sim-up' : 'sim-down';
    const top = y(Math.max(b.open, b.close));
    const bh = Math.max(1, Math.abs(y(b.open) - y(b.close)));
    const today = i === c.length - 1 ? ' sim-today' : '';
    body += `<line class="${k}${today}" x1="${cx(i).toFixed(1)}" x2="${cx(i).toFixed(1)}" y1="${y(b.high).toFixed(1)}" y2="${y(b.low).toFixed(1)}"></line>`;
    body += `<rect class="${k}${today}" x="${x(i)!.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`;
    body += `<rect class="${k} sim-vol" x="${x(i)!.toFixed(1)}" y="${yv(b.volume).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad.b - yv(b.volume)).toFixed(1)}"></rect>`;
  });
  const path = (arr: (number | null)[]) => {
    let d = '';
    arr.forEach((v, i) => {
      if (v != null) d += `${d ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(v).toFixed(1)}`;
    });
    return d;
  };
  const ticks = y
    .ticks(5)
    .map((t) => `<g><line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 6}" y="${(y(t) + 4).toFixed(1)}">${price(t)}</text></g>`)
    .join('');
  const lastC = c[c.length - 1].close;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="日 K 線（只到現在）">
    ${ticks}${body}
    <path class="sim-ma20" d="${path(ma20)}"></path><path class="sim-ma60" d="${path(ma60)}"></path><path class="sim-ma120" d="${path(ma120)}"></path>
    <line class="sim-last" x1="${pad.l}" x2="${w - pad.r}" y1="${y(lastC).toFixed(1)}" y2="${y(lastC).toFixed(1)}"></line>
    <text class="sim-legend" x="${pad.l + 4}" y="${pad.t + 10}"><tspan class="sim-ma20t">— EMA20</tspan>  <tspan class="sim-ma60t">— EMA60</tspan>  <tspan class="sim-ma120t">— EMA120</tspan></text>
  </svg>`;
}

/** 今天的分時走勢（09:00～現在），虛線是昨收。 */
export function tickSvg(path: IntradayPath, pc: number, minute: number, w: number): string {
  const h = 120;
  const pad = { l: 6, r: 52, t: 8, b: 16 };
  const t = Math.min(SESSION_MINUTES, Math.floor(minute));
  const pts = [...path.price.slice(0, t + 1)];
  // 以昨收為中線、上下對稱（和看盤軟體的分時圖一樣）
  const span = Math.max(pc * 0.01, ...pts.map((p) => Math.abs(p - pc)));
  const y = scaleLinear().domain([pc - span, pc + span]).range([h - pad.b, pad.t]);
  const x = (i: number) => pad.l + (i / SESSION_MINUTES) * (w - pad.l - pad.r);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join('');
  const now = pts[pts.length - 1];
  const marks = (w < 560 ? [0, 90, 180, 270] : [0, 60, 120, 180, 240, 270])
    .map((m) => `<text class="sim-axis" x="${x(m).toFixed(1)}" y="${h - 3}" text-anchor="${m === 0 ? 'start' : m === 270 ? 'end' : 'middle'}">${clock(m)}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="今日分時走勢（模擬）">
    <line class="sim-pc" x1="${pad.l}" x2="${w - pad.r}" y1="${y(pc).toFixed(1)}" y2="${y(pc).toFixed(1)}"></line>
    <text class="sim-axis" x="${w - pad.r + 6}" y="${(y(pc) + 4).toFixed(1)}">昨收</text>
    <path class="sim-tickline ${now >= pc ? 'sim-up-line' : 'sim-down-line'}" d="${d}"></path>
    <circle class="${now >= pc ? 'sim-up' : 'sim-down'}" cx="${x(t).toFixed(1)}" cy="${y(now).toFixed(1)}" r="3"></circle>
    ${marks}
  </svg>`;
}

/** x 軸標籤：有真實日期（結束報告）時標年月，否則標「第幾天」。 */
function xLabels(n: number, x: (i: number) => number, h: number, dates?: string[]): string {
  if (!dates) {
    return `<text class="sim-axis" x="${x(0).toFixed(1)}" y="${h - 3}">第 1 天</text><text class="sim-axis" x="${x(n - 1).toFixed(1)}" y="${h - 3}" text-anchor="end">第 ${n} 天</text>`;
  }
  // 期間短（半年內）標「月-日」，長的標「年-月」；同一個標籤不重複
  const days = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 864e5;
  const fmt = (d: string) => (days < 183 ? d.slice(5) : d.slice(0, 7));
  const want = Math.min(6, n);
  const out: string[] = [];
  let last = '';
  for (let k = 0; k < want; k++) {
    const i = want === 1 ? 0 : Math.round((k * (n - 1)) / (want - 1));
    const label = fmt(dates[i]);
    if (label === last) continue;
    last = label;
    const anchor = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
    out.push(`<text class="sim-axis" x="${x(i).toFixed(1)}" y="${h - 3}" text-anchor="${anchor}">${label}</text>`);
  }
  return out.join('');
}

export interface Series {
  cls: string;
  values: Array<number | null>;
}

/** 報酬率折線（值是報酬率，0 = 損益兩平）。 */
export function returnChart(series: Series[], w: number, h: number, dates?: string[]): string {
  const n = Math.max(...series.map((s) => s.values.length));
  if (n < 2) return '';
  const pad = { l: 4, r: 50, t: 8, b: 16 };
  const all = [0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)))];
  const y = scaleLinear().domain([Math.min(...all), Math.max(...all)]).nice(4).range([h - pad.b, pad.t]);
  const x = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const line = (arr: Array<number | null>) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = y
    .ticks(4)
    .map((t) => `<line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 4}" y="${(y(t) + 4).toFixed(1)}">${pct(t * 100, 0)}</text>`)
    .join('');
  return `<svg class="sim-eq" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="報酬率走勢">
    ${ticks}<line class="sim-base" x1="${pad.l}" x2="${w - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
    ${series.map((s) => `<path class="${s.cls}" d="${line(s.values)}"></path>`).join('')}
    ${xLabels(n, x, h, dates)}
  </svg>`;
}

/** 每日損益長條（已實現＋未實現疊在一起）。 */
export function pnlBars(real: number[], unreal: number[], w: number, h: number, dates?: string[]): string {
  const n = real.length;
  if (!n) return '';
  const pad = { l: 4, r: 58, t: 8, b: 16 };
  const tops = real.map((r, i) => Math.max(0, r) + Math.max(0, unreal[i]));
  const bottoms = real.map((r, i) => Math.min(0, r) + Math.min(0, unreal[i]));
  const y = scaleLinear().domain([Math.min(0, ...bottoms), Math.max(0, ...tops)]).nice(4).range([h - pad.b, pad.t]);
  const x = scaleBand<number>().domain(real.map((_, i) => i)).range([pad.l, w - pad.r]).padding(n > 60 ? 0.1 : 0.25);
  const bw = Math.max(0.6, x.bandwidth());
  let body = '';
  real.forEach((r, i) => {
    // 同號疊起來、異號各自往上或往下
    let up = 0;
    let down = 0;
    for (const [v, k] of [
      [r, 'sim-bar-real'],
      [unreal[i], 'sim-bar-unreal'],
    ] as const) {
      if (!v) continue;
      const from = v > 0 ? up : down;
      const to = from + v;
      if (v > 0) up = to;
      else down = to;
      const y0 = y(Math.max(from, to));
      const hh = Math.max(0.5, Math.abs(y(from) - y(to)));
      body += `<rect class="${k} ${v > 0 ? 'is-up' : 'is-down'}" x="${x(i)!.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}"></rect>`;
    }
  });
  const ticks = y
    .ticks(4)
    .map((t) => `<line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 4}" y="${(y(t) + 4).toFixed(1)}">${money(t)}</text>`)
    .join('');
  const cx = (i: number) => x(i)! + bw / 2;
  return `<svg class="sim-eq" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="每日損益">
    ${ticks}<line class="sim-base" x1="${pad.l}" x2="${w - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>${body}
    ${xLabels(n, cx, h, dates)}
  </svg>`;
}

/** 回檔（從前高跌了多少）面積圖。 */
export function drawdownChart(dd: number[], w: number, h: number, dates?: string[]): string {
  const n = dd.length;
  if (n < 2) return '';
  const pad = { l: 4, r: 50, t: 8, b: 16 };
  const y = scaleLinear().domain([Math.min(-0.01, ...dd), 0]).nice(3).range([h - pad.b, pad.t]);
  const x = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const d = `M${x(0).toFixed(1)} ${y(0).toFixed(1)}` + dd.map((v, i) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('') + `L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)}Z`;
  const ticks = y
    .ticks(3)
    .map((t) => `<line class="sim-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="sim-axis" x="${w - pad.r + 4}" y="${(y(t) + 4).toFixed(1)}">${pct(t * 100, 0)}</text>`)
    .join('');
  return `<svg class="sim-eq" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="回檔">
    ${ticks}<path class="sim-dd" d="${d}"></path>${xLabels(n, x, h, dates)}
  </svg>`;
}
