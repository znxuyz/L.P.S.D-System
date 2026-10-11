# 維運手冊

日常維護 L.P.L.C. System 會用到的操作：開通碼、Firebase、自動化流程、資料、疑難排解。
指令都在 repo 根目錄執行，需要 Node.js 22 以上。

---

## 開通碼

模擬盤要輸入開通碼才能玩。開通碼 40 碼（`LPLC-` 開頭），每組對應一個玩家帳號與存檔。

### 原則
- **開通碼本身不會存進 repo。** `web/public/sim-codes.json` 只存「鹽＋開通碼」的雜湊、名稱，以及雲端用的雜湊值；看得到檔案也推不回開通碼。
- 產生時**只會印出這一次**，請自己保存（例如密碼管理器）後再傳給朋友。弄丟了只能發新的。
- 名稱（例如「玩家 3」）是公開的：會顯示在大廳與朋友排行榜上。不想公開真名就用代號。

### 新增玩家
```bash
node scripts/sim-code.mjs "玩家 11"          # 新增一位
node scripts/sim-code.mjs "同事" 3            # 新增三位：同事 1、同事 2、同事 3
```
程式會同時更新 `web/public/sim-codes.json` 與 `firestore.rules`（雲端白名單）。commit、push 到 `main` 後：
1. 網站自動重新部署（新的開通碼可以登入）；
2. 安全規則自動部署到 Firebase（新玩家才能同步存檔、上排行榜）。

兩個都跑完（GitHub → Actions 看到兩個綠勾）才算生效，通常 2～3 分鐘。

### 管理員（玩家 0）
- 目前已經有一位管理員。管理員登入後，大廳多一個「查看玩家紀錄」，可以唯讀查看所有玩家的存檔（看得到真實日期）。
- 原理：管理員有一組 RSA 金鑰，私鑰用管理員開通碼加密後放在 `sim-codes.json`；每位玩家的雲端同步 ID 用公鑰加密存在該玩家的 `vault` 欄位，只有管理員解得開。
  之後新增玩家時會自動加密登錄，不需要管理員開通碼。
- 要換管理員：從 `sim-codes.json` 刪掉 `admin` 欄位與管理員那一筆，再執行 `node scripts/sim-code.mjs --admin "玩家 0"`，
  然後用 `--enroll` 把既有玩家重新登錄給新的管理員（見下一節）。

### 補登錄既有玩家（`--enroll`）
準備一個文字檔，每行「名稱<Tab>開通碼」，然後：
```bash
node scripts/sim-code.mjs --enroll 玩家清單.txt
```
會幫檔案裡的每位玩家補上管理員 vault、雲端白名單與排行榜 ID。**這個檔案含有開通碼，用完就刪掉，不要 commit。**

### 停用某個開通碼
1. 從 `web/public/sim-codes.json` 刪掉那一筆；
2. 執行 `node scripts/sim-code.mjs --enroll /dev/null`（不新增任何人，只是依目前的清單重寫 `firestore.rules`）；
3. commit、push。

停用後那個開通碼無法登入，雲端存檔也不能再讀寫（資料還在 Firebase，只是進不去）。

### 全部重來
`node scripts/sim-code.mjs "玩家" 10 --reset` 會作廢**所有**舊開通碼（包含管理員）、重新產生鹽。舊存檔全部進不去。之後要再跑一次 `--admin` 建立管理員。

---

## Firebase（模擬盤雲端存檔）

- 專案：`lpsdsystem`（Spark 免費方案），資料庫 Firestore，位置 `asia-east1`。
- 網站用的設定在 `web/public/sync-config.json`（`projectId`、`apiKey`）。這兩個值本來就是公開的，安全性靠安全規則。
- 免費額度：每天讀取 5 萬次、寫入 2 萬次、儲存 1 GB；以目前 11 位玩家的用量遠低於上限。

### 資料
| 集合 | 文件 ID | 內容 | 誰能讀寫 |
|---|---|---|---|
| `sims` | 雲端同步 ID（由開通碼算出） | 整份模擬盤存檔（JSON 字串，上限約 800KB） | 只有白名單上的玩家；不能列出全部文件、不能刪除 |
| `boards` | 排行榜公開 ID | 排行榜成績 | 大家都能讀；只有本人寫得進去 |

### 安全規則（`firestore.rules`）
- **白名單**：規則裡有兩份清單，`players()` 是「雲端同步 ID 再做一次 SHA-256」，`boards()` 是排行榜公開 ID。
  Firebase 收到請求時自己算雜湊比對，對不上就拒絕。清單公開也推不回同步 ID。
  這兩份清單由 `scripts/sim-code.mjs` 自動改寫，**不要手動編輯標記之間的內容**。
- **排行榜防冒名（雜湊鏈）**：從玩家的同步 ID 導出一串數字 k0 → k1 = SHA-256(k0) → ⋯ → k100000，最後一個就是公開 ID。
  文件裡存著目前用到的那一格；下次寫入要附上「前一格」，規則檢查它的雜湊等於目前那一格才放行。
  別人看得到目前那一格，但推不回前一格，所以沒辦法冒名寫入。每寫一次往回用一格，十萬次足夠用很多年。

### 自動部署安全規則
改了 `firestore.rules`（或 `firebase.json`、workflow 本身）並合併到 `main`，`.github/workflows/deploy-firestore-rules.yml` 會自動部署。需要：
1. GitHub repo → Settings → Secrets and variables → Actions → `FIREBASE_SERVICE_ACCOUNT`：
   Firebase 主控台「專案設定 → 服務帳戶 → 產生新的私密金鑰」下載的整個 JSON。
   **這把金鑰權限很大，只能放在 GitHub Secrets，不要 commit、不要貼到任何對話或文件裡。**
2. [Google Cloud IAM](https://console.cloud.google.com/iam-admin/iam?project=lpsdsystem) 幫這個服務帳戶（`firebase-adminsdk-…`）加上「Firebase Rules Admin」角色。

部署失敗時，到 GitHub → Actions → Deploy Firestore rules 看紀錄（見下方疑難排解）。

---

## 自動化流程（GitHub Actions）

| Workflow | 什麼時候跑 | 做什麼 |
|---|---|---|
| `update-data.yml` | 週一到五台北時間 18:37、22:07；另外每小時第 23 分回補舊資料 | 抓證交所、櫃買、公開資訊觀測站、集保、投信的資料（含 ETF 淨值、規模、受益人數、配息：`etf-info.ts`），推到 `data` 分支；跑完自動觸發網站部署。三組來源平行跑，每次最多 50 分鐘，下次從斷點繼續。 |
| `deploy-pages.yml` | push 到 `main`、資料更新完 | 拿 `data` 分支的資料，產生模擬盤每日行情（`sim-daily.ts`）、新聞（`sim-news.ts`）、首頁的收盤資料（`close-snapshot.ts`），打包網站部署到 GitHub Pages。 |
| `deploy-firestore-rules.yml` | `firestore.rules` 有改動並合併到 `main` | 部署 Firestore 安全規則。 |

想立刻重跑：GitHub → Actions → 選 workflow → Run workflow。

### `data` 分支
- 每天的資料都存在這裡（日 K、法人、本益比、財報、重大訊息、除權息、加權指數、千張大戶、型態勝率⋯⋯），從 2020-01-01 起完整保存。
- 每次更新只保留最新一個版本（覆蓋舊的 commit），儲存庫不會越來越大。
- 網站的資料總量約 300 MB，GitHub Pages 的上限是 1 GB；資料每天增加，大約一兩年後要再檢查一次。

---

## 疑難排解

| 狀況 | 原因與處理 |
|---|---|
| 朋友說手機上還是舊版 | Service Worker 會先用手機裡存好的版本。把網頁或 App 完全關掉再打開一次就會更新。 |
| 模擬盤顯示「暫時連不上雲端」 | 網路問題時進度會先存在手機，之後自動補傳。一直無法同步的話，確認那位玩家在 `sim-codes.json` 裡有 `w` 欄位、`firestore.rules` 的 `players()` 清單有對應的值，而且規則部署成功。 |
| 新玩家能登入，但不能同步、沒有上排行榜 | 安全規則還沒部署或部署失敗。看 Actions 的 Deploy Firestore rules。 |
| 規則部署出現 403 `The caller does not have permission` | 服務帳戶沒有「Firebase Rules Admin」角色，或剛加上還沒生效（等幾分鐘再重跑）。 |
| 規則部署出現認證錯誤 | `FIREBASE_SERVICE_ACCOUNT` 沒設定或內容不完整（要貼整個 JSON）。 |
| 排行榜一直「讀取中」或「讀取失敗」 | 網路問題，或那位玩家的 `board` 不在 `boards()` 清單裡。 |
| 資料沒有更新 | 看 Actions 的 Update market data。官方網站偶爾會改格式或暫時擋連線；失敗的部分下一次排程會從斷點繼續。 |
| 首頁一直顯示「模擬行情」 | 預設是「收盤」模式，讀不到 `data/close.json` 才會退回模擬。看 Deploy to GitHub Pages 的「產生模擬盤資料」步驟有沒有印出 `close.json：日期，N 檔`。 |
| ETF 頁某些欄位一直標「模擬」 | 內扣費用率、被動式 ETF 成分股本來就沒有公開資料。其他欄位標模擬的話，看 Update market data 的 twse 紀錄裡 `ETF 淨值`、`e添富` 那幾行。上櫃 ETF（例如債券 ETF）沒有 e添富頁面，配息改用除權息資料。 |
| 開通碼弄丟了 | 開通碼沒有存在任何地方，救不回來。發一組新的給他；舊的可以停用（雲端上的舊存檔無法搬到新帳號）。 |

更細的網站功能與即時行情設定（富果、證交所轉接），見 [`web/README.md`](../web/README.md)。
