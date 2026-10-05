const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function price(v: number): string {
  return v >= 1000 ? nf0.format(v) : nf2.format(v);
}

export function num(v: number, digits = 0): string {
  return digits === 0 ? nf0.format(v) : digits === 1 ? nf1.format(v) : nf2.format(v);
}

export function signed(v: number, digits = 2): string {
  const s = num(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function pct(v: number, digits = 2): string {
  return `${signed(v, digits)}%`;
}

/** 億元，超過一萬億改用「兆」。 */
export function yi(v: number, digits = 1): string {
  if (Math.abs(v) >= 10000) return `${num(v / 10000, 2)} 兆`;
  return `${num(v, digits)} 億`;
}

export function signedYi(v: number, digits = 1): string {
  return `${signed(v, digits)} 億`;
}

export function sharePct(v: number): string {
  return `${num(v * 100, 1)}%`;
}

export function direction(v: number): 'up' | 'down' | 'flat' {
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

const timeFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const hmFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

export function clock(ms: number): string {
  return timeFmt.format(ms);
}

export function hm(ms: number): string {
  return hmFmt.format(ms);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
