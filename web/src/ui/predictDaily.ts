/**
 * 盤中預測區塊的「日 K」：00631L、加權指數、台指期（日盤）未來約三個月的預測。
 * 跟個股預測一樣：中線＝不會動（指數、期貨沒有營收選股分數，方向沒有可靠的預測）、80% 區間用自己的歷史校準、
 * 相似走勢預測線（自己的歷史裡最像的 5 段）附回測準確度。
 */
import type { Candle } from '../domain/technicals';
import { analogBacktest, analogForecast, bandCalib, dailyVol, directionPath, typicalMove } from '../domain/stockForecast';
import { adjustSplits, loadOfficialCandles } from '../data/candles';
import { escapeHtml as esc, num } from './format';
import { chartSvg, FH } from './predictStock';

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
  const H = FH;
  const sigma = dailyVol(closes);
  const cal = bandCalib(closes, candles.map((c) => c.date), H);
  const an = analogForecast(closes, closes.length - 1, 20, H);
  const bt = analogBacktest(closes, H);
  const last = candles[candles.length - 1];
  const p10 = cal?.p10 ?? -1.28;
  const p90 = cal?.p90 ?? 1.28;
  // 主線：方向預測（一定押方向）；沒有相似走勢時才退回不會動
  const dp = an ? directionPath(an, 5, typicalMove(sigma, H)) : null;
  // 漲跌停：00631L 每天 ±20%、台指期 ±10%（加權指數沒有）；t 天後最多 (1±幅度)^t
  const lim = asset === 'L' ? 0.2 : asset === 'tx' ? 0.1 : 0;
  const cap = (x: number, t: number) => (lim ? Math.min(last.close * (1 + lim) ** t, Math.max(last.close * (1 - lim) ** t, x)) : x);
  const path = Array.from({ length: H }, (_, k) => {
    const t = k + 1;
    return { t, mid: cap(dp ? last.close * Math.exp(dp[k]) : last.close, t), lo: cap(last.close * Math.exp(p10 * sigma * Math.sqrt(t)), t), hi: cap(last.close * Math.exp(p90 * sigma * Math.sqrt(t)), t) };
  });
  const end = path[H - 1];
  const up = dp ? dp[H - 1] >= 0 : null;
  const m1 = path[20];
  const d = (x: number) => num(x, x < 100 ? 2 : 0);
  el.innerHTML = `
    <dl class="pd-stats">
      <div><dt>${NAME[asset]} 收盤（${esc(last.date.slice(5))}）</dt><dd class="num">${d(last.close)}</dd></div>
      <div><dt>80% 區間（一個月後）</dt><dd class="num">${d(m1.lo)}～${d(m1.hi)}</dd></div>
      <div><dt>80% 區間（三個月後）</dt><dd class="num">${d(end.lo)}～${d(end.hi)}</dd></div>
      <div><dt>方向預測（一個月／三個月後）</dt><dd class="num">${up == null ? '—' : `<b class="${up ? 'up' : 'down'}">${up ? '押漲' : '押跌'}</b> ${d(m1.mid)} <small>${pctTxt(m1.mid / last.close - 1)}</small>／${d(end.mid)} <small>${pctTxt(end.mid / last.close - 1)}</small>`}</dd></div>
      <div><dt>方向命中率（三個月後，過去約兩年）</dt><dd class="num">${bt ? `${num(bt.hit * 100, 0)}% <small class="muted">（${num(bt.n)} 次；同期間一直押漲 ${num(bt.upRate * 100, 0)}%）</small>` : '—'}</dd></div>
    </dl>
    ${chartSvg(candles.slice(-H), path, an, 0, '方向預測（主線）')}
    <p class="pd-note">怎麼算的：<b>方向預測（主線）</b>一定押一個方向：在${NAME[asset]}自己的歷史裡找最近 20 天走勢形狀（漲跌先除以當時的波動）最像現在的 5 段，看它們之後三個月平均是漲還是跌來決定方向；線的形狀與幅度＝其中「也往這個方向走」的那幾段真實走勢的平均，終點幅度＝這種波動下三個月一般會走的幅度（中位數），所以會有一般行情該有的起伏，不會是一條平線。<b>方向命中率</b>是同樣方法、只用當時以前的資料，回測過去約兩年（每 5 天一次）三個月後方向猜對的比例。<b>80% 區間</b>＝近 60 日波動 ${num(sigma * 100, 2)}%／天 × √天數，再用${NAME[asset]}自己過去每一天「之後三個月實際漲跌」的 10%／90% 分位數校準${cal?.coverage.length ? `，各年實際落在區間內：${cal.coverage.map((x) => `${esc(x.year)} ${num(x.inside * 100, 0)}%`).join('、')}` : ''}。</p>
    ${asset === 'tx' ? '<p class="muted pd-small">台指期用近月一般時段（日盤）的日 K，換月時價格會跳一下（新舊合約價差），波動與區間會稍微高估。</p>' : ''}
    ${asset === 'L' ? '<p class="muted pd-small">00631L 是 2 倍槓桿，區間大約是加權指數的兩倍；真正要不要持有，看上面模擬帳戶的趨勢規則（200 日均線＋依波動調整）。</p>' : ''}`;
}
