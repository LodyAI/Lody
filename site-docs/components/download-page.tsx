'use client';

import { SiteAnchor } from '@site/components/site-anchor';
import { SITE_LOCALE_META, type SiteLocale } from '@site/src/site-pages/shared';

import { Download, ExternalLink, Globe2, Laptop, MonitorDown, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';

type DownloadLocale = SiteLocale;
type PlatformKey = 'mac' | 'win' | 'linux' | 'ios' | 'android' | 'browser';

type DownloadItem = {
  label: string;
  file?: string;
  href?: string;
  action?: 'download' | 'open';
  target?: '_self' | '_blank';
};

type Platform = {
  key: PlatformKey;
  name: string;
  description: string;
  icon: typeof Laptop;
  downloads: DownloadItem[];
};

type VersionMetadata = {
  version?: string;
  releaseDate?: string;
  // Maps each stable "Lody-latest-*" filename to its version-pinned counterpart
  // (e.g. "Lody-latest-arm64.dmg" -> "Lody-0.62.0-arm64.dmg").
  downloads?: Record<string, string>;
};

type AndroidReleaseMetadata = {
  downloadUrl?: string;
  versionDownloadUrl?: string;
};

const DOWNLOAD_BASE = 'https://updates.lody.ai/production';
const MOBILE_ANDROID_DOWNLOAD_BASE = 'https://updates.lody.ai/mobile/production';
const MOBILE_ANDROID_FALLBACK_DOWNLOAD_URL = `${MOBILE_ANDROID_DOWNLOAD_BASE}/lody-android-latest.apk`;

/** App Store product page — CN vs US storefront (main branch DownloadPage.vue). */
const APP_STORE_HREF_EN = 'https://apps.apple.com/us/app/lody-run-code-agent-anywhere/id6761373528';
const APP_STORE_HREF_ZH =
  'https://apps.apple.com/cn/app/lody-%E9%9A%8F%E6%97%B6%E9%9A%8F%E5%9C%B0%E8%BF%90%E8%A1%8C-code-agent/id6761373528';
const GOOGLE_PLAY_HREF = 'https://play.google.com/store/apps/details?id=ai.lody.android';

type DownloadCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  desktop: string;
  mobile: string;
  detected: string;
  versionPrefix: string;
  datePrefix: string;
  browserName: string;
  openApp: string;
  appStoreHref: string;
  platforms: {
    mac: string;
    win: string;
    linux: string;
    ios: string;
    android: string;
    browser: string;
  };
};

const copy: Record<DownloadLocale, DownloadCopy> = {
  en: {
    eyebrow: 'Get the apps',
    title: 'Download Lody',
    subtitle:
      'Manage all your code agents in one place. Conversations sync across devices in real time.',
    desktop: 'Desktop',
    mobile: 'Mobile and browser',
    detected: 'Detected platform',
    versionPrefix: 'Latest',
    datePrefix: 'Released',
    browserName: 'Browser',
    openApp: 'Open app',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Universal desktop app for macOS with Apple Silicon and Intel builds.',
      win: 'Signed Windows installer for x64 machines.',
      linux: 'Linux builds for AppImage and Debian/Ubuntu environments.',
      ios: 'Get Lody on the App Store.',
      android: 'Install from Google Play, or download the signed APK.',
      browser: 'Open the hosted web app in your browser.',
    },
  },
  zh: {
    eyebrow: '获取客户端',
    title: '下载 Lody',
    subtitle: '轻松管理你的所有 code agent，所有对话记录多端实时同步。',
    desktop: '桌面端',
    mobile: '移动端和浏览器',
    detected: '检测到的平台',
    versionPrefix: '最新版本',
    datePrefix: '发布日期',
    browserName: '浏览器',
    openApp: '打开应用',
    appStoreHref: APP_STORE_HREF_ZH,
    platforms: {
      mac: '适用于 macOS 的桌面应用，提供 Apple Silicon 和 Intel 构建。',
      win: '适用于 x64 Windows 机器的签名安装包。',
      linux: '适用于 AppImage 与 Debian/Ubuntu 环境的 Linux 构建。',
      ios: '在 App Store 安装 Lody。',
      android: '从 Google Play 安装，或下载签名 APK。',
      browser: '在浏览器中打开托管版 Web 应用。',
    },
  },
  'zh-hant': {
    eyebrow: '取得應用程式',
    title: '下載 Lody',
    subtitle: '在單一工作區管理所有程式設計 Agent，所有對話紀錄跨裝置即時同步。',
    desktop: '桌面端',
    mobile: '行動裝置與瀏覽器',
    detected: '偵測到的平台',
    versionPrefix: '最新版本',
    datePrefix: '發佈日期',
    browserName: '瀏覽器',
    openApp: '開啟應用程式',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: '適用於 macOS 的桌面應用程式，提供 Apple Silicon 與 Intel 版本。',
      win: '適用於 x64 Windows 電腦的已簽署安裝程式。',
      linux: '適用於 AppImage 與 Debian/Ubuntu 環境的 Linux 版本。',
      ios: '在 App Store 取得 Lody。',
      android: '透過 Google Play 安裝，或下載已簽署的 APK。',
      browser: '在瀏覽器中開啟託管版 Web 應用程式。',
    },
  },
  ja: {
    eyebrow: 'アプリを入手',
    title: 'Lody をダウンロード',
    subtitle:
      'すべてのコーディングエージェントを一か所で管理。会話は複数デバイス間でリアルタイム同期されます。',
    desktop: 'デスクトップ',
    mobile: 'モバイル・ブラウザー',
    detected: '検出されたプラットフォーム',
    versionPrefix: '最新',
    datePrefix: 'リリース日',
    browserName: 'ブラウザー',
    openApp: 'アプリを開く',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Apple Silicon と Intel 向けビルドを備えた macOS 用デスクトップアプリ。',
      win: 'x64 環境向けの署名済み Windows インストーラー。',
      linux: 'AppImage および Debian/Ubuntu 環境向けの Linux ビルド。',
      ios: 'App Store から Lody をインストール。',
      android: 'Google Play からインストールするか、署名済み APK をダウンロード。',
      browser: 'ブラウザーでホスト版 Web アプリを開く。',
    },
  },
  ko: {
    eyebrow: '앱 받기',
    title: 'Lody 다운로드',
    subtitle:
      '모든 코딩 에이전트를 한곳에서 관리하세요. 대화가 여러 기기에서 실시간으로 동기화됩니다.',
    desktop: '데스크톱',
    mobile: '모바일 및 브라우저',
    detected: '감지된 플랫폼',
    versionPrefix: '최신',
    datePrefix: '출시일',
    browserName: '브라우저',
    openApp: '앱 열기',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Apple Silicon 및 Intel 빌드를 지원하는 macOS용 데스크톱 앱.',
      win: 'x64 Windows PC용 서명된 설치 파일.',
      linux: 'AppImage 및 Debian/Ubuntu 환경용 Linux 빌드.',
      ios: 'App Store에서 Lody를 설치하세요.',
      android: 'Google Play에서 설치하거나 서명된 APK를 다운로드하세요.',
      browser: '브라우저에서 호스팅 웹 앱을 바로 여세요.',
    },
  },
  es: {
    eyebrow: 'Consigue las aplicaciones',
    title: 'Descargar Lody',
    subtitle:
      'Gestiona todos tus agentes de programación desde un solo lugar. Las conversaciones se sincronizan entre dispositivos en tiempo real.',
    desktop: 'Escritorio',
    mobile: 'Móvil y navegador',
    detected: 'Plataforma detectada',
    versionPrefix: 'Última',
    datePrefix: 'Publicado',
    browserName: 'Navegador',
    openApp: 'Abrir aplicación',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Aplicación de escritorio universal para macOS con compilaciones para Apple Silicon e Intel.',
      win: 'Instalador firmado de Windows para equipos x64.',
      linux: 'Compilaciones de Linux para AppImage y entornos Debian/Ubuntu.',
      ios: 'Descarga Lody en el App Store.',
      android: 'Instala desde Google Play o descarga el APK firmado.',
      browser: 'Abre la aplicación web alojada en tu navegador.',
    },
  },
  fr: {
    eyebrow: 'Télécharger les applications',
    title: 'Télécharger Lody',
    subtitle:
      'Gérez tous vos agents de code au même endroit. Les conversations se synchronisent en temps réel sur tous vos appareils.',
    desktop: 'Ordinateur',
    mobile: 'Mobile et navigateur',
    detected: 'Plateforme détectée',
    versionPrefix: 'Dernière',
    datePrefix: 'Publiée le',
    browserName: 'Navigateur',
    openApp: "Ouvrir l'application",
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Application de bureau universelle pour macOS avec versions Apple Silicon et Intel.',
      win: 'Installateur Windows signé pour machines x64.',
      linux: 'Versions Linux pour AppImage et environnements Debian/Ubuntu.',
      ios: "Téléchargez Lody sur l'App Store.",
      android: "Installez depuis Google Play ou téléchargez l'APK signé.",
      browser: "Ouvrez l'application web hébergée dans votre navigateur.",
    },
  },
  ru: {
    eyebrow: 'Скачать приложения',
    title: 'Скачать Lody',
    subtitle:
      'Управляйте всеми агентами разработки в одном месте. Диалоги синхронизируются между устройствами в реальном времени.',
    desktop: 'Компьютер',
    mobile: 'Мобильные устройства и браузер',
    detected: 'Определённая платформа',
    versionPrefix: 'Актуальная',
    datePrefix: 'Выпущено',
    browserName: 'Браузер',
    openApp: 'Открыть приложение',
    appStoreHref: APP_STORE_HREF_EN,
    platforms: {
      mac: 'Настольное приложение для macOS со сборками для Apple Silicon и Intel.',
      win: 'Подписанный установщик Windows для систем x64.',
      linux: 'Сборки Linux для AppImage и систем Debian/Ubuntu.',
      ios: 'Установите Lody из App Store.',
      android: 'Установите из Google Play или скачайте подписанный APK.',
      browser: 'Откройте веб-приложение прямо в браузере.',
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDownloadsMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(value)) {
    if (typeof mapped === 'string' && mapped.length > 0) map[key] = mapped;
  }
  return map;
}

function parseVersionMetadata(value: unknown): VersionMetadata {
  if (!isObject(value)) return {};
  return {
    version: typeof value.version === 'string' ? value.version : undefined,
    releaseDate: typeof value.releaseDate === 'string' ? value.releaseDate : undefined,
    downloads: parseDownloadsMap(value.downloads),
  };
}

function parseAndroidReleaseMetadata(value: unknown): AndroidReleaseMetadata {
  if (!isObject(value)) return {};
  return {
    downloadUrl: typeof value.downloadUrl === 'string' ? value.downloadUrl : undefined,
    versionDownloadUrl:
      typeof value.versionDownloadUrl === 'string' ? value.versionDownloadUrl : undefined,
  };
}

// Prefer the version-pinned asset so the URL reflects the exact release; fall back to the
// stable "latest" filename when the metadata hasn't loaded or lacks a mapping.
function getDownloadUrl(item: DownloadItem, downloads: Record<string, string>) {
  if (item.href) return item.href;
  if (!item.file) return '#';
  return `${DOWNLOAD_BASE}/${downloads[item.file] ?? item.file}`;
}

function getItemKey(item: DownloadItem) {
  return item.file ?? item.href ?? item.label;
}

function detectPlatform(userAgent: string): PlatformKey {
  if (/Android/u.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/u.test(userAgent)) return 'ios';
  if (/Windows/u.test(userAgent)) return 'win';
  if (/Linux/u.test(userAgent)) return 'linux';
  return 'mac';
}

function formatDate(value: string, locale: DownloadLocale) {
  try {
    return new Date(value).toLocaleDateString(SITE_LOCALE_META[locale].bcp47, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export function DownloadPage({ locale }: { locale: DownloadLocale }) {
  const t = copy[locale];
  const [version, setVersion] = useState('');
  const [releaseDate, setReleaseDate] = useState('');
  const [downloads, setDownloads] = useState<Record<string, string>>({});
  const [detected, setDetected] = useState<PlatformKey | ''>('');
  const [androidDownloadUrl, setAndroidDownloadUrl] = useState(
    MOBILE_ANDROID_FALLBACK_DOWNLOAD_URL
  );

  useEffect(() => {
    setDetected(detectPlatform(window.navigator.userAgent));

    async function loadReleaseMetadata() {
      try {
        const response = await fetch(`${DOWNLOAD_BASE}/version.json`);
        if (response.ok) {
          const metadata = parseVersionMetadata(await response.json());
          setVersion(metadata.version ?? '');
          setReleaseDate(metadata.releaseDate ?? '');
          if (metadata.downloads) setDownloads(metadata.downloads);
        }
      } catch {
        // Version metadata is optional; the download links remain valid without it.
      }

      try {
        const response = await fetch(`${MOBILE_ANDROID_DOWNLOAD_BASE}/version.json`);
        if (response.ok) {
          const metadata = parseAndroidReleaseMetadata(await response.json());
          const downloadUrl = metadata.versionDownloadUrl?.trim() || metadata.downloadUrl?.trim();
          if (downloadUrl) setAndroidDownloadUrl(downloadUrl);
        }
      } catch {
        // Keep the stable latest APK fallback when release metadata is unavailable.
      }
    }

    void loadReleaseMetadata();
  }, []);

  const platformGroups = useMemo<Platform[][]>(() => {
    const desktop: Platform[] = [
      {
        key: 'mac',
        name: 'macOS',
        description: t.platforms.mac,
        icon: Laptop,
        downloads: [
          { label: 'Apple Silicon', file: 'Lody-latest-arm64.dmg' },
          { label: 'Intel', file: 'Lody-latest-x64.dmg' },
        ],
      },
      {
        key: 'win',
        name: 'Windows',
        description: t.platforms.win,
        icon: MonitorDown,
        downloads: [{ label: 'Windows x64', file: 'Lody-latest-x64-setup.exe' }],
      },
      {
        key: 'linux',
        name: 'Linux',
        description: t.platforms.linux,
        icon: Laptop,
        downloads: [
          {
            label: 'AppImage · x86-64',
            file: downloads['Lody-latest-x64.AppImage']
              ? 'Lody-latest-x64.AppImage'
              : 'Lody-latest-x86_64.AppImage',
          },
          {
            label: 'Debian / Ubuntu · x86-64',
            file: downloads['Lody-latest-x64.deb']
              ? 'Lody-latest-x64.deb'
              : 'Lody-latest-amd64.deb',
          },
          ...[
            { label: 'AppImage · ARM64', file: 'Lody-latest-arm64.AppImage' },
            { label: 'Debian / Ubuntu · ARM64', file: 'Lody-latest-arm64.deb' },
          ].filter((item) => Boolean(downloads[item.file])),
        ],
      },
    ];

    const mobile: Platform[] = [
      {
        key: 'ios',
        name: 'iOS',
        description: t.platforms.ios,
        icon: Smartphone,
        downloads: [
          {
            label: 'App Store',
            href: t.appStoreHref,
            action: 'open',
            target: '_blank',
          },
        ],
      },
      {
        key: 'android',
        name: 'Android',
        description: t.platforms.android,
        icon: Smartphone,
        downloads: [
          {
            label: 'Google Play',
            href: GOOGLE_PLAY_HREF,
            action: 'open',
            target: '_blank',
          },
          {
            label: 'Android APK',
            href: androidDownloadUrl,
          },
        ],
      },
      {
        key: 'browser',
        name: t.browserName,
        description: t.platforms.browser,
        icon: Globe2,
        downloads: [
          {
            label: t.openApp,
            href: '/login',
            action: 'open',
            target: '_self',
          },
        ],
      },
    ];

    return [desktop, mobile];
  }, [androidDownloadUrl, downloads, t.appStoreHref, t.browserName, t.openApp, t.platforms]);

  const sectionTitles = [t.desktop, t.mobile];

  return (
    <main className="download-page marketing-shell">
      <SiteNav locale={locale} />

      <section className="download-hero">
        <div className="download-hero__glow" aria-hidden="true" />
        <div className="download-hero__content">
          <p className="download-eyebrow">
            <span className="download-eyebrow__dot" aria-hidden="true" />
            {t.eyebrow}
          </p>
          <h1>{t.title}</h1>
          <p className="download-subtitle">{t.subtitle}</p>
          {version || releaseDate ? (
            <div className="download-meta">
              {version ? (
                <span className="download-meta__version">
                  <b>v{version}</b>
                  <span className="download-meta__label">{t.versionPrefix}</span>
                </span>
              ) : null}
              {version && releaseDate ? (
                <span className="download-meta__dot" aria-hidden="true" />
              ) : null}
              {releaseDate ? (
                <span className="download-meta__date">
                  {t.datePrefix} {formatDate(releaseDate, locale)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="download-content">
        {platformGroups.map((group, index) => (
          <div className="download-group" key={sectionTitles[index]}>
            <h2>{sectionTitles[index]}</h2>
            <div className="download-grid">
              {group.map((platform) => (
                <article
                  className="download-card"
                  data-active={detected === platform.key}
                  key={platform.key}
                >
                  {detected === platform.key ? (
                    <span className="download-card__badge">{t.detected}</span>
                  ) : null}
                  <div className="download-card__header">
                    <platform.icon aria-hidden="true" />
                    <div>
                      <h3>{platform.name}</h3>
                      <p>{platform.description}</p>
                    </div>
                  </div>
                  <div className="download-card__actions">
                    {platform.downloads.map((item) => {
                      const isOpen = item.action === 'open';
                      const target = item.target ?? (isOpen ? '_blank' : undefined);
                      return (
                        <SiteAnchor
                          className="download-card__action"
                          href={getDownloadUrl(item, downloads)}
                          key={getItemKey(item)}
                          rel={target === '_blank' ? 'noreferrer' : undefined}
                          target={target}
                        >
                          <span>{item.label}</span>
                          {isOpen ? (
                            <ExternalLink aria-hidden="true" />
                          ) : (
                            <Download aria-hidden="true" />
                          )}
                        </SiteAnchor>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
