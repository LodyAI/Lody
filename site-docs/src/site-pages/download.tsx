import { DownloadPage } from '@site/components/download-page';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, localizeSitePath, type SiteLocale } from './shared';

const downloadCopy: Record<
  SiteLocale,
  {
    title: string;
    description: string;
    nightlyTitle: string;
    nightlyDescription: string;
  }
> = {
  en: {
    title: 'Download Lody',
    description: 'Download Lody clients for desktop, mobile, and browser access.',
    nightlyTitle: 'Download Lody Nightly',
    nightlyDescription: 'Download Lody Nightly to try new desktop features early.',
  },
  zh: {
    title: '下载 Lody',
    description: '下载 Lody 桌面端、移动端客户端，或打开浏览器版本。',
    nightlyTitle: '下载 Lody Nightly',
    nightlyDescription: '下载 Lody Nightly，提前体验桌面端新功能。',
  },
  'zh-hant': {
    title: '下載 Lody',
    description: '下載 Lody 桌面端、行動端用戶端，或直接開啟瀏覽器版本。',
    nightlyTitle: '下載 Lody Nightly',
    nightlyDescription: '下載 Lody Nightly，搶先體驗桌面端最新功能。',
  },
  ja: {
    title: 'Lody をダウンロード',
    description:
      'デスクトップ、モバイル向け Lody クライアントのダウンロード、またはブラウザ版の利用。',
    nightlyTitle: 'Lody Nightly をダウンロード',
    nightlyDescription: 'Lody Nightly をダウンロードして、デスクトップ版の新機能をいち早く体験。',
  },
  ko: {
    title: 'Lody 다운로드',
    description: '데스크톱 및 모바일용 Lody 클라이언트를 다운로드하거나 브라우저 버전을 여세요.',
    nightlyTitle: 'Lody Nightly 다운로드',
    nightlyDescription: 'Lody Nightly를 다운로드하여 새로운 데스크톱 기능을 미리 체험해 보세요.',
  },
  es: {
    title: 'Descargar Lody',
    description:
      'Descarga los clientes de Lody para escritorio, móvil o accede desde el navegador.',
    nightlyTitle: 'Descargar Lody Nightly',
    nightlyDescription:
      'Descarga Lody Nightly para probar antes las nuevas funciones de escritorio.',
  },
  fr: {
    title: 'Télécharger Lody',
    description:
      'Téléchargez les clients Lody pour ordinateur et mobile, ou ouvrez la version navigateur.',
    nightlyTitle: 'Télécharger Lody Nightly',
    nightlyDescription:
      'Téléchargez Lody Nightly pour essayer en avant-première les nouveautés desktop.',
  },
  ru: {
    title: 'Скачать Lody',
    description:
      'Скачайте клиенты Lody для компьютера и мобильных устройств или откройте веб-версию.',
    nightlyTitle: 'Скачать Lody Nightly',
    nightlyDescription:
      'Скачайте Lody Nightly, чтобы первыми попробовать новые функции десктопного приложения.',
  },
};

const downloadAlternates = buildLocaleAlternates('/download');
const nightlyDownloadAlternates = buildLocaleAlternates('/download/nightly');

export function downloadHead(locale: SiteLocale): SiteHead {
  const copy = downloadCopy[locale];
  return pageHead({
    title: copy.title,
    description: copy.description,
    path: localizeSitePath('/download', locale),
    locale: localeCode(locale),
    alternates: downloadAlternates,
  });
}

export function DownloadRoutePage({ locale }: { locale: SiteLocale }) {
  return <DownloadPage locale={locale} />;
}

export function nightlyDownloadHead(locale: SiteLocale): SiteHead {
  const copy = downloadCopy[locale];
  return pageHead({
    title: copy.nightlyTitle,
    description: copy.nightlyDescription,
    path: localizeSitePath('/download/nightly', locale),
    locale: localeCode(locale),
    alternates: nightlyDownloadAlternates,
  });
}
