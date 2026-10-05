import { RateQueue, type ParsedQuote } from './fugle';

/**
 * 證交所「基本市況報導」（mis.twse.com.tw）的即時報價。
 *
 * - 不需要金鑰，一次請求可以查幾十檔（上市、上櫃都有），延遲約 5 秒。
 * - 證交所不允許網頁直接呼叫（沒有 CORS），所以要經過自己的轉接服務
 *   （web/worker/twse-proxy.js，部署在 Cloudflare Workers）。
 * - 查太頻繁會被暫時封鎖：這裡每 2 秒最多送一次請求。
 * - 只有成交量（張），沒有成交金額；成交額用「成交量 × 均價（開高低收平均）」估算。
 */

/** 加權指數在 MIS 的代號。 */
export const MIS_TAIEX = 't00';
/** 單次請求最多查幾個代號。 */
export const MIS_BATCH = 50;

export type MisExchange = 'tse' | 'otc';

/** MIS 回傳的欄位（只列用到的）；沒有資料時是 '-'。 */
export interface MisItem {
  /** 代號 */
  c: string;
  /** 市場：tse 上市、otc 上櫃 */
  ex?: string;
  /** 日期 YYYYMMDD */
  d?: string;
  /** 最近成交價 */
  z?: string;
  /** 昨收 */
  y?: string;
  o?: string;
  h?: string;
  l?: string;
  /** 累計成交量（張） */
  v?: string;
  /** 最佳五檔買價，用 _ 分隔 */
  b?: string;
}

export class MisError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'format',
    message: string,
  ) {
    super(message);
  }
}

const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

function isoDate(d: string | undefined): string | undefined {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined;
}

export function parseMis(item: MisItem): ParsedQuote & { ex?: MisExchange } {
  const price = num(item.z);
  const high = num(item.h);
  const low = num(item.l);
  const open = num(item.o);
  const volume = num(item.v) ?? 0;
  // 均價估算：有開高低就取開高低收的平均，否則用成交價
  const parts = [open, high, low, price].filter((v): v is number => v !== undefined);
  const avg = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : undefined;
  return {
    symbol: item.c,
    ex: item.ex === 'tse' || item.ex === 'otc' ? item.ex : undefined,
    date: isoDate(item.d),
    prevClose: num(item.y),
    price,
    high,
    low,
    volume,
    turnover: avg ? (volume * 1000 * avg) / 1e8 : 0,
  };
}

export function misChannel(ex: MisExchange, code: string): string {
  return `${ex}_${code}.tw`;
}

export class MisClient {
  private readonly queue = new RateQueue(2000);

  constructor(private readonly proxy: string) {}

  /** 查一批代號（例如 tse_2330.tw）。 */
  fetch(channels: string[]): Promise<MisItem[]> {
    return this.queue.push(async () => {
      const url = `${this.proxy.replace(/\/+$/, '')}/?ex_ch=${encodeURIComponent(channels.join('|'))}`;
      let res: Response;
      try {
        res = await fetch(url, { cache: 'no-store' });
      } catch {
        throw new MisError('network', '無法連線到轉接服務');
      }
      if (!res.ok) throw new MisError('http', `轉接服務回應 ${res.status}`);
      let body: { msgArray?: MisItem[] };
      try {
        body = await res.json();
      } catch {
        throw new MisError('format', '證交所回應不是 JSON（可能暫時封鎖了查詢）');
      }
      return body.msgArray ?? [];
    });
  }

  /** 被證交所暫時封鎖時停一段時間。 */
  pause(ms: number): void {
    this.queue.pauseFor(ms);
  }

  stop(): void {
    this.queue.stop();
  }
}
