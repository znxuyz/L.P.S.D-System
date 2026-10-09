/**
 * 「拉普拉斯之妖」甦醒動畫：按下左上角圖示時全畫面播放，結束後進入模擬盤。
 *
 * 節奏（約 3.2 秒）：
 * 1. 黑幕中刻度環與軌道收攏、旋轉。
 * 2. 豎瞳之眼張開，四周流過數字與 K 棒（「已知宇宙所有粒子的位置與力」）。
 * 3. 打出拉普拉斯的名句。
 * 4. 瞳孔放大、鏡頭衝進瞳孔，畫面亮起後淡出。
 * 點一下或按 Esc 可以跳過；系統設定「減少動態效果」時只做淡入淡出。
 */

const QUOTE = '若有一位智者，知道此刻宇宙中所有的力與每個粒子的位置⋯⋯未來就會像過去一樣，清清楚楚地呈現在祂眼前。';

function streams(): string {
  // 四周流動的數字欄（價格、漲跌、成交量的感覺）
  let out = '';
  for (let k = 0; k < 18; k++) {
    const left = (k / 18) * 100 + Math.random() * 3;
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
    const x1 = 100 + Math.cos(a) * r1;
    const y1 = 100 + Math.sin(a) * r1;
    const x2 = 100 + Math.cos(a) * 95;
    const y2 = 100 + Math.sin(a) * 95;
    out += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${long ? 1.6 : 0.8}"></line>`;
  }
  return out;
}

export function playLaplaceIntro(): Promise<void> {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = `laplace-intro${reduced ? ' is-reduced' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '拉普拉斯模擬盤啟動中，點一下或按 Esc 跳過');
  el.innerHTML = `
    <div class="li-streams" aria-hidden="true">${reduced ? '' : streams()}</div>
    <svg class="li-core" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id="li-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#8b7bff"></stop></linearGradient>
        <radialGradient id="li-iris" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"></stop><stop offset="0.35" stop-color="#8ff0ff"></stop><stop offset="1" stop-color="#5b4dff"></stop></radialGradient>
        <radialGradient id="li-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#8ff0ff" stop-opacity="0.7"></stop><stop offset="1" stop-color="#8b7bff" stop-opacity="0"></stop></radialGradient>
      </defs>
      <circle class="li-glow" cx="100" cy="100" r="80" fill="url(#li-glow)"></circle>
      <g class="li-ticks" stroke="url(#li-g)">${ticks()}</g>
      <circle class="li-ring" cx="100" cy="100" r="80" fill="none" stroke="url(#li-g)" stroke-width="1"></circle>
      <g class="li-orbit">
        <circle cx="100" cy="100" r="64" fill="none" stroke="url(#li-g)" stroke-width="0.8" stroke-dasharray="2 5"></circle>
        <circle cx="164" cy="100" r="3" fill="#8ff0ff"></circle>
        <circle cx="45" cy="133" r="2.2" fill="#b8a9ff"></circle>
      </g>
      <g class="li-orbit li-orbit-2">
        <circle cx="100" cy="100" r="48" fill="none" stroke="url(#li-g)" stroke-width="0.6" stroke-dasharray="1 7"></circle>
        <circle cx="100" cy="52" r="1.8" fill="#e9fdff"></circle>
      </g>
      <g class="li-eye">
        <path d="M38 100 Q100 50 162 100 Q100 150 38 100 Z" fill="#070b22" stroke="url(#li-g)" stroke-width="2.4" stroke-linejoin="round"></path>
        <circle cx="100" cy="100" r="27" fill="url(#li-iris)"></circle>
        <ellipse class="li-pupil" cx="100" cy="100" rx="6" ry="21" fill="#03050f"></ellipse>
        <circle cx="109" cy="89" r="4.5" fill="#fff" opacity="0.85"></circle>
      </g>
    </svg>
    <p class="li-quote"><span></span></p>
    <p class="li-title">LAPLACE · 模擬盤</p>
    <div class="li-flash" aria-hidden="true"></div>
    <p class="li-skip">點一下或按 Esc 跳過</p>`;
  document.body.appendChild(el);

  // 一個字一個字打出名句
  const span = el.querySelector<HTMLSpanElement>('.li-quote span')!;
  let k = 0;
  const typer = reduced ? 0 : window.setInterval(() => {
    span.textContent = QUOTE.slice(0, ++k);
    if (k >= QUOTE.length) window.clearInterval(typer);
  }, 32);
  if (reduced) span.textContent = QUOTE;

  return new Promise((resolve) => {
    let done = false;
    const total = reduced ? 600 : 3300;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearInterval(typer);
      window.removeEventListener('keydown', onKey);
      resolve();
      // 先讓模擬盤顯示，再把動畫淡掉
      el.classList.add('is-leaving');
      window.setTimeout(() => el.remove(), 450);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
    };
    el.addEventListener('click', finish);
    window.addEventListener('keydown', onKey);
    window.setTimeout(finish, total);
  });
}
