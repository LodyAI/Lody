import { SiteAnchor } from '@site/components/site-anchor';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';
import { NightlyDownloads } from './nightly-downloads';

export function NightlyDownloadPage({ locale }: { locale: 'en' | 'zh' }) {
  const isZh = locale === 'zh';
  return (
    <main className="download-page download-page--nightly marketing-shell">
      <SiteNav locale={locale} languageHref={isZh ? '/download/nightly' : '/zh/download/nightly'} />
      <section className="download-hero">
        <div className="download-hero__content">
          <p className="download-eyebrow">
            {isZh ? 'Nightly · 早期预览版' : 'Nightly · Early access'}
          </p>
          <h1>{isZh ? '下载 Lody Nightly' : 'Download Lody Nightly'}</h1>
          <p className="download-subtitle">
            {isZh
              ? '提前体验新功能，使用现有账号和真实云端数据。'
              : 'Try new features early using your existing account and live cloud data.'}
          </p>
          <SiteAnchor
            className="download-nightly__stable"
            href={isZh ? '/zh/download' : '/download'}
          >
            {isZh ? '下载正式版 Lody' : 'Download Lody Stable'}
          </SiteAnchor>
        </div>
      </section>
      <section className="download-content">
        <NightlyDownloads locale={locale} />
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
