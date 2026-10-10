/**
 * 「拉普拉斯之妖」的進出場動畫：按下左上角圖示時全畫面播放。
 *
 * 進場（甦醒，約 3.3 秒）：刻度環與軌道收攏旋轉 → 豎瞳之眼張開、四周流過數字 → 打出拉普拉斯的名句
 * → 瞳孔放大、鏡頭衝進瞳孔，畫面亮起後淡出到模擬盤。
 * 離場（闔眼，約 2.3 秒）：數字往上倒流、刻度環散開 → 瞳孔收回細縫 → 眼睛闔成一道光後消散，回到原本畫面。
 * 點一下或按 Esc 可以跳過；系統設定「減少動態效果」時只做淡入淡出。
 *
 * 手機效能：
 * - 會旋轉、縮放的部分各自是獨立的 <svg>／<div>，動畫只改 transform 與 opacity，交給 GPU 合成，不佔主執行緒。
 * - 名句一開始就整句排好版，用每個字的淡入做「打字」，不會每 32 毫秒重新排版。
 * - 動畫期間底下的頁面隱藏、停止重畫（body.laplace-busy），切換頁面在畫面完全被蓋住時進行，
 *   等新頁面畫好兩個影格後才開始淡出，避免切換那一下卡頓。
 */

const QUOTE = '若有一位智者，知道此刻宇宙中所有的力與每個粒子的位置⋯⋯未來就會像過去一樣，清清楚楚地呈現在祂眼前。';
const OUTRO_QUOTE = '然而，未來從未被寫定——下一步，由你決定。';

/** 動畫期間（底下頁面隱藏、暫停重畫）。 */
export function laplaceBusy(): boolean {
  return document.body.classList.contains('laplace-busy');
}

function streams(): string {
  // 四周流動的數字欄（價格、漲跌、成交量的感覺）
  let out = '';
  const cols = window.innerWidth < 600 ? 10 : 18;
  for (let k = 0; k < cols; k++) {
    const left = (k / cols) * 100 + Math.random() * 3;
    const delay = Math.random() * 0.8;
    const dur = 1.6 + Math.random() * 1.4;
    const nums = Array.from({ length: 14 }, () => {
      const r = Math.random();
      return r < 0.33 ? (Math.random() * 1000).toFixed(2) : r < 0.66 ? `${Math.random() < 0.5 ? '+' : '−'}${(Math.random() * 9.9).toFixed(2)}%` : String(Math.floor(Math.random() * 99999));
    }).join('<br>');
    out += `<i style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s">${nums}</i>`;
  }
  return out;
}

function ticks(): string {
  let out = '';
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    const long = k % 5 === 0;
    const r1 = long ? 86 : 90;
    out += `<line x1="${(100 + Math.cos(a) * r1).toFixed(2)}" y1="${(100 + Math.sin(a) * r1).toFixed(2)}" x2="${(100 + Math.cos(a) * 95).toFixed(2)}" y2="${(100 + Math.sin(a) * 95).toFixed(2)}" stroke-width="${long ? 1.6 : 0.8}"></line>`;
  }
  return out;
}

/** 一個字一個 span，用 CSS 延遲淡入，版面一開始就固定。 */
function typed(text: string, startMs: number, stepMs: number): string {
  return [...text].map((ch, i) => `<span style="animation-delay:${startMs + i * stepMs}ms">${ch}</span>`).join('');
}

const DEFS = `
  <svg class="li-defs" width="0" height="0" aria-hidden="true">
    <defs>
      <linearGradient id="li-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#8b7bff"></stop></linearGradient>
      <radialGradient id="li-iris" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"></stop><stop offset="0.35" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#5b4dff"></stop></radialGradient>
      <radialGradient id="li-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#8ff0ff" stop-opacity="0.7"></stop><stop offset="1" stop-color="#8b7bff" stop-opacity="0"></stop></radialGradient>
    </defs>
  </svg>`;

const layer = (cls: string, body: string) => `<svg class="li-layer ${cls}" viewBox="0 0 200 200" aria-hidden="true">${body}</svg>`;

const RING = `<g stroke="url(#li-g)">${ticks()}</g><circle cx="100" cy="100" r="80" fill="none" stroke="url(#li-g)" stroke-width="1"></circle>`;
const EYE = `<path d="M38 100 Q100 50 162 100 Q100 150 38 100 Z" fill="#070b22" stroke="url(#li-g)" stroke-width="2.4" stroke-linejoin="round"></path>
  <circle cx="100" cy="100" r="27" fill="url(#li-iris)"></circle>`;
const PUPIL = `<ellipse cx="100" cy="100" rx="6" ry="21" fill="#03050f"></ellipse>`;
const SHINE = `<circle cx="109" cy="89" r="4.5" fill="#fff" opacity="0.85"></circle>`;

interface Run {
  el: HTMLElement;
  /** 什麼時候切換底下的頁面（畫面完全被蓋住時）。 */
  swapAt: number;
  swap: () => void;
}

/**
 * 共用流程：淡入蓋住畫面 → 隱藏底下頁面、暫停重畫 → 時間到（或跳過）時切換頁面
 * → 等新頁面畫好再淡出。回傳的 Promise 在動畫完全結束後完成。
 */
function run({ el, swapAt, swap }: Run): Promise<void> {
  const body = document.body;
  body.appendChild(el);
  // 淡入完成、畫面完全被蓋住後才隱藏底下頁面
  const hideTimer = window.setTimeout(() => body.classList.add('laplace-busy'), 260);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(hideTimer);
      window.clearTimeout(swapTimer);
      window.removeEventListener('keydown', onKey);
      // 先在蓋住的狀態下切換頁面，讓重畫發生在看不到的地方
      body.classList.remove('laplace-busy');
      swap();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          el.classList.add('is-leaving');
          window.setTimeout(() => {
            el.remove();
            resolve();
          }, 450);
        }),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
    };
    el.addEventListener('click', finish);
    window.addEventListener('keydown', onKey);
    const swapTimer = window.setTimeout(finish, swapAt);
  });
}

function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** 進場：甦醒動畫，畫面完全亮起時呼叫 swap 切到模擬盤。 */
export function playLaplaceIntro(swap: () => void): Promise<void> {
  const reduced = reducedMotion();
  const el = document.createElement('div');
  el.className = `laplace-intro${reduced ? ' is-reduced' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '拉普拉斯模擬盤啟動中，點一下或按 Esc 跳過');
  el.innerHTML = `${DEFS}
    <div class="li-streams" aria-hidden="true">${reduced ? '' : streams()}</div>
    <div class="li-vignette" aria-hidden="true"></div>
    <div class="li-core" aria-hidden="true">
      ${layer('li-glow', '<circle cx="100" cy="100" r="80" fill="url(#li-glow)"></circle>')}
      ${layer('li-ring', RING)}
      ${layer('li-orbit', '<circle cx="100" cy="100" r="64" fill="none" stroke="url(#li-g)" stroke-width="0.8" stroke-dasharray="2 5"></circle><circle cx="164" cy="100" r="3" fill="#8ff0ff"></circle><circle cx="45" cy="133" r="2.2" fill="#b8a9ff"></circle>')}
      ${layer('li-orbit li-orbit-2', '<circle cx="100" cy="100" r="48" fill="none" stroke="url(#li-g)" stroke-width="0.6" stroke-dasharray="1 7"></circle><circle cx="100" cy="52" r="1.8" fill="#e9fdff"></circle>')}
      <div class="li-eye">
        ${layer('', EYE)}
        ${layer('li-pupil', PUPIL)}
        ${layer('', SHINE)}
      </div>
    </div>
    <p class="li-quote" aria-label="${QUOTE}">${reduced ? QUOTE : typed(QUOTE, 950, 30)}</p>
    <p class="li-title">LAPLACE · 模擬盤</p>
    <div class="li-flash" aria-hidden="true"></div>
    <p class="li-skip">點一下或按 Esc 跳過</p>`;
  return run({ el, swapAt: reduced ? 600 : 3050, swap });
}

/** 離場：闔眼動畫，眼睛闔上、光線散開時呼叫 swap 回到原本的頁面。 */
export function playLaplaceOutro(swap: () => void): Promise<void> {
  const reduced = reducedMotion();
  const el = document.createElement('div');
  el.className = `laplace-intro laplace-outro${reduced ? ' is-reduced' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '離開拉普拉斯模擬盤，點一下或按 Esc 跳過');
  el.innerHTML = `${DEFS}
    <div class="li-streams lo-streams" aria-hidden="true">${reduced ? '' : streams()}</div>
    <div class="li-vignette" aria-hidden="true"></div>
    <div class="li-core lo-core" aria-hidden="true">
      ${layer('lo-ring', RING)}
      <div class="lo-eye">
        ${layer('', EYE)}
        ${layer('lo-pupil', PUPIL)}
        ${layer('', SHINE)}
      </div>
    </div>
    <div class="lo-line" aria-hidden="true"></div>
    <p class="li-quote lo-quote">${OUTRO_QUOTE}</p>
    <p class="li-title lo-title">RETURN · 回到現在</p>
    <p class="li-skip">點一下或按 Esc 跳過</p>`;
  return run({ el, swapAt: reduced ? 500 : 2200, swap });
}
