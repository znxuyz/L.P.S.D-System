/**
 * 產生拉普拉斯模擬盤的開通碼：
 *
 *   node scripts/sim-code.mjs "朋友名稱" [個數]
 *
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

function newCode() {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `LPLC-${s.match(/.{4}/g).join('-')}`;
}

const label = process.argv[2];
const count = Number(process.argv[3] ?? 1);
if (!label) {
  console.error('用法：node scripts/sim-code.mjs "朋友名稱" [個數]');
  process.exit(1);
}
let list;
try {
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
