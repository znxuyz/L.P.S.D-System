import { intradayPath, type IntradayPath } from '../domain/intraday';
import { buildMockUniverse } from './mockUniverse';
import type { MarketDataProvider, PlaybackControl } from './provider';
import { SESSION_MINUTES, sessionOpenMs } from './twse';
import type { MarketSnapshot, Quote, TurnoverBar, Universe } from './types';

/**
 * 「收盤資料」模式：沒有即時行情金鑰時的預設來源。
 *
 * - 每檔股票、ETF 與加權指數的開、高、低、收、成交量、成交額、昨收、20 日均額都是最近一個交易日的真實資料
 *   （部署時由 scripts/close-snapshot.ts 產生 data/close.json）。
 * - 一打開就停在收盤；按「重新開盤」可以從 09:00 回放這一天。回放時每分鐘的價格是依開高低收推算的模擬走勢
 *   （domain/intraday.ts，和模擬盤同一套），收盤的數字一定和真實收盤相同。
 * - 股票池、產業分類沿用內建清單；沒有這一天資料的股票（例如暫停交易）不放進熱力圖。
 */

export interface CloseFile {
  date: string;
  prevDate: string;
  /** [開, 高, 低, 收, 昨收] */
  index: [number, number, number, number, number] | null;
  /** 上市成交額（億元）。 */
  total: number;
  /** 代號 → [開, 高, 低, 收, 張, 昨收, 成交額（億元）, 近 20 日平均成交額（億元）] */
  rows: Record<string, number[]>;
}

export async function loadCloseFile(url = 'data/close.json'): Promise<CloseFile | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = (await res.json()) as CloseFile;
    return j && typeof j.date === 'string' && j.rows && typeof j.rows === 'object' ? j : null;
  } catch {
    return null;
  }
}

interface Track {
  path: IntradayPath;
  /** 當天總成交額（億元）與張數。 */
  turnover: number;
  volume: number;
  /** 到第 m 分鐘為止的最高、最低。 */
  hi: Float64Array;
  lo: Float64Array;
}

export class CloseReplayProvider implements MarketDataProvider, PlaybackControl {
  readonly date: string;
  private readonly universe: Universe;
  private readonly tracks = new Map<string, Track>();
  private readonly indexPath: IntradayPath | null;
  private readonly indexPrev: number;
  private readonly openMs: number;
  private readonly bars: TurnoverBar[] = [];
  private readonly listeners = new Set<(s: MarketSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private minute = SESSION_MINUTES;
  /** ETF 收盤時的預估淨值（由 main 從 etf-info.json 帶入），回放時依股價等比例推回去。 */
  navAtClose = new Map<string, number>();

  speed = 60;
  paused = true;

  constructor(private readonly file: CloseFile) {
    this.date = file.date;
    this.openMs = sessionOpenMs(new Date(`${file.date}T12:00:00+08:00`));
    const u = buildMockUniverse();
    const stocks = u.stocks.filter((s) => file.rows[s.code]);
    for (const s of stocks) {
      const r = file.rows[s.code];
      const ratio = r[5] / s.prevClose;
      // 內建的市值與示意基本面是用內建股價算的，換成真實昨收時等比例調整
      s.marketCap *= ratio;
      if (s.fundamentals) {
        const f = s.fundamentals;
        Object.assign(f, {
          eps4q: f.eps4q * ratio,
          dividend: f.dividend * ratio,
          low3y: f.low3y * ratio,
          high3y: f.high3y * ratio,
          high52w: f.high52w * ratio,
          high20: f.high20 * ratio,
          ma5: f.ma5 * ratio,
          ma20: f.ma20 * ratio,
          ma60: f.ma60 * ratio,
        });
      }
      s.prevClose = r[5];
      if (r[7] > 0) s.avgTurnover20 = r[7];
    }
    const etfs = (u.etfs ?? []).filter((e) => file.rows[e.code]);
    for (const e of etfs) {
      const r = file.rows[e.code];
      e.prevClose = r[5];
      if (r[7] > 0) e.avgTurnover20 = r[7];
    }
    this.indexPrev = file.index?.[4] ?? u.index.prevClose;
    this.universe = { ...u, stocks, etfs, index: { ...u.index, prevClose: this.indexPrev } };
    for (const code of [...stocks.map((s) => s.code), ...etfs.map((e) => e.code)]) {
      const [open, high, low, close, volume, , turnover] = this.file.rows[code];
      const path = intradayPath(code, file.date, { open, high, low, close, volume });
      const hi = new Float64Array(SESSION_MINUTES + 1);
      const lo = new Float64Array(SESSION_MINUTES + 1);
      let h = -Infinity;
      let l = Infinity;
      for (let m = 0; m <= SESSION_MINUTES; m++) {
        h = Math.max(h, path.price[m]);
        l = Math.min(l, path.price[m]);
        hi[m] = h;
        lo[m] = l;
      }
      this.tracks.set(code, { path, turnover, volume, hi, lo });
    }
    const ix = file.index;
    this.indexPath = ix ? intradayPath('TAIEX', file.date, { open: ix[0], high: ix[1], low: ix[2], close: ix[3], volume: 0 }) : null;
    // 每分鐘的累計成交額與股價（資金輪動、熱力圖走勢線用）
    for (let m = 0; m <= SESSION_MINUTES; m++) {
      const byStock: Record<string, number> = {};
      const prices: Record<string, number> = {};
      for (const [code, t] of this.tracks) {
        byStock[code] = this.turnoverAt(t, m);
        prices[code] = t.path.price[m];
      }
      this.bars.push({ t: this.openMs + m * 60_000, byStock, prices });
    }
  }

  async loadUniverse(): Promise<Universe> {
    return this.universe;
  }

  /** 股票池以外的股票：用收盤資料。 */
  async extraQuote(code: string): Promise<(Quote & { prevClose?: number }) | null> {
    const r = this.file.rows[code];
    if (!r) return null;
    return { code, price: r[3], high: r[1], low: r[2], volume: r[4], turnover: r[6], prevClose: r[5] };
  }

  subscribe(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopTimer();
    };
  }

  setSpeed(multiplier: number): void {
    this.speed = multiplier;
  }

  pause(): void {
    this.paused = true;
    this.emit();
  }

  resume(): void {
    if (this.minute >= SESSION_MINUTES) this.minute = 0;
    this.paused = false;
    this.ensureTimer();
    this.emit();
  }

  restart(): void {
    this.minute = 0;
    this.paused = false;
    this.ensureTimer();
    this.emit();
  }

  private turnoverAt(t: Track, m: number): number {
    return t.volume > 0 ? (t.turnover * t.path.cumVolume[m]) / t.volume : 0;
  }

  private snapshot(): MarketSnapshot {
    const m = Math.min(SESSION_MINUTES, Math.floor(this.minute));
    const quotes: Record<string, Quote> = {};
    let pool = 0;
    for (const [code, t] of this.tracks) {
      const price = t.path.price[m];
      const turnover = this.turnoverAt(t, m);
      const q: Quote = { code, price, high: t.hi[m], low: t.lo[m], volume: Math.round(t.path.cumVolume[m]), turnover };
      const nav = this.navAtClose.get(code);
      if (nav) q.nav = nav * (price / t.path.price[SESSION_MINUTES]);
      quotes[code] = q;
      if (!code.startsWith('00')) pool += turnover;
    }
    // 大盤成交額：整天用真實的上市成交額，盤中依股票池的進度等比例
    const poolTotal = [...this.tracks].filter(([c]) => !c.startsWith('00')).reduce((a, [, t]) => a + t.turnover, 0);
    const total = this.file.total > 0 && poolTotal > 0 ? (this.file.total * pool) / poolTotal : pool / 0.8;
    const series = this.indexPath ? Array.from({ length: m + 1 }, (_, i) => ({ t: this.openMs + i * 60_000, v: this.indexPath!.price[i] })) : [];
    return {
      time: this.openMs + m * 60_000,
      session: m >= SESSION_MINUTES ? 'closed' : 'open',
      index: { value: this.indexPath ? this.indexPath.price[m] : this.indexPrev, turnover: total, series },
      quotes,
      turnoverHistory: this.bars.slice(0, m + 1),
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private ensureTimer(): void {
    if (this.timer || !this.listeners.size) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.paused) return;
    if (this.minute >= SESSION_MINUTES) {
      this.paused = true;
      this.emit();
      return;
    }
    this.minute = Math.min(SESSION_MINUTES, this.minute + this.speed / 60);
    this.emit();
  }
}
