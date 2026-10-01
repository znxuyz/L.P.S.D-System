import { interpolateLab, scaleLinear } from 'd3';

/**
 * 資料編碼用的顏色。
 *
 * 漲跌：台股慣例紅漲綠跌，可切換成國際慣例（綠漲紅跌）。
 * 陣營色：城池的占領者用固定三色（藍、黃、洋紅），已通過色盲辨識檢查，
 * 也刻意避開紅綠，不會和漲跌混淆。陣營色一律搭配文字標示。
 */

export type Convention = 'tw' | 'intl';

// 指揮台配色：深色能量艙底，漲跌用高彩度霓虹色
const RED = { weak: '#4b1828', mid: '#8e1d39', strong: '#d8264b', bright: '#ff4566' };
const GREEN = { weak: '#0d3a2f', mid: '#0c6b4a', strong: '#0fa968', bright: '#1df09a' };
export const NEUTRAL_CELL = '#172233';

export const CONTESTANT_COLORS = ['#3987e5', '#c98500', '#d55181'];
/** 核心城池第四名以後的攻城產業合併成「其他」。 */
export const OTHER_CONTESTANT = '#77736a';

export function contestantColor(slot: number): string {
  return CONTESTANT_COLORS[slot] ?? OTHER_CONTESTANT;
}

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
