import type { MarketDataProvider, PlaybackControl } from './provider';
import { buildMockUniverse } from './mockUniverse';
import { createRng, gaussian } from './random';
import { SESSION_MINUTES, roundToTick, sessionOpenMs } from './twse';
import type { IndexPoint, MarketSnapshot, Quote, TurnoverBar, Universe } from './types';

/**
 * 模擬盤中行情。
 *
 * 每個產業有一組劇本：整天的漲跌趨勢，以及成交活躍度（相對 20 日均量的倍數）。
 * 活躍度會隨時間波動，所以產業之間的資金強弱會在盤中輪動，城池的占領狀態也會跟著變化。
 */

interface Scenario {
  /** 整天的漲跌趨勢（%）。 */
  trend: number;
  /** 成交額相對 20 日均量的基準倍數。 */
  activity: number;
  /** 活躍度的波動幅度。 */
  swing: number;
  /** 個股波動度倍數。 */
  vol: number;
}

const SCENARIOS: Record<string, Scenario> = {
  semi: { trend: 1.2, activity: 1.16, swing: 0.3, vol: 0.8 },
  comp: { trend: 1.4, activity: 1.18, swing: 0.55, vol: 1.1 },
  pc: { trend: 1.8, activity: 1.22, swing: 0.55, vol: 1.2 },
  oe: { trend: 0.8, activity: 1.15, swing: 0.5, vol: 0.9 },
  net: { trend: 0.3, activity: 1.12, swing: 0.5, vol: 0.8 },
  opto: { trend: -0.6, activity: 0.95, swing: 0.4, vol: 1.1 },
  fin: { trend: 0.6, activity: 1.2, swing: 0.55, vol: 0.5 },
  ship: { trend: -1.8, activity: 0.72, swing: 0.3, vol: 1.4 },
  plastic: { trend: -1.1, activity: 0.85, swing: 0.35, vol: 0.9 },
  steel: { trend: -0.4, activity: 0.95, swing: 0.45, vol: 0.9 },
  bio: { trend: 0.9, activity: 1.2, swing: 0.6, vol: 1.6 },
  mech: { trend: 2.6, activity: 1.22, swing: 0.55, vol: 1.4 },
  trad: { trend: -0.3, activity: 0.98, swing: 0.4, vol: 0.6 },
};

const DEFAULT_SCENARIO: Scenario = { trend: 0, activity: 1, swing: 0.1, vol: 1 };

/** 盤中成交量的 U 型分布：開盤與收盤前較多。 */
function intradayProfile(minute: number): number {
  const x = minute / SESSION_MINUTES;
  return 0.75 + 1.1 * Math.exp(-x * 9) + 0.6 * Math.exp(-(1 - x) * 12);
}

interface StockState {
  logReturn: number;
  price: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
}

export interface MockProviderOptions {
  seed?: number;
  /** 從開盤後第幾分鐘開始播放（預設 65，也就是 10:05）。 */
  startMinute?: number;
  /** 播放速度：真實 1 秒 = 模擬幾秒。 */
  speed?: number;
  /** 推送間隔（毫秒）。 */
  tickMs?: number;
}

export class MockMarketProvider implements MarketDataProvider, PlaybackControl {
  private readonly universe: Universe;
  private readonly seed: number;
  private readonly startMinute: number;
  private readonly tickMs: number;
  private readonly openMs: number;
  private readonly phases: Record<string, number> = {};

  private rng!: () => number;
  private minute = 0;
  private states = new Map<string, StockState>();
  private series: IndexPoint[] = [];
  private turnoverHistory: TurnoverBar[] = [];
  private listeners = new Set<(s: MarketSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  speed: number;
  paused = false;

  constructor(options: MockProviderOptions = {}) {
    this.seed = options.seed ?? 7;
    this.startMinute = options.startMinute ?? 65;
    this.speed = options.speed ?? 60;
    this.tickMs = options.tickMs ?? 1000;
    this.universe = buildMockUniverse();
    this.openMs = sessionOpenMs(new Date());
    const phaseRng = createRng(this.seed + 99);
    for (const ind of this.universe.industries) this.phases[ind.id] = phaseRng() * Math.PI * 2;
    this.reset();
  }

  async loadUniverse(): Promise<Universe> {
    return this.universe;
  }

  subscribe(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
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
    if (this.minute >= SESSION_MINUTES) this.reset();
    this.paused = false;
    this.ensureTimer();
    this.emit();
  }

  restart(): void {
    this.reset();
    this.paused = false;
    this.ensureTimer();
    this.emit();
  }

  /** 產業在某個時間點的成交活躍度倍數。 */
  private activity(industryId: string, minute: number): number {
    const s = SCENARIOS[industryId] ?? DEFAULT_SCENARIO;
    const wave = Math.sin((minute / SESSION_MINUTES) * Math.PI * 1.6 + this.phases[industryId]);
    return Math.max(0.2, s.activity + s.swing * wave);
  }

  private reset(): void {
    this.rng = createRng(this.seed);
    this.minute = 0;
    this.series = [];
    this.turnoverHistory = [];
    this.states.clear();
    for (const s of this.universe.stocks) {
      this.states.set(s.code, {
        logReturn: 0, price: s.prevClose, high: s.prevClose, low: s.prevClose, volume: 0, turnover: 0,
      });
    }
    this.pushIndexPoint();
    while (this.minute < this.startMinute) this.step(1);
  }

  /** 推進 dt 分鐘。 */
  private step(dt: number): void {
    const from = this.minute;
    const to = Math.min(SESSION_MINUTES, from + dt);
    dt = to - from;
    if (dt <= 0) return;
    const mid = (from + to) / 2;
    const profile = intradayProfile(mid);
    const sqrtDt = Math.sqrt(dt);
    const marketShock = gaussian(this.rng) * 0.00022 * sqrtDt;
    const industryShock: Record<string, number> = {};
    for (const ind of this.universe.industries) industryShock[ind.id] = gaussian(this.rng) * 0.0004 * sqrtDt;

    for (const meta of this.universe.stocks) {
      const st = this.states.get(meta.code)!;
      const sc = SCENARIOS[meta.industryId] ?? DEFAULT_SCENARIO;
      const act = this.activity(meta.industryId, mid);
      // 資金轉強時價格也傾向走強
      const drift = (sc.trend / 100 / SESSION_MINUTES) * dt * (0.6 + 0.4 * (act / sc.activity));
      // 權值股的個股雜訊較小，指數才不會被單一檔股票的跳動主導
      const sizeDamp = meta.marketCap > 50_000 ? 0.3 : meta.marketCap > 10_000 ? 0.6 : 1;
      const idio = gaussian(this.rng) * 0.0011 * sc.vol * sizeDamp * sqrtDt;
      st.logReturn += drift + marketShock + industryShock[meta.industryId] + idio;
      // 漲跌停 ±10%
      st.logReturn = Math.max(Math.log(0.9), Math.min(Math.log(1.1), st.logReturn));
      st.price = roundToTick(meta.prevClose * Math.exp(st.logReturn));
      st.high = Math.max(st.high, st.price);
      st.low = Math.min(st.low, st.price);

      const noise = Math.exp(gaussian(this.rng) * 0.25);
      const turnover = (meta.avgTurnover20 / SESSION_MINUTES) * dt * profile * act * noise / 1.05;
      st.turnover += turnover;
      st.volume += Math.round((turnover * 1e8) / (st.price * 1000));
    }

    const crossedMinute = Math.floor(to) !== Math.floor(from);
    this.minute = to;
    if (crossedMinute || to >= SESSION_MINUTES) this.pushIndexPoint();
    else this.series[this.series.length - 1] = this.indexPoint();
  }

  private indexValue(): number {
    let cap = 0;
    let weighted = 0;
    for (const meta of this.universe.stocks) {
      const st = this.states.get(meta.code)!;
      cap += meta.marketCap;
      weighted += meta.marketCap * (st.price / meta.prevClose);
    }
    return this.universe.index.prevClose * (weighted / cap);
  }

  private indexPoint(): IndexPoint {
    return { t: this.openMs + this.minute * 60_000, v: this.indexValue() };
  }

  private pushIndexPoint(): void {
    this.series.push(this.indexPoint());
    const byStock: Record<string, number> = {};
    const prices: Record<string, number> = {};
    for (const [code, st] of this.states) {
      byStock[code] = st.turnover;
      prices[code] = st.price;
    }
    this.turnoverHistory.push({ t: this.openMs + Math.floor(this.minute) * 60_000, byStock, prices });
  }

  private snapshot(): MarketSnapshot {
    const quotes: Record<string, Quote> = {};
    let turnover = 0;
    for (const [code, st] of this.states) {
      quotes[code] = { code, price: st.price, high: st.high, low: st.low, volume: st.volume, turnover: st.turnover };
      turnover += st.turnover;
    }
    return {
      time: this.openMs + this.minute * 60_000,
      session: this.minute >= SESSION_MINUTES ? 'closed' : 'open',
      index: {
        value: this.indexValue(),
        // 股票池之外的個股約佔大盤成交額兩成
        turnover: turnover / 0.8,
        series: this.series.slice(),
      },
      quotes,
      turnoverHistory: this.turnoverHistory.slice(),
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private ensureTimer(): void {
    if (this.timer || this.listeners.size === 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
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
    let remaining = (this.speed * this.tickMs) / 60_000;
    while (remaining > 0 && this.minute < SESSION_MINUTES) {
      const dt = Math.min(1, remaining);
      this.step(dt);
      remaining -= dt;
    }
    this.emit();
  }
}
