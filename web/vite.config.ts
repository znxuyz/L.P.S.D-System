import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// ENTRY=compare 時只打包提案比較頁（單一入口，方便合併成單一 HTML 預覽）
const only = process.env.ENTRY;
const pages: Record<string, string> = {
  main: resolve(__dirname, 'index.html'),
  compare: resolve(__dirname, 'compare.html'),
};

export default defineConfig({
  base: './',
  build: {
    outDir: only ? `dist-${only}` : 'dist',
    rollupOptions: { input: only ? { [only]: pages[only] } : pages },
  },
  test: {
    environment: 'node',
  },
});
