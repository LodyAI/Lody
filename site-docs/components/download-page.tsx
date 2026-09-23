'use client';

import { Download, ExternalLink, Globe2, Laptop, MonitorDown, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';

type DownloadLocale = 'en' | 'zh';
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
const APP_STORE_HREF_EN =
  'https://apps.apple.com/us/app/lody-run-code-agent-anywhere/id6761373528';
const APP_STORE_HREF_ZH =
  'https://apps.apple.com/cn/app/lody-%E9%9A%8F%E6%97%B6%E9%9A%8F%E5%9C%B0%E8%BF%90%E8%A1%8C-code-agent/id6761373528';
const GOOGLE_PLAY_HREF = 'https://play.google.com/store/apps/details?id=ai.lody.android';

const copy = {
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
    platforms: {
      mac: '适用于 macOS 的桌面应用，提供 Apple Silicon 和 Intel 构建。',
      win: '适用于 x64 Windows 机器的签名安装包。',
      linux: '适用于 AppImage 与 Debian/Ubuntu 环境的 Linux 构建。',
      ios: '在 App Store 安装 Lody。',
      android: '从 Google Play 安装，或下载签名 APK。',
      browser: '在浏览器中打开托管版 Web 应用。',
    },
  },
} satisfies Record<DownloadLocale, Record<string, unknown>>;

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
    return new Date(value).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: locale === 'zh' ? 'long' : 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export function DownloadPage({ locale }: { locale: DownloadLocale }) {
  const t = copy[locale];
  const isZh = locale === 'zh';
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
          { label: 'AppImage', file: 'Lody-latest-x86_64.AppImage' },
          { label: 'Debian / Ubuntu', file: 'Lody-latest-amd64.deb' },
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
            href: isZh ? APP_STORE_HREF_ZH : APP_STORE_HREF_EN,
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
        name: isZh ? '浏览器' : 'Browser',
        description: t.platforms.browser,
        icon: Globe2,
        downloads: [
          {
            label: isZh ? '打开应用' : 'Open app',
            href: '/login',
            action: 'open',
            target: '_self',
          },
        ],
      },
    ];

    return [desktop, mobile];
  }, [androidDownloadUrl, isZh, t.platforms]);

  const sectionTitles = [t.desktop, t.mobile];
  const languageHref = isZh ? '/download' : '/zh/download';

  return (
    <main className="download-page marketing-shell">
      <SiteNav locale={locale} languageHref={languageHref} />

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
                        <a
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
                        </a>
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
