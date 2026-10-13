/** 建立新局、讀取舊存檔（版本遷移）、共用的小工具（記事、找部位）。 */
import { SESSION_MINUTES } from '../intraday';
import { type Kind, type Position, type SimNote, type SimSettings, type SimState, type Trade } from './types';

/** 開新的一局（preOpen = true：第一天也從盤前開始）。 */
export function newSim(settings: SimSettings, watch = '2330', preOpen = false): SimState {
  return {
    v: 2,
    settings,
    date: settings.start,
    minute: 0,
    day: 1,
    cash: settings.capital,
    pos: [],
    orders: [],
    trades: [],
    notes: [],
    equity: [],
    nextId: 1,
    watch,
    stops: [],
    loans: [],
    pledges: [],
    days: [],
    flows: [],
    dca: [],
    fav: [],
    pre: preOpen,
  };
}

/** 舊存檔沒有的欄位補上預設值。 */
function withDefaults(s: SimState): SimState {
  s.stops ??= [];
  s.loans ??= [];
  s.pledges ??= [];
  s.days ??= [];
  s.flows ??= [];
  s.dca ??= [];
  s.fav ??= [];
  return s;
}

/** 舊版（每天收盤後下單、隔天開盤成交）的存檔轉成新版：視為那一天已收盤。 */
export function migrate(raw: unknown): SimState | null {
  const s = raw as Partial<SimState> & { v?: number; holdings?: Record<string, { shares: number; cost: number }>; trades?: Array<Partial<Trade>>; notes?: Array<Partial<SimNote>> };
  if (!s || typeof s !== 'object') return null;
  if (s.v === 2) return withDefaults(s as SimState);
  if (s.v !== 1 || !s.settings || !s.date) return null;
  const dates = (s.equity ?? []).map((e) => e[0]);
  const dayOf = (d?: string) => Math.max(1, dates.indexOf(d ?? '') + 1);
  return {
    v: 2,
    settings: s.settings,
    date: s.date,
    minute: SESSION_MINUTES,
    day: Math.max(1, dates.length),
    cash: s.cash ?? s.settings.capital,
    pos: Object.entries(s.holdings ?? {}).map(([code, h]) => ({ code, kind: 'cash' as const, dir: 'long' as const, shares: h.shares, cost: h.cost })),
    orders: [],
    trades: (s.trades ?? []).map((t) => ({ ...(t as Trade), kind: 'cash' as const, day: dayOf(t.date), minute: 0 })),
    notes: (s.notes ?? []).map((n) => ({ ...(n as SimNote), day: dayOf(n.date), minute: 0 })),
    equity: s.equity ?? [],
    nextId: s.nextId ?? 1,
    watch: s.watch ?? '2330',
    stops: [],
    loans: [],
    pledges: [],
    days: [],
    flows: [],
    dca: [],
    fav: [],
  };
}

// ------------------------------------------------------------ 價格與市值

export function findPos(s: SimState, code: string, kind: Kind, dir: 'long' | 'short'): Position | undefined {
  return s.pos.find((p) => p.code === code && p.kind === kind && p.dir === dir);
}

export function dropEmpty(s: SimState): void {
  s.pos = s.pos.filter((p) => p.shares > 0);
}

export function note(s: SimState, code: string, text: string): void {
  s.notes.push({ date: s.date, day: s.day, minute: Math.floor(s.minute), code, text });
}

/** 加入或移除自選股。 */
export function toggleFav(s: SimState, code: string): boolean {
  const had = s.fav.includes(code);
  s.fav = had ? s.fav.filter((c) => c !== code) : [...s.fav, code];
  return !had;
}
