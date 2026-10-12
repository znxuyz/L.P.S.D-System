/**
 * 模擬盤的新手指引：一步一步框出畫面上的區塊（其他地方變暗），旁邊說明這是什麼、要怎麼操作。
 *
 * - 每一步可以是「功能說明」或「操作步驟」，下單的部分照實際操作順序排，跟著走一次就會下單。
 * - 找不到目標的步驟（例如還沒有部位，看不到停損停利）自動略過。
 * - ← → 或按鈕切換，Esc 或「略過」結束。
 */
import { escapeHtml as esc } from '../format';

export interface GuideStep {
  /** 要框起來的元素；沒有 target 是置中的說明卡。target 找不到（回傳 null）的步驟會略過。 */
  target?: () => Element | null;
  title: string;
  /** 說明（可以用簡單的 HTML：b、br、ul/li）。 */
  body: string;
  /** 操作步驟的編號（例如「下單 ②」），沒有就是功能說明。 */
  action?: string;
}

const PAD = 8;

export function runGuide(all: GuideStep[], onEnd: () => void): void {
  document.querySelector('.sim-guide')?.remove();
  const root = document.createElement('div');
  root.className = 'sim-guide';
  root.innerHTML = `<div class="sim-guide-block"></div><div class="sim-guide-hole" aria-hidden="true"><span class="sim-guide-num"></span></div>
    <div class="sim-guide-card" role="dialog" aria-modal="true" aria-labelledby="sim-guide-title"></div>`;
  document.body.append(root);
  const hole = root.querySelector<HTMLElement>('.sim-guide-hole')!;
  const num = root.querySelector<HTMLElement>('.sim-guide-num')!;
  const card = root.querySelector<HTMLElement>('.sim-guide-card')!;
  let i = 0;
  let target: Element | null = null;
  let raf = 0;

  // 找不到目標（或目標沒有顯示出來）的步驟略過；置中說明卡永遠保留
  const visible = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().height > 0;
  const steps = all.filter((s) => !s.target || visible(s.target()));

  const place = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cw = Math.min(380, vw - 24);
      card.style.width = `${cw}px`;
      if (!target) {
        hole.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0;`;
        hole.classList.add('is-none');
        card.style.left = `${(vw - cw) / 2}px`;
        card.style.top = `${Math.max(12, (vh - card.offsetHeight) / 2)}px`;
        return;
      }
      hole.classList.remove('is-none');
      const r = target.getBoundingClientRect();
      const left = Math.max(4, r.left - PAD);
      const top = Math.max(4, r.top - PAD);
      const w = Math.min(vw - 8, r.width + PAD * 2);
      const h = Math.min(vh - 8, r.height + PAD * 2);
      hole.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px;`;
      // 說明卡放在框的下方，放不下就放上方，再不行就貼在畫面底部
      const ch = card.offsetHeight;
      let cy = top + h + 12;
      if (cy + ch > vh - 12) cy = top - ch - 12;
      if (cy < 12) cy = vh - ch - 12;
      const cx = Math.min(Math.max(12, left + w / 2 - cw / 2), vw - cw - 12);
      card.style.left = `${cx}px`;
      card.style.top = `${Math.max(12, cy)}px`;
    });
  };

  const show = (n: number) => {
    i = Math.max(0, Math.min(steps.length - 1, n));
    const step = steps[i];
    target = step.target?.() ?? null;
    num.textContent = step.action ?? String(i + 1);
    num.classList.toggle('is-action', !!step.action);
    card.innerHTML = `
      <p class="sim-guide-step">${step.action ? `<span class="sim-guide-tag">操作 ${esc(step.action)}</span>` : '<span class="sim-guide-tag is-info">功能說明</span>'}
        <span class="muted">${i + 1}／${steps.length}</span></p>
      <h3 id="sim-guide-title">${esc(step.title)}</h3>
      <div class="sim-guide-body">${step.body}</div>
      <div class="sim-guide-nav">
        <button type="button" class="btn btn-sm" data-guide="skip">${i === steps.length - 1 ? '關閉' : '略過指引'}</button>
        <span class="sim-guide-dots" aria-hidden="true">${steps.map((_, k) => `<i class="${k === i ? 'is-on' : ''}"></i>`).join('')}</span>
        <button type="button" class="btn btn-sm" data-guide="prev" ${i === 0 ? 'disabled' : ''}>上一步</button>
        <button type="button" class="btn btn-sm btn-accent" data-guide="next">${i === steps.length - 1 ? '完成 ✓' : '下一步'}</button>
      </div>`;
    if (target) {
      // 先捲到畫面中間，捲完再定位
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      place();
      setTimeout(place, 380);
    } else place();
    card.querySelector<HTMLButtonElement>('[data-guide="next"]')?.focus({ preventScroll: true });
  };

  const end = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('keydown', onKey, true);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), 200);
    onEnd();
  };

  const onKey = (e: KeyboardEvent) => {
    // 指引進行中，鍵盤只給指引用（不會觸發模擬盤的空白鍵、→）
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') i === steps.length - 1 ? end() : show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  root.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-guide]');
    if (!b) return;
    const a = b.dataset.guide;
    if (a === 'skip') end();
    else if (a === 'prev') show(i - 1);
    else if (a === 'next') (i === steps.length - 1 ? end() : show(i + 1));
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('keydown', onKey, true);
  show(0);
}

/** 第一次進模擬盤時問要不要看新手指引。 */
export function askGuide(onYes: () => void, onNo: () => void): void {
  document.querySelector('.sim-guide-ask')?.remove();
  const el = document.createElement('div');
  el.className = 'sim-guide-ask';
  el.innerHTML = `<div class="sim-guide-ask-card glass" role="dialog" aria-modal="true" aria-labelledby="sim-ask-title">
      <p class="eyebrow">Laplace Replay</p>
      <h3 id="sim-ask-title">第一次使用模擬盤？</h3>
      <p>要不要花一分鐘看新手指引？會一步一步框出每個區塊，告訴你這是什麼、怎麼下單、怎麼看成績。
        之後隨時可以按上方的「❓ 新手指引」再看一次。</p>
      <div class="sim-guide-nav">
        <button type="button" class="btn" data-ask="no">先不用</button>
        <button type="button" class="btn btn-accent" data-ask="yes">好，開始指引</button>
      </div>
    </div>`;
  document.body.append(el);
  el.querySelector<HTMLButtonElement>('[data-ask="yes"]')?.focus();
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-ask]');
    if (!b) return;
    el.remove();
    if (b.dataset.ask === 'yes') onYes();
    else onNo();
  });
}
