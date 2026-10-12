import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * 打包完寫出 version.json：index.html 用到的程式與樣式檔名（檔名帶內容雜湊，程式有改就會變）。
 * 網頁會定期比對，版本不同就自動更新（見 src/data/appUpdate.ts）。
 */
function versionFile(): Plugin {
  let outDir = 'dist';
  return {
    name: 'lplc-version',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const html = readFileSync(resolve(outDir, 'index.html'), 'utf8');
      const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="[^"]*?(assets\/[^"?#]+)/g)].map((m) => m[1]);
      writeFileSync(resolve(outDir, 'version.json'), JSON.stringify({ v: [...new Set(refs)].sort().join(',') }));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [versionFile()],
  test: {
    environment: 'node',
  },
});
