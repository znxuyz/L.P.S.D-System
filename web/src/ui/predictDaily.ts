/**
 * 盤中預測區塊的「日 K」：00631L、加權指數、台指期（日盤）未來約一個月的預測。
 * 跟個股預測一樣：中線＝不會動（指數、期貨沒有營收選股分數，方向沒有可靠的預測）、80% 區間用自己的歷史校準、
 * 相似走勢預測線（自己的歷史裡最像的 5 段）附回測準確度。
 */
import type { Candle } from '../domain/technicals';
import { analogBacktest, analogForecast, bandCalib, dailyVol } from '../domain/stockForecast';
import { adjustSplits, loadOfficialCandles } from '../data/candles';
import { escapeHtml as esc, num } from './format';
import { chartSvg } from './predictStock';

export type DailyAsset = 'L' | 'ix' | 'tx';
const NAME: Record<DailyAsset, string> = { L: '00631L', ix: '加權指數', tx: '台指期（近月日盤）' };
const pctTxt = (v: number, d = 1) => `${v > 0 ? '+' : ''}${num(v * 100, d)}%`;
const cache = new Map<string, Promise<Candle[] | null>>();

function load(asset: DailyAsset, txd: Array<[string, number, number, number, number]> | undefined): Promise<Candle[] | null> {
  if (asset === 'tx') return Promise.resolve(txd?.length ? txd.map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 0 })) : null);
  let p = cache.get(asset);
  if (!p) {
    p =
      asset === 'ix'
        ? fetch('data/index/TAIEX.json', { cache: 'no-cache' })
            .then((r) => (r.ok ? (r.json() as Promise<Array<[string, number, number, number, number]>>) : null))
            .then((rows) => (rows ? rows.map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 0 })) : null))
            .catch(() => null)
        : loadOfficialCandles('00631L').then(async (c) => (c ? (await adjustSplits('00631L', { candles: c, source: 'official' })).candles : null));
    cache.set(asset, p);
  }
  return p;
}

/** 填入 el（#pd-intra-daily）。 */
export async function fillDaily(el: HTMLElement, asset: DailyAsset, txd?: Array<[string, number, number, number, number]>): Promise<void> {
  const candles = await load(asset, txd);
  if (!el.isConnected) return;
  if (!candles || candles.length < 200) {
    el.innerHTML = `<p class="muted">${NAME[asset]} 的日 K 資料還不夠。</p>`;
    return;
  }
  const closes = candles.map((c) => c.close);
  const H = 21;
  const sigma = dailyVol(closes);
  const cal = bandCalib(closes, candles.map((c) => c.date), H);
  const an = analogForecast(closes);
  const bt = analogBacktest(closes);
  const last = candles[candles.length - 1];
  const p10 = cal?.p10 ?? -1.28;
  const p90 = cal?.p90 ?? 1.28;
  const path = Array.from({ length: H }, (_, k) => {
    const t = k + 1;
    return { t, mid: last.close, lo: last.close * Math.exp(p10 * sigma * Math.sqrt(t)), hi: last.close * Math.exp(p90 * sigma * Math.sqrt(t)) };
  });
  const end = path[H - 1];
  const anEnd = an ? last.close * Math.exp(an.avg[H - 1]) : null;
  const d = (x: number) => num(x, x < 100 ? 2 : 0);
  el.innerHTML = `
    <dl class="pd-stats">
      <div><dt>${NAME[asset]} 收盤（${esc(last.date.slice(5))}）</dt><dd class="num">${d(last.close)}</dd></div>
      <div><dt>約一個月後 80% 區間</dt><dd class="num">${d(end.lo)}～${d(end.hi)}</dd></div>
      <div><dt>相似走勢預測線（一個月後）</dt><dd class="num">${anEnd == null ? '—' : `${d(anEnd)} <small>${pctTxt(anEnd / last.close - 1)}</small>`}</dd></div>
      <div><dt>這條線過去的準確度</dt><dd class="num">${bt ? `方向 ${num(bt.hit * 100, 0)}% <small class="muted">／誤差 ${num(bt.rmse * 100, 1)}% vs 不會動 ${num(bt.rmseFlat * 100, 1)}%</small>` : '—'}</dd></div>
    </dl>
    ${chartSvg(candles.slice(-80), path, an, 0, '中線（不會動）')}
    <p class="pd-note">怎麼算的：<b>中線</b>＝不會動（今天的收盤）：${NAME[asset]}一個月後漲或跌沒有可靠的預測（大盤展望的模型回測也沒有贏過「一直猜漲」），所以不假裝。<b>80% 區間</b>＝近 60 日波動 ${num(sigma * 100, 2)}%／天 × √天數，再用${NAME[asset]}自己過去每一天「之後一個月實際漲跌」的 10%／90% 分位數校準${cal?.coverage.length ? `，各年實際落在區間內：${cal.coverage.map((x) => `${esc(x.year)} ${num(x.inside * 100, 0)}%`).join('、')}` : ''}。<b>相似走勢預測線</b>＝自己的歷史裡最近 20 天走勢最像的 5 段，之後一個月的真實走勢依波動比例接在今天後面（粗線平均、細線最像的 3 段）；準確度是同樣方法、只用當時以前的資料回測過去約兩年的成績。</p>
    ${asset === 'tx' ? '<p class="muted pd-small">台指期用近月一般時段（日盤）的日 K，換月時價格會跳一下（新舊合約價差），波動與區間會稍微高估。</p>' : ''}
    ${asset === 'L' ? '<p class="muted pd-small">00631L 是 2 倍槓桿，區間大約是加權指數的兩倍；真正要不要持有，看上面模擬帳戶的趨勢規則（200 日均線＋依波動調整）。</p>' : ''}`;
}
