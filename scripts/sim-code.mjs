/**
 * 產生拉普拉斯模擬盤的開通碼：
 *
 *   node scripts/sim-code.mjs "朋友名稱" [個數]
 *
 * - 開通碼 40 碼（LPLC＋36 個隨機字元）。加上 --reset 會清掉所有舊的開通碼、重新產生鹽。
 * - 印出新的開通碼（只會出現這一次，請自己保存後傳給朋友）。
 * - web/public/sim-codes.json 只寫入「鹽＋開通碼」的 SHA-256 與名稱，不存開通碼本身。
 *   名稱會公開在網站上（登入後顯示「歡迎，名稱」），不想公開可以用代號。
 * - 要停用某個開通碼：從 sim-codes.json 刪掉那一行（該開通碼的存檔仍留在對方瀏覽器，只是進不去）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../web/public/sim-codes.json', import.meta.url));
// 去掉容易看錯的 0/O、1/I/L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 開通碼共 40 碼：LPLC + 36 個隨機字元，每 4 碼一組。 */
const RANDOM_LEN = 36;

function newCode() {
  let s = '';
  // 拒絕取樣：只用 < 248（31 的倍數）的位元組，避免字元出現機率不均
  while (s.length < RANDOM_LEN) {
    for (const b of randomBytes(64)) {
      if (b < 248 && s.length < RANDOM_LEN) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return `LPLC-${s.match(/.{4}/g).join('-')}`;
}

const reset = process.argv.includes('--reset');
const args = process.argv.slice(2).filter((a) => a !== '--reset');
const label = args[0];
const count = Number(args[1] ?? 1);
if (!label) {
  console.error('用法：node scripts/sim-code.mjs "朋友名稱" [個數] [--reset]');
  process.exit(1);
}
let list;
try {
  if (reset) throw new Error('reset');
  list = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  list = { salt: randomBytes(12).toString('hex'), codes: [] };
}
for (let i = 0; i < count; i++) {
  const code = newCode();
  const id = createHash('sha256').update(list.salt + code.replace(/[^A-Z0-9]/g, '')).digest('hex');
  const name = count > 1 ? `${label} ${i + 1}` : label;
  list.codes.push({ id, label: name });
  console.log(`${name}\t${code}`);
}
writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
