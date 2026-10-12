/**
 * 隨機開局：從「值得練習的行情」裡抽一個起點，或抽一個至少一年前的日期。
 *
 * - 起點至少要在最新資料一年前（約 245 個交易日），才不會玩沒幾天就沒資料了。
 * - 情境的起點故意抓在事件前幾週，並隨機再往前 0～10 個交易日，同一個情境每次開局的日子不一樣。
 * - 玩的時候不會告訴你抽到哪個情境，結束報告才揭曉。
 */
export interface Scenario {
  /** 起點（事件前幾週）。 */
  start: string;
  /** 結束報告揭曉時的說明。 */
  label: string;
}

export const SCENARIOS: Scenario[] = [
  { start: '2020-04-06', label: '2020 年疫情崩跌後的 V 型反彈' },
  { start: '2020-10-19', label: '2020 年底美國大選後，外資大買、台股創 30 年新高' },
  { start: '2021-04-12', label: '2021 年航運狂潮與 5 月本土疫情急跌' },
  { start: '2021-12-20', label: '2022 年升息空頭：加權指數從 18,000 點跌到 12,000 點' },
  { start: '2022-09-19', label: '2022 年熊市尾聲到 2023 年初反彈' },
  { start: '2023-05-08', label: '2023 年 AI 伺服器概念股狂潮' },
  { start: '2024-06-17', label: '2024 年 7 月高點回檔與 8/5 單日大跌' },
  { start: '2025-03-10', label: '2025 年對等關稅風暴與之後的反彈' },
];

/** 至少要離最新資料這麼多個交易日（約一年）。 */
export const MIN_LEFT_DAYS = 245;
/** 抽到情境的機率（其他時候抽一個至少一年前的任意日期）。 */
const SCENARIO_RATE = 0.7;

export interface RandomStart {
  idx: number;
  scenario?: string;
}

/**
 * 從交易日曆（由舊到新）抽一個起點。
 * minIdx：最早可以開局的位置（前面要留資料給均線、型態）。
 */
export function pickRandomStart(cal: string[], minIdx: number, rnd: () => number = Math.random): RandomStart {
  const last = cal.length - 1;
  let maxIdx = last - MIN_LEFT_DAYS;
  // 資料不到一年多的時候（只有開發環境會這樣）退回至少留一個月
  if (maxIdx < minIdx) maxIdx = Math.max(minIdx, last - 21);
  const usable = SCENARIOS.map((s) => ({ s, i: cal.findIndex((d) => d >= s.start) })).filter(({ i }) => i >= minIdx && i <= maxIdx);
  if (usable.length && rnd() < SCENARIO_RATE) {
    const { s, i } = usable[Math.floor(rnd() * usable.length)];
    return { idx: Math.max(minIdx, i - Math.floor(rnd() * 11)), scenario: s.label };
  }
  return { idx: minIdx + Math.floor(rnd() * (maxIdx - minIdx + 1)) };
}
