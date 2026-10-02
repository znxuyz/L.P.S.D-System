import { interpolateLab, scaleLinear } from 'd3';

/**
 * 資料編碼用的顏色。
 *
 * 漲跌：台股慣例紅漲綠跌，可切換成國際慣例（綠漲紅跌）。
 */

export type Convention = 'tw' | 'intl';

// 像素冒險地圖：大地色調的漲跌，中性是灰紫色的荒地
const RED = { weak: '#7c4a52', mid: '#b8424a', strong: '#e8414a', bright: '#ff6b6b' };
const GREEN = { weak: '#4e6b52', mid: '#3f8f4f', strong: '#3cb95a', bright: '#69db7c' };
export const NEUTRAL_CELL = '#5f6178';

export interface Palette {
  up: typeof RED;
  down: typeof GREEN;
  heat: (changePct: number) => string;
}

export function palette(convention: Convention): Palette {
  const up = convention === 'tw' ? RED : GREEN;
  const down = convention === 'tw' ? GREEN : RED;
  const scale = scaleLinear<string>()
    .domain([-3, -1.5, -0.4, 0, 0.4, 1.5, 3])
    .range([down.strong, down.mid, down.weak, NEUTRAL_CELL, up.weak, up.mid, up.strong])
    .interpolate(interpolateLab)
    .clamp(true);
  return { up, down, heat: (v) => scale(v) };
}
