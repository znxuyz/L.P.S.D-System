/**
 * 資料來源設定，存在這台裝置的瀏覽器（localStorage）。
 * API 金鑰不會寫進程式碼或 repo，所以公開的 GitHub Pages 網站不會外洩金鑰。
 */

export type DataSource = 'mock' | 'fugle' | 'twse';

export interface SourceSettings {
  source: DataSource;
  fugleKey: string;
  /** 證交所 MIS 轉接服務（Cloudflare Worker）的網址。 */
  misProxy: string;
}

const SOURCE_KEY = 'lplc.source';
const FUGLE_KEY = 'lplc.fugle.key';
const PROXY_KEY = 'lplc.mis.proxy';

export function loadSettings(): SourceSettings {
  try {
    const fugleKey = localStorage.getItem(FUGLE_KEY) ?? '';
    const misProxy = localStorage.getItem(PROXY_KEY) ?? '';
    const stored = localStorage.getItem(SOURCE_KEY);
    const source: DataSource = stored === 'fugle' && fugleKey ? 'fugle' : stored === 'twse' && misProxy ? 'twse' : 'mock';
    return { source, fugleKey, misProxy };
  } catch {
    return { source: 'mock', fugleKey: '', misProxy: '' };
  }
}

export function saveSettings(s: SourceSettings): void {
  try {
    localStorage.setItem(SOURCE_KEY, s.source);
    if (s.fugleKey) localStorage.setItem(FUGLE_KEY, s.fugleKey);
    else localStorage.removeItem(FUGLE_KEY);
    if (s.misProxy) localStorage.setItem(PROXY_KEY, s.misProxy);
    else localStorage.removeItem(PROXY_KEY);
  } catch {
    /* 無法儲存時，這次設定只在重新整理前有效 */
  }
}
