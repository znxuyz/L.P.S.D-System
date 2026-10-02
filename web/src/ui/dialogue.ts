import type { MarketEvent } from '../domain/events';
import type { Focus } from './focus';

/**
 * RPG 對話框：盤中事件排隊，一個字一個字打出來，每則至少停留 2.6 秒。
 * 點對話框會選取事件提到的股票或產業。
 */
export class DialogueBox {
  private readonly textEl: HTMLElement;
  private queue: MarketEvent[] = [];
  private current: MarketEvent | undefined;
  private typing = 0;
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly el: HTMLElement,
    private readonly onSelect: (focus: Focus) => void,
  ) {
    el.innerHTML = '<p class="dlg-text" id="dlg-text"></p><span class="dlg-next" aria-hidden="true">▼</span>';
    this.textEl = el.querySelector('#dlg-text')!;
    el.addEventListener('click', () => {
      const e = this.current;
      if (e?.code) this.onSelect({ kind: 'stock', id: e.code });
      else if (e?.industryId) this.onSelect({ kind: 'industry', id: e.industryId });
    });
    this.textEl.textContent = '冒險開始！等待盤中事件⋯';
  }

  /** 加入新事件（舊的在前）。 */
  push(events: MarketEvent[]): void {
    if (!events.length) return;
    this.queue.push(...events);
    // 事件太多時只保留最新的幾則，避免對話框落後盤勢
    if (this.queue.length > 4) this.queue = this.queue.slice(-4);
    if (!this.timer) this.next();
  }

  reset(): void {
    this.queue = [];
    this.current = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.textEl.textContent = '冒險開始！等待盤中事件⋯';
    this.el.classList.remove('is-typing');
  }

  private next(): void {
    const now = performance.now();
    if (now < this.holdUntil) {
      this.timer = setTimeout(() => this.next(), this.holdUntil - now);
      return;
    }
    const e = this.queue.shift();
    if (!e) {
      this.timer = undefined;
      return;
    }
    this.current = e;
    this.el.dataset.level = e.level;
    this.el.classList.toggle('is-link', !!(e.code || e.industryId));
    const line = `${e.text}${e.level === 'info' ? '。' : '！'}`;
    if (this.reducedMotion.matches) {
      this.textEl.textContent = line;
      this.holdUntil = performance.now() + 2600;
      this.timer = setTimeout(() => this.next(), 2600);
      return;
    }
    this.typing = 0;
    this.el.classList.add('is-typing');
    const step = () => {
      this.typing++;
      this.textEl.textContent = line.slice(0, this.typing);
      if (this.typing < line.length) {
        this.timer = setTimeout(step, 38);
      } else {
        this.el.classList.remove('is-typing');
        this.holdUntil = performance.now() + 2600;
        this.timer = setTimeout(() => this.next(), 2600);
      }
    };
    step();
  }
}
