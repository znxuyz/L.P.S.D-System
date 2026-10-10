/**
 * 模擬盤的新聞欄：把幾種來源整理成簡短標題，依日期存成 news/<年>.json。
 *
 *   node scripts/sim-news.ts <資料資料夾>   （需要先跑過 sim-daily.ts）
 *
 * 來源：
 * 1. 國內外大事件（scripts/data/macro-news.json）：改寫成不直接點名的標題，避免玩家一看就想起日期；開盤前（09:00）出現。
 * 2. 公司重大訊息（events/<日期>.json，公開資訊觀測站）：簡化成「公司：事項」，重要的全收、例行的抽樣；收盤後（13:30）出現。
 * 3. 盤勢（加權指數、漲跌停家數、成交量、法人買賣超）：由當天真實行情產生；收盤後（13:30）出現，盤中看不到當天結果。
 *
 * 輸出：news/<年>.json = [[日期, "HH:MM", 重要度 1～3, 標題], …]（1 = 重要、3 = 例行）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type News = [string, string, 1 | 2 | 3, string];

const dir = process.argv[2] ?? 'data';
const here = dirname(fileURLToPath(import.meta.url));

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 同一個輸入永遠得到同一個亂數（每次重跑結果一樣）。 */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const names: Record<string, string> = {
  ...Object.fromEntries((readJson<{ stocks?: Array<{ code: string; name: string }> }>(join(dir, 'stocks.json'), {}).stocks ?? []).map((s) => [s.code, s.name])),
  ...readJson<Record<string, string>>(join(dir, 'names.json'), {}),
};
const news: News[] = [];

// ------------------------------------------------------------ 1. 大事件
for (const [date, level, title] of readJson<Array<[string, 1 | 2, string]>>(join(here, 'data', 'macro-news.json'), [])) news.push([date, '09:00', level, title]);

// ------------------------------------------------------------ 2. 公司重大訊息
const IMPORTANT = /合併(?!營|財|報|損|業)|收購|併購|減資|增資|私募|處分|取得.*(股權|廠房|土地)|重大.*(訂單|合約|契約)|簽訂|董事長|總經理|執行長|停工|火災|災害|罰鍰|裁罰|違約|重整|下市|下櫃|停止買賣|庫藏股|澄清|媒體報導|訴訟|跳票|退票|研發成果|新藥|授權|核准|專利|擴廠|投資案/;
const ROUTINE = /營業額|營收|法說會|法人說明會|業績說明會|財務報告|財務報表|股東常會|股東會|更正|補發|補充|代子公司.*(董事會|財報)|受邀|自結|資金貸與|背書保證|董事會日期|召開/;

/** 把公告主旨改寫成短標題。 */
function cleanSubject(s: string): string {
  // 中文之間的空白（原文換行造成）去掉
  let t = s.replace(/\s+/g, ' ').replace(/(?<=[\u3000-\u9fff]) (?=[\u3000-\u9fff])/g, '').trim();
  t = t.replace(/^(更補正|補發|更正|補充)[.。：:、\s]*/, '');
  t = t.replace(/^代(重要)?子公司.*?(股份有限公司|有限公司|公司|CO\.?,? ?LTD\.?|LTD\.?|LIMITED|INC\.?)\s*(公告)?/i, '子公司');
  t = t.replace(/^代(重要)?子公司\S*\s*(公告)?/, '子公司');
  t = t.replace(/^(公告)?本公司/, '');
  t = t.replace(/^公告\s*/, '');
  // 拿掉會洩漏日期的年份、月份、日期（民國年、西元年、國字年）
  t = t.replace(/\d{2,4}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{1,2}/g, '');
  t = t.replace(/(\d{2,4}|[一二三四五六七八九○〇零]{3})\s*年\s*(度)?\s*(第[一二三四1-4]季|\d{1,2}\s*月(份)?)?/g, (_m, _y, du, q, mo) => (q ? '本季' : mo ? '上月' : du ? '年度' : ''));
  t = t.replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, '');
  t = t.replace(/(?<!\d)(19|20)\d{2}(?!\d)/g, '');
  t = t.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
  t = t.replace(/[(（][^)）]*[)）]/g, '');
  t = t.replace(/(相關|之)?事宜$/, '').replace(/[。.]$/, '');
  t = t.replace(/本公司/g, '').replace(/\s{2,}/g, ' ').trim();
  return t.length > 30 ? `${t.slice(0, 29)}…` : t;
}

const eventFiles = existsSync(join(dir, 'events')) ? readdirSync(join(dir, 'events')).filter((f) => f.endsWith('.json')) : [];
for (const f of eventFiles) {
  const date = f.slice(0, 10);
  const rows = readJson<Array<[string, string, string]>>(join(dir, 'events', f), []);
  const important: News[] = [];
  const routine: News[] = [];
  const seen = new Set<string>();
  for (const [code, , subject] of rows) {
    const name = names[code];
    if (!name || !subject) continue;
    const body = cleanSubject(subject);
    if (body.length < 4) continue;
    const title = `${name}：${body}`;
    if (seen.has(title)) continue;
    seen.add(title);
    if (IMPORTANT.test(subject) && !ROUTINE.test(subject)) important.push([date, '13:30', 2, title]);
    else routine.push([date, '13:30', 3, title]);
  }
  // 重要的最多 5 則、例行的抽 4 則（固定抽法，每次重跑一樣）
  const pick = (list: News[], n: number) => list.sort((a, b) => hash(a[3]) - hash(b[3])).slice(0, n);
  news.push(...pick(important, 5), ...pick(routine, 4));
}

// ------------------------------------------------------------ 3. 盤勢
const taiex = readJson<Array<[string, number, number, number, number]>>(join(dir, 'index', 'TAIEX.json'), []);
const pctTxt = (p: number) => `${Math.abs(p).toFixed(2)}%`;
/** 只寫漲跌幅，不寫點數（點數會洩漏指數所在的年代）。 */
function indexHeadline(p: number): [1 | 2 | 3, string] {
  if (p <= -5) return [1, `台股崩跌 ${pctTxt(p)}，恐慌賣壓全面湧現`];
  if (p <= -3) return [1, `台股重挫 ${pctTxt(p)}，市場信心動搖`];
  if (p <= -1.5) return [2, `台股大跌 ${pctTxt(p)}，賣壓沉重`];
  if (p <= -0.5) return [3, `台股走低 ${pctTxt(p)}`];
  if (p < 0.5) return [3, `台股平盤附近震盪，${p >= 0 ? '小漲' : '小跌'} ${pctTxt(p)}`];
  if (p < 1.5) return [3, `台股走高 ${pctTxt(p)}`];
  if (p < 3) return [2, `台股大漲 ${pctTxt(p)}，買氣回籠`];
  if (p < 5) return [1, `台股強彈 ${pctTxt(p)}，多方氣勢如虹`];
  return [1, `台股暴漲 ${pctTxt(p)}，創罕見單日漲幅`];
}
const vol20: number[] = [];
const simdayDir = join(dir, 'simday');
const months = existsSync(simdayDir) ? readdirSync(simdayDir).filter((f) => f.endsWith('.json')).sort() : [];
/** 每天：漲停、跌停家數、總成交張數 */
const breadth = new Map<string, { up: number; down: number; vol: number; close: Record<string, number> }>();
for (const m of months) {
  const { codes, days } = readJson<{ codes: string[]; days: Record<string, Array<number[] | 0>> }>(join(simdayDir, m), { codes: [], days: {} });
  for (const [date, rows] of Object.entries(days)) {
    let up = 0;
    let down = 0;
    let vol = 0;
    const close: Record<string, number> = {};
    rows.forEach((r, i) => {
      if (!r) return;
      const [, , , c, v, pc] = r;
      vol += v;
      close[codes[i]] = c;
      if (pc && c >= pc * 1.095) up++;
      if (pc && c <= pc * 0.905) down++;
    });
    breadth.set(date, { up, down, vol, close });
  }
}
for (let i = 1; i < taiex.length; i++) {
  const [date, , , , c] = taiex[i];
  const prev = taiex[i - 1][4];
  const p = ((c - prev) / prev) * 100;
  const [level, title] = indexHeadline(p);
  news.push([date, '13:30', level, title]);
  const b = breadth.get(date);
  if (b) {
    if (b.up >= 40) news.push([date, '13:30', 2, `漲停家數多達 ${b.up} 檔，市場追價氣氛熱絡`]);
    if (b.down >= 40) news.push([date, '13:30', 2, `跌停家數多達 ${b.down} 檔，多殺多賣壓沉重`]);
    const avg = vol20.length ? vol20.reduce((a, x) => a + x, 0) / vol20.length : 0;
    if (avg && b.vol > avg * 1.6) news.push([date, '13:30', 2, '市場成交量明顯放大，較近月平均多出五成以上']);
    else if (avg && b.vol < avg * 0.6) news.push([date, '13:30', 3, '市場量能急縮，觀望氣氛濃厚']);
    vol20.push(b.vol);
    if (vol20.length > 20) vol20.shift();
    // 法人（外資＋投信）買賣超金額：買賣超張數 × 收盤價
    const inst = readJson<Record<string, number> | null>(join(dir, 'inst', `${date}.json`), null);
    if (inst) {
      const flows = Object.entries(inst)
        .map(([code, shares]) => [code, ((shares / 1000) * (b.close[code] ?? 0) * 1000) / 1e8] as const)
        .filter(([, v]) => Number.isFinite(v));
      const total = flows.reduce((a, [, v]) => a + v, 0);
      if (Math.abs(total) >= 5) {
        const top = [...flows].sort((x, y) => (total > 0 ? y[1] - x[1] : x[1] - y[1])).slice(0, 3).map(([code]) => names[code] ?? code);
        news.push([date, '13:30', Math.abs(total) >= 300 ? 2 : 3, `外資與投信合計${total > 0 ? '買超' : '賣超'}約 ${Math.round(Math.abs(total))} 億元，${total > 0 ? '買超' : '賣超'}前三名為${top.join('、')}`]);
      }
    }
  }
}

// ------------------------------------------------------------ 輸出
const out = join(dir, 'news');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const byYear = new Map<string, News[]>();
for (const n of news) {
  const y = n[0].slice(0, 4);
  (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(n);
}
for (const [y, list] of byYear) {
  list.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : a[2] - b[2]));
  writeFileSync(join(out, `${y}.json`), JSON.stringify(list));
}
console.log(`完成：${news.length} 則新聞，${[...byYear.keys()].sort().join('、')}`);
