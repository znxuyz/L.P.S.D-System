import type { MarketEvent } from '../domain/events';
import type { Focus } from './focus';
import { clock, escapeHtml } from './format';

const LEVEL_LABEL = { info: '系統', alert: '提醒', critical: '重大' } as const;

/**
 * 盤中事件通知：從角落滑入的玻璃卡片，最多同時 4 張，6 秒後淡出。
 * 點卡片會選取事件提到的股票或產業。
 */
export class Toasts {
  constructor(
    private readonly el: HTMLElement,
    private readonly onSelect: (focus: Focus) => void,
  ) {}

  push(events: MarketEvent[]): void {
    for (const e of events) this.add(e);
  }

  clear(): void {
    this.el.innerHTML = '';
  }

  private add(e: MarketEvent): void {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `toast glass lv-${e.level}`;
    card.innerHTML =
      `<span class="toast-dot" aria-hidden="true"></span>` +
      `<span class="toast-body"><span class="toast-meta">${LEVEL_LABEL[e.level]} · ${clock(e.t)}</span>` +
      `<span class="toast-text">${escapeHtml(e.text)}</span></span>`;
    card.addEventListener('click', () => {
      if (e.code) this.onSelect({ kind: 'stock', id: e.code });
      else if (e.industryId) this.onSelect({ kind: 'industry', id: e.industryId });
    });
    this.el.prepend(card);
    while (this.el.children.length > 4) this.el.lastElementChild?.remove();
    setTimeout(() => {
      card.classList.add('is-leaving');
      setTimeout(() => card.remove(), 400);
    }, 6000);
  }
}
