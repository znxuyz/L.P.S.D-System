/**
 * 每天會更新的資料檔（大盤風險、新聞、全市場行情…）的記憶：
 * 手機「加到主畫面」的 App 常常只是從背景叫回來、不會重新載入，只記第一次的結果會一直停在好幾天前的資料。
 * 所以記住的結果超過 ttl 就重抓；重抓失敗（離線等）沿用上一次的結果。
 */
export const DATA_TTL = 30 * 60_000;

export function keyedRefresh<T>(load: (key: string) => Promise<T>, ok: (v: T) => boolean, opts: { ttl?: number; max?: number } = {}): (key: string) => Promise<T> {
  const ttl = opts.ttl ?? DATA_TTL;
  const map = new Map<string, { p: Promise<T>; at: number }>();
  return (key) => {
    const e = map.get(key);
    if (e && Date.now() - e.at < ttl) return e.p;
    const prev = e?.p;
    const p = load(key).then((v) => (ok(v) || !prev ? v : prev));
    map.delete(key);
    map.set(key, { p, at: Date.now() });
    if (opts.max && map.size > opts.max) map.delete(map.keys().next().value!);
    return p;
  };
}
