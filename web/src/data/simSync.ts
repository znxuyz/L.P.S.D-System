/**
 * 模擬盤存檔的雲端同步（Firebase Firestore 免費方案，用 REST API，不載入 Firebase SDK）。
 *
 * - 設定檔 web/public/sync-config.json：{ "projectId": "...", "apiKey": "..." }；沒有這個檔就只存在本機。
 * - 每個開通碼一份文件 sims/<同步 ID>。同步 ID = SHA-256("sync:" + 鹽 + 開通碼)，
 *   和 sim-codes.json 裡公開的雜湊不同，沒有開通碼就算不出來，也就讀寫不到別人的存檔。
 * - Firestore 的安全規則見 repo 根目錄的 firestore.rules（只允許用完整 ID 讀寫、不能列出全部文件）。
 * - Firestore 不支援陣列裡放陣列，所以整份存檔轉成 JSON 字串存在 data 欄位。
 */
import type { SimSave } from './simAccount';

export interface SyncConfig {
  projectId: string;
  apiKey?: string;
}

let config: Promise<SyncConfig | null> | null = null;

export function loadSyncConfig(): Promise<SyncConfig | null> {
  config ??= fetch('sync-config.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<SyncConfig>) : null))
    .then((j) => (j && typeof j.projectId === 'string' && j.projectId ? j : null))
    .catch(() => null);
  return config;
}

function docUrl(cfg: SyncConfig, id: string): string {
  const key = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : '';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/sims/${id}${key}`;
}

/** 讀雲端存檔：null = 雲端還沒有；丟出錯誤 = 連不上。 */
export async function pullSave(cfg: SyncConfig, id: string): Promise<SimSave | null> {
  const res = await fetch(docUrl(cfg, id), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { fields?: { data?: { stringValue?: string } } };
  const raw = j.fields?.data?.stringValue;
  if (!raw) return null;
  const save = JSON.parse(raw) as SimSave;
  return save && Array.isArray(save.history) ? save : null;
}

/** 寫入雲端存檔（整份覆蓋）。keepalive：關閉網頁時也能送出。 */
export async function pushSave(cfg: SyncConfig, id: string, save: SimSave, keepalive = false): Promise<void> {
  const body = JSON.stringify({
    fields: {
      data: { stringValue: JSON.stringify(save) },
      updatedAt: { integerValue: String(save.updatedAt ?? 0) },
    },
  });
  const res = await fetch(docUrl(cfg, id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
