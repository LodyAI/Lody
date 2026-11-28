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
    title: 'Download Lody for macOS, Windows, Linux, iOS & Android',
    description:
      'Download Lody for macOS (Apple Silicon & Intel), Windows, Linux, iOS, and Android, or open the web app to run Claude Code, Codex, and ACP coding agents.',
    nightlyTitle: 'Download Lody Nightly — Early Access Builds',
    nightlyDescription:
      'Download Lody Nightly to try upcoming desktop and Android features early with your existing account and live cloud data.',
  },
  zh: {
    title: '下载 Lody — macOS / Windows / Linux / iOS / Android 客户端',
    description:
      '下载 Lody 桌面端（macOS、Windows、Linux）与移动端（iOS、Android）客户端，或直接打开网页版，多端并行管理 Claude Code、Codex 等 AI 编程 Agent。',
    nightlyTitle: '下载 Lody Nightly — 桌面端与 Android 早期预览版',
    nightlyDescription:
      '下载 Lody Nightly 早期预览版，沿用现有账号与云端数据提前体验最新桌面端与 Android 功能。',
  },
  'zh-hant': {
    title: '下載 Lody — macOS、Windows、Linux、iOS 與 Android 用戶端',
    description:
      '下載 Lody 桌面端（macOS、Windows、Linux）與行動端（iOS、Android）應用程式，或開啟網頁版，跨裝置並行管理 Claude Code、Codex 等 AI 程式設計 Agent。',
    nightlyTitle: '下載 Lody Nightly — 搶先體驗桌面端與 Android 版本',
    nightlyDescription:
      '下載 Lody Nightly 搶先體驗版，沿用現有帳號與雲端資料，搶先試用最新桌面端與 Android 功能。',
  },
  ja: {
    title: 'Lody ダウンロード — macOS・Windows・Linux・iOS・Android 対応',
    description:
      'macOS（Apple Silicon / Intel）・Windows・Linux デスクトップ版や iOS・Android アプリをダウンロード、または Web 版から Claude Code や Codex など AI コーディングエージェントを管理できます。',
    nightlyTitle: 'Lody Nightly ダウンロード — 先行体験ビルド',
    nightlyDescription:
      'Lody Nightly をダウンロードして、既存アカウントとクラウドデータのまま最新のデスクトップ・Android 機能をいち早くお試しいただけます。',
  },
  ko: {
    title: 'Lody 다운로드 — macOS·Windows·Linux·iOS·Android 앱',
    description:
      'macOS(Apple Silicon·Intel), Windows, Linux 데스크톱 앱과 iOS·Android 모바일 앱을 다운로드하거나 웹에서 Claude Code·Codex 등 AI 코딩 에이전트를 병렬 관리하세요.',
    nightlyTitle: 'Lody Nightly 다운로드 — 얼리 액세스 빌드',
    nightlyDescription:
      'Lody Nightly를 다운로드하여 기존 계정과 실시간 클라우드 데이터로 최신 데스크톱 및 Android 기능을 먼저 체험해 보세요.',
  },
  es: {
    title: 'Descargar Lody — App para macOS, Windows, Linux, iOS y Android',
    description:
      'Descarga Lody para macOS, Windows, Linux, iOS y Android, o abre la app web para ejecutar Claude Code, Codex y agentes de código IA en paralelo.',
    nightlyTitle: 'Descargar Lody Nightly — Compilaciones de acceso anticipado',
    nightlyDescription:
      'Descarga Lody Nightly para probar antes las nuevas funciones de escritorio y Android con tu cuenta actual y tus datos reales en la nube.',
  },
  fr: {
    title: 'Télécharger Lody — macOS, Windows, Linux, iOS et Android',
    description:
      'Téléchargez Lody pour macOS, Windows, Linux, iOS et Android, ou ouvrez l’app web pour piloter Claude Code, Codex et vos agents de code IA en parallèle.',
    nightlyTitle: 'Télécharger Lody Nightly — Versions en accès anticipé',
    nightlyDescription:
      'Téléchargez Lody Nightly pour tester en avant-première les nouveautés ordinateur et Android avec votre compte existant et vos données cloud.',
  },
  ru: {
    title: 'Скачать Lody — macOS, Windows, Linux, iOS и Android',
    description:
      'Скачайте Lody для macOS, Windows, Linux, iOS и Android или откройте веб-версию, чтобы параллельно запускать Claude Code, Codex и ACP ИИ-агентов для кода.',
    nightlyTitle: 'Скачать Lody Nightly — Сборки раннего доступа',
    nightlyDescription:
      'Скачайте Lody Nightly, чтобы первыми тестировать новые функции для компьютера и Android со своей учётной записью и облачными данными.',
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
