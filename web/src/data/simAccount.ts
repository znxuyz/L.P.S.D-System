/**
 * 模擬盤的開通碼與玩家存檔。
 *
 * - 開通碼由站長用 scripts/sim-code.mjs 產生，repo 裡只存「鹽＋開通碼」的 SHA-256（web/public/sim-codes.json），
 *   看得到檔案也推不回開通碼。
 * - 每個開通碼一份存檔，存在這台裝置的瀏覽器（localStorage），用同一個開通碼登入才讀得到。
 *   換裝置或清除瀏覽器資料後存檔不會跟著走。
 */
import type { SimState } from '../domain/sim';

export interface CodeEntry {
  id: string;
  label: string;
}

export interface CodeList {
  salt: string;
  codes: CodeEntry[];
}

/** 結束（或開新局時封存）的一局。 */
export interface SimRecord {
  start: string;
  end: string;
  days: number;
  capital: number;
  equity: number;
  /** 同期加權指數報酬（沒有資料時為 null）。 */
  bench: number | null;
  trades: number;
  endedAt: string;
}

export interface SimSave {
  current: SimState | null;
  history: SimRecord[];
}

const USER_KEY = 'lplc.sim.user';
const SAVE_PREFIX = 'lplc.sim.u.';
/** 第一版沒有開通碼時的存檔；第一個登入的開通碼會接收它。 */
const LEGACY_KEY = 'lplc.sim.v1';

/** 開通碼不分大小寫，忽略空白與連字號。 */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashCode(code: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + normalizeCode(code)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let codes: Promise<CodeList | null> | null = null;

export function loadCodes(): Promise<CodeList | null> {
  codes ??= fetch('sim-codes.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<CodeList>) : null))
    .then((j) => (j && typeof j.salt === 'string' && Array.isArray(j.codes) ? j : null))
    .catch(() => null);
  return codes;
}

/** 輸入的開通碼對應到哪一位玩家；不對就回傳 null。 */
export async function verifyCode(code: string, list: CodeList): Promise<CodeEntry | null> {
  if (normalizeCode(code).length < 12) return null;
  const id = await hashCode(code, list.salt);
  return list.codes.find((c) => c.id === id) ?? null;
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown): void {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 無痕模式等情況存不了，只是重新整理後會重來 */
  }
}

/** 這台裝置上次登入的玩家（開通碼雜湊）。 */
export function rememberedUser(): string | null {
  return read<string>(USER_KEY);
}

export function rememberUser(id: string | null): void {
  write(USER_KEY, id);
}

export function loadSave(id: string): SimSave {
  const s = read<SimSave>(SAVE_PREFIX + id);
  if (s && Array.isArray(s.history)) return { current: s.current?.v === 1 ? s.current : null, history: s.history };
  // 舊版（沒有開通碼）的存檔交給第一個登入的人
  const legacy = read<SimState>(LEGACY_KEY);
  const save: SimSave = { current: legacy?.v === 1 ? legacy : null, history: [] };
  if (legacy) {
    write(LEGACY_KEY, null);
    write(SAVE_PREFIX + id, save);
  }
  return save;
}

export function writeSave(id: string, save: SimSave): void {
  write(SAVE_PREFIX + id, save);
}
