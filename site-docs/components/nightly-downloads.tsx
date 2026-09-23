import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  parseNightlyRelease,
  resolveNightlyDownloadBase,
  type NightlyRelease,
} from '../lib/nightly-downloads';

const copy = {
  en: {
    description:
      'Try changes from main before the next stable release. Nightly is a separate app with its own updates. It uses your existing account and live cloud data.',
    switching:
      'Quit Lody before opening Nightly, and quit Nightly before switching back. Changes synced to your account also appear in Stable.',
    loading: 'Checking Nightly downloads…',
    unavailable: 'Nightly downloads are not available right now.',
    retry: 'Try again',
    noScript: 'Enable JavaScript to load the latest Nightly download links.',
  },
  zh: {
    description:
      '提前体验 main 分支的新功能。Nightly 是独立安装、独立更新的应用，使用现有账号和真实云端数据。',
    switching:
      '打开 Nightly 前请先退出 Lody，切回正式版前请先退出 Nightly。同步到账号的数据修改也会出现在正式版中。',
    loading: '正在获取 Nightly 下载…',
    unavailable: '当前暂无可用的 Nightly 下载。',
    retry: '重试',
    noScript: '请启用 JavaScript，以获取最新的 Nightly 下载链接。',
  },
};

export function NightlyDownloads({ locale }: { locale: 'en' | 'zh' }) {
  const t = copy[locale];
  const base = resolveNightlyDownloadBase(import.meta.env.VITE_NIGHTLY_UPDATE_URL);
  const [release, setRelease] = useState<NightlyRelease | null>(null);
  const [loading, setLoading] = useState(base !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (base === null) return undefined;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    setRelease(null);
    void (async () => {
      try {
        const response = await fetch(`${base}/version.json`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Nightly metadata unavailable');
        const text = await response.text();
        if (text.length > 1024 * 1024) throw new Error('Nightly metadata too large');
        const parsed = parseNightlyRelease(JSON.parse(text), base);
        if (!disposed) setRelease(parsed);
      } catch {
        if (!disposed) setRelease(null);
      } finally {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [base, attempt]);

  return (
    <div className="download-group download-nightly" id="nightly">
      <h2>Lody Nightly</h2>
      <p className="download-nightly__description">{t.description}</p>
      <p className="download-nightly__description">{t.switching}</p>
      <noscript>{t.noScript}</noscript>
      {release ? (
        <>
          <p className="download-nightly__version">v{release.version}</p>
          <p className="download-nightly__description">
            {locale === 'zh'
              ? `如已安装正式版，请先更新到 ${release.minimumStableVersion} 或更高版本，以支持两款应用互斥运行。`
              : `If Stable is installed, update it to ${release.minimumStableVersion} or later so the two apps can prevent concurrent use.`}
          </p>
          <div className="download-grid">
            {(['mac', 'win', 'linux'] as const).map((platform) => (
              <article className="download-card" key={platform}>
                <div className="download-card__header">
                  <h3>{platform === 'mac' ? 'macOS' : platform === 'win' ? 'Windows' : 'Linux'}</h3>
                </div>
                <div className="download-card__actions">
                  {release.downloads
                    .filter((item) => item.platform === platform)
                    .map((item) => (
                      <a className="download-card__action" href={item.href} key={item.href}>
                        <span>{item.label}</span>
                        <Download aria-hidden="true" />
                      </a>
                    ))}
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="download-nightly__status">
          <p role="status">{loading ? t.loading : t.unavailable}</p>
          {!loading && base !== null && (
            <button
              type="button"
              className="download-card__action"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t.retry}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
