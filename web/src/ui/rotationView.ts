import { interpolateLab, scaleLinear } from 'd3';
import type { Rotation } from '../domain/rotation';
import { NEUTRAL_CELL, type Palette } from './colors';
import { escapeHtml, hm, num } from './format';
import { SESSION_MINUTES } from '../data/twse';

/**
 * ② 資金輪動條碼：每列一個產業，每欄一個 5 分鐘時段，
 * 顏色 = 該時段成交佔比相對 20 日平均的偏離（百分點）。
 */
export function renderRotation(el: HTMLElement, rotation: Rotation, pal: Palette, sessionStart: number): void {
  const labelW = 64;
  const w = Math.max(240, el.clientWidth);
  const rowH = 13;
  const top = 4;
  const h = top + rotation.industries.length * rowH + 18;
  const slots = SESSION_MINUTES / 5;
  const cellW = (w - labelW - 4) / slots;
  const scale = scaleLinear<string>()
    .domain([-rotation.maxAbs, 0, rotation.maxAbs])
    .range([pal.down.strong, NEUTRAL_CELL, pal.up.strong])
    .interpolate(interpolateLab)
    .clamp(true);

  const rows = rotation.industries
    .map((ind, i) => {
      const y = top + i * rowH;
      const cells = rotation.buckets
        .map((b) => {
          const slot = Math.round((b.start - sessionStart) / 300_000);
          const v = b.values[i];
          return `<rect x="${(labelW + slot * cellW).toFixed(1)}" y="${y}" width="${Math.max(1, cellW - 1).toFixed(1)}" height="${rowH - 2}" fill="${scale(v)}"><title>${hm(b.start)}–${hm(b.end)} ${escapeHtml(ind.name)} ${v >= 0 ? '+' : '−'}${num(Math.abs(v), 2)} 個百分點</title></rect>`;
        })
        .join('');
      return `<text class="rt-label" x="${labelW - 6}" y="${y + rowH - 4}">${escapeHtml(ind.name)}</text>${cells}`;
    })
    .join('');
  const ticks = [0, 90, 180, 270]
    .map((min) => `<text class="rt-axis" x="${labelW + (min / 5) * cellW}" y="${h - 4}">${hm(sessionStart + min * 60_000)}</text>`)
    .join('');
  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="資金輪動條碼">${rows}${ticks}</svg>`;
}
