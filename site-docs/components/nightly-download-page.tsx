import { SiteAnchor } from '@site/components/site-anchor';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';
import { NightlyDownloads } from './nightly-downloads';

type NightlyPageCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  stableCta: string;
};

const copy: Record<SiteLocale, NightlyPageCopy> = {
  en: {
    eyebrow: 'Nightly · Early access',
    title: 'Download Lody Nightly',
    subtitle: 'Try new features early using your existing account and live cloud data.',
    stableCta: 'Download Lody Stable',
  },
  zh: {
    eyebrow: 'Nightly · 早期预览版',
    title: '下载 Lody Nightly',
    subtitle: '提前体验新功能，使用现有账号和真实云端数据。',
    stableCta: '下载正式版 Lody',
  },
  'zh-hant': {
    eyebrow: 'Nightly · 搶先體驗版',
    title: '下載 Lody Nightly',
    subtitle: '搶先體驗最新功能，沿用現有帳號與真實雲端資料。',
    stableCta: '下載正式版 Lody',
  },
  ja: {
    eyebrow: 'Nightly · アーリーアクセス',
    title: 'Lody Nightly をダウンロード',
    subtitle: '既存のアカウントと本番クラウドデータで新機能をいち早く試せます。',
    stableCta: 'Lody 安定版をダウンロード',
  },
  ko: {
    eyebrow: 'Nightly · 얼리 액세스',
    title: 'Lody Nightly 다운로드',
    subtitle: '기존 계정과 실제 클라우드 데이터를 사용해 새 기능을 먼저 체험해 보세요.',
    stableCta: 'Lody 정식 버전 다운로드',
  },
  es: {
    eyebrow: 'Nightly · Acceso anticipado',
    title: 'Descargar Lody Nightly',
    subtitle:
      'Prueba funciones nuevas antes de tiempo con tu cuenta actual y tus datos reales en la nube.',
    stableCta: 'Descargar Lody Estable',
  },
  fr: {
    eyebrow: 'Nightly · Accès anticipé',
    title: 'Télécharger Lody Nightly',
    subtitle:
      'Essayez les nouvelles fonctionnalités en avant-première avec votre compte existant et vos données cloud réelles.',
    stableCta: 'Télécharger Lody Stable',
  },
  ru: {
    eyebrow: 'Nightly · Ранний доступ',
    title: 'Скачать Lody Nightly',
    subtitle:
      'Опробуйте новые функции заранее со своей учётной записью и актуальными облачными данными.',
    stableCta: 'Скачать стабильную версию Lody',
  },
};

export function NightlyDownloadPage({ locale }: { locale: SiteLocale }) {
  const t = copy[locale];
  return (
    <main className="download-page download-page--nightly marketing-shell">
      <SiteNav locale={locale} />
      <section className="download-hero">
        <div className="download-hero__content">
          <p className="download-eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p className="download-subtitle">{t.subtitle}</p>
          <SiteAnchor
            className="download-nightly__stable"
            href={localizeSitePath('/download', locale)}
          >
            {t.stableCta}
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
