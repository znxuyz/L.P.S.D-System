import { interpolateLab, scaleLinear } from 'd3';

/**
 * 資料編碼用的顏色。
 *
 * 漲跌：台股慣例紅漲綠跌，可切換成國際慣例（綠漲紅跌）。
 * 陣營色：城池的占領者用固定三色（藍、黃、洋紅），已通過色盲辨識檢查，
 * 也刻意避開紅綠，不會和漲跌混淆。陣營色一律搭配文字標示。
 */

export type Convention = 'tw' | 'intl';

const RED = { weak: '#6b2c2f', mid: '#a1302f', strong: '#dc3b33', bright: '#ff5d52' };
const GREEN = { weak: '#244a36', mid: '#1b6c3f', strong: '#139448', bright: '#34c774' };
export const NEUTRAL_CELL = '#34373e';

export const CONTESTANT_COLORS = ['#3987e5', '#c98500', '#d55181'];

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
