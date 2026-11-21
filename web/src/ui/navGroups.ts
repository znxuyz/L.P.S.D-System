/**
 * 導覽分組（只是外層的導覽，頁面網址 #map、#stock… 與切換頁面的程式都不變）：
 * 市場（熱力圖、市場情報）、選股（五大選股、ETF）、個股、預測、更多（股市入門、模擬盤、設定）。
 * - 手機：底部 5 個按鈕；有兩個子頁的組在內容上方顯示左右切換。
 * - 每組記住上次看的子頁：在「選股」看過 ETF，下次按「選股」直接回到 ETF。
 */
export const PAGE_GROUP: Record<string, string> = { map: 'market', intel: 'market', screen: 'pick', etf: 'pick', stock: 'stock', predict: 'predict', learn: 'more', sim: 'more' };
const KEY = 'lplc.navLast';
let last: Record<string, string> = {};
try {
  last = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
} catch {
  last = {};
}

/** 每次換頁時呼叫：標出目前的組、更新底部按鈕要去的子頁。 */
export function syncNav(page: string): void {
  const g = PAGE_GROUP[page] ?? 'market';
  const app = document.querySelector<HTMLElement>('.app');
  if (app) app.dataset.group = g;
  if (page !== 'sim') {
    last[g] = page;
    try {
      localStorage.setItem(KEY, JSON.stringify(last));
    } catch {
      /* 存不了就算了 */
    }
  }
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#tabbar a')) {
    const ag = a.dataset.group!;
    if (ag === g) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    const to = last[ag];
    if (to && PAGE_GROUP[to] === ag) a.setAttribute('href', `#${to}`);
  }
}

/** 一次性的介面行為：設定面板關閉、加權指數展開、熱力圖說明第一次自動打開、「模擬盤」入口。 */
export function initNav(enterSim: () => void): void {
  const menu = document.querySelector<HTMLDetailsElement>('details.menu');
  document.querySelector('#menu-close')?.addEventListener('click', () => menu && (menu.open = false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu?.open) menu.open = false;
  });
  // 打開設定時背景不要跟著捲動
  menu?.addEventListener('toggle', () => document.documentElement.classList.toggle('menu-open', menu.open));
  // 手機上加權指數只顯示一行，點一下展開成交額、漲跌家數
  const ticker = document.querySelector<HTMLElement>('#ticker');
  ticker?.addEventListener('click', () => ticker.classList.toggle('is-open'));
  // 熱力圖的讀圖說明：第一次使用自動打開，之後收起
  const legend = document.querySelector<HTMLDetailsElement>('#map-legend');
  // （使用者自己收起來才記下「看過了」：網站載入後可能自動重新整理一次，不能一打開就記）
  try {
    if (legend && !localStorage.getItem('lplc.legendSeen')) {
      legend.open = true;
      legend.addEventListener('toggle', () => {
        if (!legend.open) localStorage.setItem('lplc.legendSeen', '1');
      });
    }
  } catch {
    /* 無痕模式：維持收起 */
  }
  // 點說明以外的地方就收起來
  document.addEventListener('click', (e) => {
    if (legend?.open && !legend.contains(e.target as Node)) legend.open = false;
  });
  for (const b of document.querySelectorAll<HTMLElement>('[data-sim-entry]')) b.addEventListener('click', enterSim);
}
