/** 迷你走勢線的 SVG path（左到右，上下留 1px）。 */
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = w / (values.length - 1);
  return values
    .map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(1 + (h - 2) * (1 - (v - lo) / span)).toFixed(1)}`)
    .join('');
}

/** 走勢線下方的填色區域。 */
export function sparkArea(values: number[], w: number, h: number): string {
  const line = sparkPath(values, w, h);
  return line ? `${line}L${w},${h}L0,${h}Z` : '';
}
