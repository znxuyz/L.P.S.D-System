/**
 * 找資料來源用（不存任何東西）：列出證交所、櫃買開放資料 API 裡名稱含關鍵字的接口，並試抓一筆看欄位。
 *
 *   PROBE_WORDS=內部人,轉讓 node scripts/tools/probe-openapi.ts
 */
const WORDS = (process.env.PROBE_WORDS ?? '內部人,轉讓,持股').split(',');
const SOURCES = [
  ['證交所', 'https://openapi.twse.com.tw/v1/swagger.json', 'https://openapi.twse.com.tw/v1'],
  ['櫃買', 'https://www.tpex.org.tw/openapi/swagger.json', 'https://www.tpex.org.tw/openapi'],
] as const;
for (const [name, url, base] of SOURCES) {
  try {
    const j: any = await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).json();
    const hits = Object.entries<any>(j.paths ?? {}).filter(([p, v]) => WORDS.some((w) => JSON.stringify(v).includes(w) || p.includes(w)));
    console.log(`== ${name}：${Object.keys(j.paths ?? {}).length} 個接口，符合 ${hits.length} 個`);
    for (const [p, v] of hits) {
      const sum = Object.values<any>(v).map((x) => x.summary ?? x.description ?? '').join(' ');
      console.log(`  ${p}  ${sum}`);
      try {
        const d: any = await (await fetch(`${base}${p}`, { signal: AbortSignal.timeout(60_000) })).json();
        const rows = Array.isArray(d) ? d : d?.data ?? [];
        console.log(`    ${rows.length} 筆；第一筆：${JSON.stringify(rows[0]).slice(0, 400)}`);
      } catch (e) {
        console.log(`    抓取失敗 ${e}`);
      }
    }
  } catch (e) {
    console.log(`== ${name}：讀不到 swagger ${e}`);
  }
}
