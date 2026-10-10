/**
 * 模擬盤的開通碼與玩家存檔。
 *
 * - 開通碼由站長用 scripts/sim-code.mjs 產生，repo 裡只存「鹽＋開通碼」的 SHA-256（web/public/sim-codes.json），
 *   看得到檔案也推不回開通碼。
 * - 每個開通碼一份存檔，存在這台裝置的瀏覽器（localStorage），用同一個開通碼登入才讀得到。
 *   換裝置或清除瀏覽器資料後存檔不會跟著走。
 */
import { migrate, type SimState } from '../domain/sim';

export interface CodeEntry {
  id: string;
  label: string;
  /** 管理者：可以查看所有玩家的紀錄。 */
  admin?: boolean;
  /** 用管理者公鑰加密的「名稱＋雲端同步 ID」（只有管理者解得開）。 */
  vault?: string;
}

export interface CodeList {
  salt: string;
  codes: CodeEntry[];
  /** 管理者金鑰：公鑰明文，私鑰用管理者開通碼導出的金鑰加密。 */
  admin?: { pub: string; priv: { iv: string; data: string } };
}

/** 管理者解開後看到的玩家清單。 */
export interface PlayerRef {
  label: string;
  sync: string;
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
  /** 最後修改時間（毫秒），雲端同步時比較哪一邊比較新。 */
  updatedAt?: number;
}

const USER_KEY = 'lplc.sim.user';
const SYNC_PREFIX = 'lplc.sim.sync.';
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

/** 雲端同步用的 ID：和公開的開通碼雜湊用不同的前綴，沒有開通碼就算不出來。 */
export function syncIdFor(code: string, salt: string): Promise<string> {
  return hashCode(code, `sync:${salt}`);
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * 管理者登入：用開通碼導出的金鑰解開私鑰，再解開每位玩家的 vault，得到他們的雲端同步 ID。
 * 開通碼不對或資料被改過會丟出錯誤（AES-GCM 驗證失敗）。
 */
export async function openVault(code: string, list: CodeList): Promise<PlayerRef[]> {
  if (!list.admin) return [];
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`admin:${list.salt}` + normalizeCode(code)));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(list.admin.priv.iv) }, aes, b64(list.admin.priv.data));
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const out: PlayerRef[] = [];
  for (const c of list.codes) {
    if (!c.vault) continue;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, b64(c.vault));
      const ref = JSON.parse(new TextDecoder().decode(plain)) as PlayerRef;
      if (ref && typeof ref.sync === 'string') out.push({ label: c.label, sync: ref.sync });
    } catch {
      /* 這筆壞掉就略過 */
    }
  }
  return out;
}

const ADMIN_KEY = 'lplc.sim.players';

/** 管理者在這台裝置解開過的玩家清單（下次自動登入時不用再輸入開通碼）。 */
export function rememberedPlayers(): PlayerRef[] | null {
  return read<PlayerRef[]>(ADMIN_KEY);
}

export function rememberPlayers(list: PlayerRef[] | null): void {
  write(ADMIN_KEY, list);
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

/** 這台裝置記住的同步 ID（登入時由開通碼算出）。 */
export function rememberedSyncId(id: string): string | null {
  return read<string>(SYNC_PREFIX + id);
}

export function rememberSyncId(id: string, syncId: string | null): void {
  write(SYNC_PREFIX + id, syncId);
}

export function loadSave(id: string): SimSave {
  const s = read<SimSave>(SAVE_PREFIX + id);
  if (s && Array.isArray(s.history)) return { current: migrate(s.current), history: s.history, updatedAt: s.updatedAt };
  // 舊版（沒有開通碼）的存檔交給第一個登入的人
  const legacy = read<SimState>(LEGACY_KEY);
  const save: SimSave = { current: migrate(legacy), history: [] };
  if (legacy) {
    write(LEGACY_KEY, null);
    write(SAVE_PREFIX + id, save);
  }
  return save;
}

export function writeSave(id: string, save: SimSave): void {
  write(SAVE_PREFIX + id, save);
}
