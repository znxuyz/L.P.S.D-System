/**
 * 產生拉普拉斯模擬盤的開通碼：
 *
 *   node scripts/sim-code.mjs "朋友名稱" [個數]          新增一般玩家
 *   node scripts/sim-code.mjs --admin ["玩家 0"]         新增管理者（可以查看所有玩家的紀錄）
 *   node scripts/sim-code.mjs --enroll <檔案>            把既有玩家登錄給管理者（檔案每行「名稱<Tab>開通碼」）
 *   加上 --reset 會清掉所有舊的開通碼、重新產生鹽。
 *
 * - 開通碼 40 碼（LPLC＋36 個隨機字元），只會印出這一次，請自己保存後傳給朋友。
 * - web/public/sim-codes.json 只寫入「鹽＋開通碼」的 SHA-256 與名稱，不存開通碼本身。
 *   名稱會公開在網站上（登入後顯示「歡迎，名稱」），不想公開可以用代號。
 * - 管理者：產生一組 RSA 金鑰，私鑰用「管理者開通碼」導出的金鑰（AES-GCM）加密後才存進檔案，公鑰明文存放。
 *   之後每新增一個玩家，就用公鑰把「名稱＋雲端同步 ID」加密存在該玩家的 vault 欄位；
 *   只有輸入管理者開通碼才解得開，拿到同步 ID 後才能讀取那位玩家的雲端存檔。新增玩家不需要管理者開通碼。
 * - 要停用某個開通碼：從 sim-codes.json 刪掉那一筆（該開通碼的存檔仍留在雲端，只是進不去）。
 */
import { createCipheriv, createHash, constants, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
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

const norm = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha256 = (s) => createHash('sha256').update(s);
/** 公開的開通碼雜湊（登入驗證用）。 */
const idOf = (salt, code) => sha256(salt + norm(code)).digest('hex');
/** 雲端同步 ID（和 web/src/data/simAccount.ts 的 syncIdFor 相同）。 */
const syncOf = (salt, code) => sha256(`sync:${salt}` + norm(code)).digest('hex');
/** 由管理者開通碼導出的 AES-256 金鑰（和網頁端相同）。 */
const adminKeyOf = (salt, code) => sha256(`admin:${salt}` + norm(code)).digest();

/** 用管理者公鑰把玩家的名稱與同步 ID 加密（RSA-OAEP / SHA-256，網頁端用 WebCrypto 解）。 */
function seal(list, label, sync) {
  if (!list.admin?.pub) return undefined;
  const key = `-----BEGIN PUBLIC KEY-----\n${list.admin.pub}\n-----END PUBLIC KEY-----\n`;
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.stringify({ label, sync }))).toString('base64');
}

const argv = process.argv.slice(2);
const reset = argv.includes('--reset');
const admin = argv.includes('--admin');
const enrollAt = argv.indexOf('--enroll');
const enrollFile = enrollAt >= 0 ? argv[enrollAt + 1] : null;
const args = argv.filter((a, i) => !a.startsWith('--') && !(enrollAt >= 0 && i === enrollAt + 1));

let list;
try {
  if (reset) throw new Error('reset');
  list = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  list = { salt: randomBytes(12).toString('hex'), codes: [] };
}

if (admin) {
  if (list.admin) {
    console.error('已經有管理者了；要換新的請先從 sim-codes.json 刪掉 admin 欄位與管理者那一筆。');
    process.exit(1);
  }
  const label = args[0] ?? '玩家 0';
  const code = newCode();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', adminKeyOf(list.salt, code), iv);
  // WebCrypto 的 AES-GCM 密文＝加密內容後面接 16 位元組的驗證碼
  const data = Buffer.concat([cipher.update(pkcs8), cipher.final(), cipher.getAuthTag()]);
  list.admin = {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: { iv: iv.toString('base64'), data: data.toString('base64') },
  };
  list.codes.unshift({ id: idOf(list.salt, code), label, admin: true });
  console.log(`${label}（管理者）\t${code}`);
} else if (enrollFile) {
  if (!list.admin) {
    console.error('還沒有管理者，請先執行 --admin');
    process.exit(1);
  }
  for (const line of readFileSync(enrollFile, 'utf8').split('\n')) {
    const [label, code] = line.split('\t').map((s) => s?.trim());
    if (!label || !code) continue;
    const entry = list.codes.find((c) => c.id === idOf(list.salt, code));
    if (!entry) {
      console.log(`  找不到：${label}`);
      continue;
    }
    entry.vault = seal(list, entry.label, syncOf(list.salt, code));
    console.log(`  已登錄：${entry.label}`);
  }
} else {
  const label = args[0];
  const count = Number(args[1] ?? 1);
  if (!label) {
    console.error('用法：node scripts/sim-code.mjs "朋友名稱" [個數] | --admin ["名稱"] | --enroll <檔案>  [--reset]');
    process.exit(1);
  }
  for (let i = 0; i < count; i++) {
    const code = newCode();
    const name = count > 1 ? `${label} ${i + 1}` : label;
    const entry = { id: idOf(list.salt, code), label: name };
    const vault = seal(list, name, syncOf(list.salt, code));
    if (vault) entry.vault = vault;
    list.codes.push(entry);
    console.log(`${name}\t${code}`);
  }
}
writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
