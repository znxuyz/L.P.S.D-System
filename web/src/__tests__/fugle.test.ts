import { describe, expect, it } from 'vitest';
import { computeBaseline, parseQuote } from '../data/fugle';
import { sessionAt, taipeiDate } from '../data/liveProvider';

describe('富果資料轉換', () => {
  it('報價：金額換成億元，缺成交價時用收盤價', () => {
    const q = parseQuote({
      symbol: '2330',
      date: '2026-10-05',
      previousClose: 1000,
      closePrice: 1010,
      highPrice: 1015,
      lowPrice: 995,
      total: { tradeValue: 25_000_000_000, tradeVolume: 24_800 },
    });
    expect(q).toMatchObject({ symbol: '2330', prevClose: 1000, price: 1010, high: 1015, low: 995, volume: 24_800 });
    expect(q.turnover).toBeCloseTo(250);
  });

  it('報價：盤前沒有成交時欄位為空，成交額為 0', () => {
    const q = parseQuote({ symbol: '2317', referencePrice: 200, lastPrice: 0 } as never);
    expect(q.prevClose).toBe(200);
    expect(q.price).toBeUndefined();
    expect(q.turnover).toBe(0);
  });

  it('日 K：排除今天，計算 20 日均額與均線', () => {
    const candles = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { date: d, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000, turnover: (i + 1) * 1e8 };
    }).reverse(); // 富果回傳新到舊
    const today = candles[0].date;
    const b = computeBaseline(candles, today)!;
    // 不含今天：最後一根是 i = 68
    expect(b.lastClose).toBe(168);
    expect(b.avgTurnover20).toBeCloseTo((50 + 69) / 2); // i = 49..68 → (i+1) = 50..69 億
    expect(b.ma5).toBeCloseTo(166);
    expect(b.high20).toBe(169);
    expect(b.high52w).toBe(169);
    expect(b.low52w).toBe(99);
  });

  it('交易時段以台北時間判斷', () => {
    // 2026-10-05 是星期一
    expect(sessionAt(Date.UTC(2026, 9, 5, 0, 30))).toBe('pre'); // 08:30
    expect(sessionAt(Date.UTC(2026, 9, 5, 3, 0))).toBe('open'); // 11:00
    expect(sessionAt(Date.UTC(2026, 9, 5, 6, 0))).toBe('closed'); // 14:00
    expect(sessionAt(Date.UTC(2026, 9, 4, 3, 0))).toBe('closed'); // 星期日
    expect(taipeiDate(Date.UTC(2026, 9, 4, 17, 0))).toBe('2026-10-05');
  });
});

describe('證交所 MIS 資料轉換', () => {
  it('解析報價並估算成交額', async () => {
    const { parseMis } = await import('../data/twseMis');
    const q = parseMis({ c: '2330', ex: 'tse', d: '20261005', z: '1010.0000', y: '1000.0000', o: '1000', h: '1020', l: '1000', v: '20000' });
    expect(q).toMatchObject({ symbol: '2330', ex: 'tse', date: '2026-10-05', prevClose: 1000, price: 1010, high: 1020, low: 1000, volume: 20000 });
    // 均價 (1000 + 1020 + 1000 + 1010) / 4 = 1007.5；20000 張 × 1000 股 × 1007.5 元 = 201.5 億
    expect(q.turnover).toBeCloseTo(201.5);
  });

  it('沒有成交價（-）時價格留空', async () => {
    const { parseMis } = await import('../data/twseMis');
    const q = parseMis({ c: '6488', ex: 'otc', z: '-', y: '380', v: '-' });
    expect(q.price).toBeUndefined();
    expect(q.prevClose).toBe(380);
    expect(q.turnover).toBe(0);
  });
});
