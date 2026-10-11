/**
 * 朋友排行榜（Firestore 的 boards/<公開 ID>，大家都讀得到，只有本人寫得進去）。
 *
 * 怎麼證明「是本人」又不洩漏密碼：用雜湊鏈。
 * - 由自己的雲端同步 ID 導出種子 k0，k1 = SHA-256(k0)、k2 = SHA-256(k1)⋯⋯ 一直到 kN；kN 就是公開 ID（登記在 sim-codes.json 與安全規則裡）。
 * - 文件裡存著目前的 k_n。下一次寫入要附上 k_(n-1)，安全規則檢查 SHA-256(k_(n-1)) == k_n 才放行。
 * - 別人看得到 k_n，但雜湊推不回去，算不出 k_(n-1)，所以沒辦法冒名寫入。每寫一次往回用一格，N 夠用很多年。
 */
import { sha256Hex } from './sha256';
import type { SyncConfig } from './simSync';
import type { BoardStats } from '../domain/simRank';

/** 雜湊鏈長度（和 scripts/sim-code.mjs 相同）。 */
export const CHAIN_N = 100_000;
const STEP = 1000;

export function boardSeed(syncId: string): string {
  return sha256Hex(`board|${syncId}`);
}

/** 每 1000 格存一個檢查點，往後算第 i 格不用每次從頭來。 */
const checkpoints = new Map<string, string[]>();
const idle = () => new Promise<void>((r) => setTimeout(r, 0));

/** 鏈上第 i 格。第一次要算上萬次雜湊，分段讓出主執行緒，不會卡住畫面。 */
export async function chainAt(seed: string, i: number): Promise<string> {
  let cp = checkpoints.get(seed);
  if (!cp) checkpoints.set(seed, (cp = [seed]));
  const j = Math.min(Math.floor(i / STEP), cp.length - 1);
  let k = cp[j];
  for (let n = j * STEP + 1; n <= i; n++) {
    k = sha256Hex(k);
    if (n % STEP === 0) {
      if (n / STEP === cp.length) cp.push(k);
      if (n % (STEP * 2) === 0) await idle();
    }
  }
  return k;
}

export interface BoardEntry {
  stats: BoardStats;
  updatedAt: number;
}

function url(cfg: SyncConfig, id: string): string {
  const key = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : '';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/boards/${id}${key}`;
}

interface Doc {
  fields?: { n?: { integerValue?: string }; s?: { stringValue?: string }; updatedAt?: { integerValue?: string } };
}

async function getDoc(cfg: SyncConfig, id: string): Promise<Doc | null> {
  const res = await fetch(url(cfg, id), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Doc;
}

export async function pullBoard(cfg: SyncConfig, id: string): Promise<BoardEntry | null> {
  const doc = await getDoc(cfg, id);
  const raw = doc?.fields?.s?.stringValue;
  if (!raw) return null;
  try {
    return { stats: JSON.parse(raw) as BoardStats, updatedAt: Number(doc!.fields!.updatedAt?.integerValue ?? 0) };
  } catch {
    return null;
  }
}

/** 寫入自己的排行榜成績；別台裝置剛好也在寫（鏈的位置對不上）時重試一次。 */
export async function pushBoard(cfg: SyncConfig, syncId: string, stats: BoardStats): Promise<void> {
  const seed = boardSeed(syncId);
  const id = await chainAt(seed, CHAIN_N);
  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = await getDoc(cfg, id);
    const n = doc ? Number(doc.fields?.n?.integerValue ?? CHAIN_N) : CHAIN_N;
    if (!(n > 1)) throw new Error('排行榜的驗證鏈用完了');
    const body = JSON.stringify({
      fields: {
        k: { stringValue: await chainAt(seed, n - 1) },
        n: { integerValue: String(n - 1) },
        s: { stringValue: JSON.stringify(stats) },
        updatedAt: { integerValue: String(Date.now()) },
      },
    });
    const res = await fetch(url(cfg, id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return;
    if (res.status !== 403 || attempt) throw new Error(`HTTP ${res.status}`);
  }
}
