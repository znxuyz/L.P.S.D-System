import { interpolateLab, scaleLinear } from 'd3';

/**
 * 資料編碼用的顏色。
 *
 * 漲跌：台股慣例紅漲綠跌，可切換成國際慣例（綠漲紅跌）。
 */

export type Convention = 'tw' | 'intl';

// 玻璃數據艙：玫瑰紅與薄荷綠，中性是深靛藍，和玻璃面板的底色融在一起
const RED = { weak: '#4d2645', mid: '#a3325a', strong: '#ff4d6d', bright: '#ff8aa0' };
const GREEN = { weak: '#1c4247', mid: '#15876b', strong: '#14c08a', bright: '#5ee7b0' };
export const NEUTRAL_CELL = '#262d4d';

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
