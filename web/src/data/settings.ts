/**
 * 資料來源設定，存在這台裝置的瀏覽器（localStorage）。
 * API 金鑰不會寫進程式碼或 repo，所以公開的 GitHub Pages 網站不會外洩金鑰。
 */

export type DataSource = 'mock' | 'fugle';

export interface SourceSettings {
  source: DataSource;
  fugleKey: string;
}

const SOURCE_KEY = 'lplc.source';
const FUGLE_KEY = 'lplc.fugle.key';

export function loadSettings(): SourceSettings {
  try {
    const fugleKey = localStorage.getItem(FUGLE_KEY) ?? '';
    const source = localStorage.getItem(SOURCE_KEY) === 'fugle' && fugleKey ? 'fugle' : 'mock';
    return { source, fugleKey };
  } catch {
    return { source: 'mock', fugleKey: '' };
  }
}

export function saveSettings(s: SourceSettings): void {
  try {
    localStorage.setItem(SOURCE_KEY, s.source);
    if (s.fugleKey) localStorage.setItem(FUGLE_KEY, s.fugleKey);
    else localStorage.removeItem(FUGLE_KEY);
  } catch {
    /* 無法儲存時，這次設定只在重新整理前有效 */
  }
}
