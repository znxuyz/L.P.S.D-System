/** 模擬盤畫面共用的小工具。 */
import { type Bias } from '../../domain/patterns';
import { KIND_NAME, type Kind, type Market, type Side, type SimState } from '../../domain/sim';
import { num } from '../format';

/** 各個畫面元件需要從模擬盤頁面拿到的資料。 */
export interface SimCtx {
  market: Market;
  calendar: string[] | null | undefined;
  taiex: Map<string, number> | null;
  nameOf(code: string): string;
  /** 同額投入大盤的對照組在 date 收盤的價值。 */
  benchAt(s: SimState, date: string): number | null;
  /** 對照組報酬（到最近一個已收盤的交易日）。 */
  benchOf(s: SimState): number | null;
}

export function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

export const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export const money = (v: number) => num(Math.round(v));
export const BIAS: Record<Bias, string> = { bull: '偏多', bear: '偏空', neutral: '中性' };
export const weekday = (date: string) => '日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()];

export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * 日期的亂碼：「年、月、日」看得到，每個數字是一格不停跳動的報價燈號（像報價看板在跳），看不出實際日期。
 * 每格的數字順序、轉速、起始位置由日期雜湊決定（同一天每次一樣），翻動的數字本身沒有意義。
 *
 * 效能：每一格只有一個元素在動（一條直排的十個數字用 transform 往上跳），格子高度用整數像素（CSS 的 --gh），
 * 每一步剛好移動一格，不會停在半格、也不會忽高忽低；transform 動畫由 GPU 處理，不會拖慢主執行緒。
 * 同一天的結果會記住，不用每次重算。
 */
const garbleCache = new Map<string, string>();
export function garble(date: string): string {
  const hit = garbleCache.get(date);
  if (hit) return hit;
  let h = hash(`lplc-garble|${date}`);
  const next = () => (h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0);
  const cell = () => {
    const digits = [...'0123456789'];
    for (let i = digits.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    const t = 0.9 + (next() % 1200) / 1000;
    const d = -((next() % 1000) / 1000) * t;
    return `<i><b style="--t:${t.toFixed(2)}s;--d:${d.toFixed(2)}s">${digits.join('<br>')}</b></i>`;
  };
  const g = (n: number) => `<span class="gb-run">${Array.from({ length: n }, cell).join('')}</span>`;
  const html = `<span class="gb" role="img" aria-label="日期已隱藏"><span aria-hidden="true">${g(4)}年${g(2)}月${g(2)}日</span></span>`;
  if (garbleCache.size > 400) garbleCache.clear();
  garbleCache.set(date, html);
  return html;
}

/** 交易動作的名稱（依類別與買賣）。 */
export function actionName(kind: Kind, side: Side): string {
  if (kind === 'margin') return side === 'buy' ? '融資買進' : '融資賣出';
  if (kind === 'short') return side === 'sell' ? '融券賣出' : '融券回補';
  return `${KIND_NAME[kind]}${side === 'buy' ? '買進' : '賣出'}`;
}

/** 有正負號的百分比（null 顯示「—」）。 */
export function pctOrDash(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
}

/** 某天以前（含）的累計投入。 */
export function investedAt(s: Pick<SimState, 'settings' | 'flows'>, date: string): number {
  return s.settings.capital + (s.flows ?? []).filter(([d]) => d <= date).reduce((a, [, v]) => a + v, 0);
}
