/**
 * 自動更新：手機「加到主畫面」的網頁常常只是從背景叫回來、不會重新載入，所以一直停在舊版。
 *
 * - 部署時產生 version.json（這一版的程式檔名），網頁打開時、從背景回來時、每 15 分鐘檢查一次。
 * - 版本不一樣就重新載入；模擬盤正在播放時不打斷，等暫停、離開 App 或按提示再更新。
 * - 同一個新版本最多每 5 分鐘自動重新載入一次（CDN 還沒換好時不會一直重整）。
 */
const CHECK_MS = 15 * 60_000;
const RETRY_KEY = 'lplc.update.tried';

/** 這一頁載入的程式與樣式檔名（跟 version.json 用同樣的算法）。 */
function currentVersion(): string {
  const refs = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]')]
    .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
    .map((u) => u.match(/assets\/[^?#]+/)?.[0])
    .filter((u): u is string => !!u);
  return [...new Set(refs)].sort().join(',');
}

async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { v?: string };
    return typeof j.v === 'string' && j.v ? j.v : null;
  } catch {
    return null;
  }
}

export function startUpdateCheck(canReload: () => boolean): void {
  const mine = currentVersion();
  if (!mine) return;
  let pending: string | null = null;
  let banner: HTMLButtonElement | null = null;

  const reload = () => {
    if (!pending) return;
    try {
      const tried = JSON.parse(sessionStorage.getItem(RETRY_KEY) ?? 'null') as { v: string; t: number } | null;
      if (tried?.v === pending && Date.now() - tried.t < 5 * 60_000) return;
      sessionStorage.setItem(RETRY_KEY, JSON.stringify({ v: pending, t: Date.now() }));
    } catch {
      /* 存不了就照樣重新載入 */
    }
    // 讓 Service Worker 也換成新版，再重新載入（離開前模擬盤會自己存檔）
    void (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch {
        /* 沒有 Service Worker 也照樣重新載入 */
      }
      location.reload();
    })();
  };

  const showBanner = () => {
    if (banner) return;
    banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'update-banner glass';
    banner.textContent = '🔄 有新版本，點這裡更新';
    banner.addEventListener('click', () => {
      try {
        sessionStorage.removeItem(RETRY_KEY);
      } catch {
        /* 沒關係 */
      }
      reload();
    });
    document.body.append(banner);
  };

  const apply = () => {
    if (!pending) return;
    if (canReload()) reload();
    else showBanner();
  };

  let checking = false;
  const check = async () => {
    if (checking || !navigator.onLine) return;
    checking = true;
    const v = await latestVersion();
    checking = false;
    if (v && v !== mine) {
      pending = v;
      apply();
    }
  };

  document.addEventListener('visibilitychange', () => {
    // 切到背景時如果有新版，先重新載入（模擬盤已經在 hidden 時存檔），回來就是新版
    if (document.visibilityState === 'hidden') {
      if (pending) reload();
    } else void check();
  });
  window.addEventListener('pageshow', (e) => e.persisted && void check());
  window.addEventListener('online', () => void check());
  setInterval(() => document.visibilityState === 'visible' && void check(), CHECK_MS);
  // 模擬盤暫停或離開時，把等著的更新套用上去
  setInterval(() => pending && document.visibilityState === 'visible' && canReload() && reload(), 5_000);
  setTimeout(() => void check(), 3_000);
}
