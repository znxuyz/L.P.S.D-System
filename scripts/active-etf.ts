/**
 * 每天抓主動式 ETF 的持股（GitHub Actions 排程執行）。
 *
 *   node scripts/active-etf.ts <資料資料夾>
 *
 * 資料資料夾裡的兩個檔案：
 * - active-etf-history.json：每檔 ETF 最近 10 個交易日的持股快照（比對用，不發佈）。
 * - active-etf.json：網頁讀的檔案，含最新持股與近 5 個交易日的異動。
 *
 * 某一家抓取失敗時保留舊資料，不會讓整份檔案壞掉。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksValid, pushSnapshot, recentChanges, type HoldingRow, type Snapshot } from '../web/src/data/activeEtfDiff.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 L.P.L.C.-System';
const num = (v: unknown) => Number(String(v ?? '').replace(/,/g, ''));
const isoDate = (s: string) => s.slice(0, 10).replace(/\//g, '-');

interface Source {
  code: string;
  issuer: string;
  fetch: () => Promise<Snapshot>;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** 野村投信：Fund/GetFundAssets 回傳持股表格。 */
async function nomura(fundId: string): Promise<Snapshot> {
  const j = await postJson('https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundAssets', { FundID: fundId, SearchDate: null });
  const data = j?.Entries?.Data;
  const table = (data?.Table ?? []).find((t: any) => t.TableTitle === '股票');
  if (!table) throw new Error('野村：找不到股票表格');
  const holdings: HoldingRow[] = table.Rows.map((r: string[]) => ({ code: r[0].trim(), name: r[1].trim(), shares: num(r[2]), weight: num(r[3]) }));
  return { date: isoDate(data.FundAsset?.NavDate ?? ''), units: num(data.FundAsset?.Units) || undefined, holdings };
}

/** 群益投信：申購買回清單 API。 */
async function capital(fundId: string): Promise<Snapshot> {
  const j = await postJson('https://www.capitalfund.com.tw/CFWeb/api/etf/buyback', { fundId, date: null });
  const pcf = j?.data?.pcf;
  const stocks = j?.data?.stocks;
  if (!pcf || !Array.isArray(stocks)) throw new Error('群益：回應格式不同');
  const holdings: HoldingRow[] = stocks.map((s: any) => ({ code: String(s.stocNo).trim(), name: String(s.stocName).trim(), shares: num(s.share), weight: num(s.weight) }));
  // date2 是淨值日（資料所屬日），date1 是下一個申購日
  return { date: isoDate(pcf.date2 ?? ''), units: num(pcf.totUnit) || undefined, holdings };
}

/** 統一投信：基金頁面內嵌的 DataAsset JSON（需要先拿 cookie）。 */
async function ezmoney(fundCode: string): Promise<Snapshot> {
  const jar = new Map<string, string>();
  let url = `https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=${fundCode}`;
  let html = '';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      jar.set(k.trim(), v.join('='));
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    if (!res.ok) throw new Error(`統一：HTTP ${res.status}`);
    html = await res.text();
    break;
  }
  const m = html.match(/id="DataAsset" data-content="([^"]*)"/);
  if (!m) throw new Error('統一：找不到 DataAsset');
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const assets: any[] = JSON.parse(decode(m[1]));
  const st = assets.find((a) => a.AssetCode === 'ST');
  if (!st?.Details?.length) throw new Error('統一：沒有股票明細');
  const units = num(assets.find((a) => a.AssetCode === 'OUT_UNIT')?.Value) || undefined;
  const holdings: HoldingRow[] = st.Details.map((d: any) => ({ code: String(d.DetailCode).trim(), name: String(d.DetailName).trim(), shares: num(d.Share), weight: num(d.NavRate) }));
  return { date: isoDate(st.Details[0].TranDate ?? ''), units, holdings };
}

const SOURCES: Source[] = [
  { code: '00980A', issuer: '野村投信', fetch: () => nomura('00980A') },
  { code: '00981A', issuer: '統一投信', fetch: () => ezmoney('49YTW') },
  { code: '00982A', issuer: '群益投信', fetch: () => capital('399') },
];

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'data';
  mkdirSync(dir, { recursive: true });
  const historyPath = join(dir, 'active-etf-history.json');
  const history = readJson<Record<string, Snapshot[]>>(historyPath, {});
  const meta = readJson<{ etfs?: Record<string, { issuer: string; fetchedAt?: string; error?: string }> }>(join(dir, 'active-etf.json'), {}).etfs ?? {};

  let ok = 0;
  for (const src of SOURCES) {
    try {
      const snap = await src.fetch();
      snap.holdings = snap.holdings.filter((h) => h.code && h.weight > 0).sort((a, b) => b.weight - a.weight);
      if (!looksValid(snap)) throw new Error(`資料不完整（${snap.holdings.length} 檔，日期 ${snap.date}）`);
      history[src.code] = pushSnapshot(history[src.code] ?? [], snap);
      meta[src.code] = { issuer: src.issuer, fetchedAt: new Date().toISOString() };
      ok++;
      console.log(`✓ ${src.code} ${src.issuer} ${snap.date} ${snap.holdings.length} 檔`);
    } catch (e) {
      meta[src.code] = { ...(meta[src.code] ?? { issuer: src.issuer }), error: String(e) };
      console.log(`✗ ${src.code} ${src.issuer}：${e}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    etfs: Object.fromEntries(
      Object.entries(history).map(([code, snaps]) => {
        const latest = snaps[snaps.length - 1];
        return [
          code,
          {
            ...meta[code],
            asOf: latest.date,
            snapshots: snaps.length,
            holdings: latest.holdings,
            changes: recentChanges(snaps, 5),
          },
        ];
      }),
    ),
  };
  writeFileSync(historyPath, JSON.stringify(history));
  writeFileSync(join(dir, 'active-etf.json'), JSON.stringify(out, null, 1));
  console.log(`完成：${ok} / ${SOURCES.length} 檔成功`);
  // 全部失敗才回報錯誤，部分失敗仍發佈其他資料
  if (ok === 0) process.exitCode = 1;
}

await main();
