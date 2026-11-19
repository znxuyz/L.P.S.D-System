/**
 * 預測的「事前存檔」：每天收盤後把下一個交易日的預測存進 forecasts 分支，等結果出來再打分數。
 *
 * - 只在收盤後（台北 14:30 以後）到下一個平日 08:45 之前存：一定是開盤前做的預測。
 * - 同一天只存一次、存了就不再改（不覆蓋）；forecasts 分支只會新增提交、不會強制覆寫，git 的提交時間可以證明是事前做的。
 * - 打分數時只用存檔裡的數字，跟之後模型怎麼改都無關：這是完全不可能「看答案」的成績。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export { canArchive } from './archiveTime.ts';

/** 寫入存檔；已經存在就不動（回傳 false）。 */
export function writeArchive(root: string, kind: string, asOf: string, data: unknown): boolean {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${asOf}.json`);
  if (existsSync(p)) return false;
  writeFileSync(p, JSON.stringify({ madeAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, asOf, ...(data as object) }));
  return true;
}

/** 讀出某一類的全部存檔（依日期排序）。 */
export function readArchives<T>(root: string | undefined, kind: string): Array<T & { madeAt: string; asOf: string }> {
  if (!root) return [];
  const dir = join(root, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((x) => x != null);
}

/**
 * 開盤前的存檔：同一天如果有早上（加了前一晚美股，kind＋'-am'）那份就用早上的，否則用前一晚收盤後那份。
 * 兩份都是開盤前存的；早上那份資訊比較完整。
 */
export function readPreOpen<T>(root: string | undefined, kind: string): Array<T & { madeAt: string; asOf: string; am?: boolean }> {
  const byDay = new Map<string, T & { madeAt: string; asOf: string; am?: boolean }>();
  for (const a of readArchives<T>(root, kind)) byDay.set(a.asOf, a);
  for (const a of readArchives<T>(root, `${kind}-am`)) byDay.set(a.asOf, { ...a, am: true });
  return [...byDay.values()].sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
}
