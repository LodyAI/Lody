import type { SiteLocale } from '../src/site-pages/shared';
import { isAppOwnedHref, SITE_URL } from './site-url.mjs';

const PREFIXED_SITE_LOCALES = ['zh-hant', 'zh', 'ja', 'ko', 'es', 'fr', 'ru'] as const;

function detectSiteLocaleFromPath(pathname: string): SiteLocale {
  for (const locale of PREFIXED_SITE_LOCALES) {
    const prefix = `/${locale}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return locale;
  }
  return 'en';
}

/**
 * ISO 3166-1 alpha-2 codes where GDPR / ePrivacy requires prior consent for
 * optional analytics cookies: 27 EU member states + 3 EEA EFTA states (IS, LI,
 * NO) + UK (GB) + Switzerland (CH). All other regions default to
 * `analytics_storage: 'granted'`.
 */
export const EUROPE_CONSENT_REGIONS = [
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

const EUROPE_CONSENT_COUNTRY_SET = new Set<string>(EUROPE_CONSENT_REGIONS);

const EUROPE_EXTRA_TIMEZONES = new Set<string>([
  'Arctic/Longyearbyen',
  'Asia/Nicosia',
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Atlantic/Faeroe',
  'Atlantic/Faroe',
  'Atlantic/Madeira',
  'Atlantic/Reykjavik',
  'CET',
  'EET',
  'Eire',
  'GB',
  'GB-Eire',
  'Iceland',
  'MET',
  'Poland',
  'Portugal',
  'WET',
]);

/**
 * Geographic `Europe/*` IANA zones outside EEA, the UK, and Switzerland (e.g.
 * Russia, Turkey, Ukraine, Belarus, Serbia) where `EUROPE_CONSENT_REGIONS`
 * already defaults `analytics_storage` to `'granted'`.
 */
const NON_EEA_EUROPE_TIMEZONES = new Set<string>([
  'Europe/Astrakhan',
  'Europe/Belgrade',
  'Europe/Chisinau',
  'Europe/Istanbul',
  'Europe/Kaliningrad',
  'Europe/Kiev',
  'Europe/Kirov',
  'Europe/Kyiv',
  'Europe/Minsk',
  'Europe/Moscow',
  'Europe/Podgorica',
  'Europe/Samara',
  'Europe/Saratov',
  'Europe/Sarajevo',
  'Europe/Simferopol',
  'Europe/Skopje',
  'Europe/Tirane',
  'Europe/Tiraspol',
  'Europe/Ulyanovsk',
  'Europe/Uzhgorod',
  'Europe/Volgograd',
  'Europe/Zaporozhye',
]);

export const COOKIE_CONSENT_REGION_COOKIE = 'lody-consent-region';

function parseCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === cookieName) {
      const rawValue = rest.join('=').trim();
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return null;
}

export function requiresRegionalCookieConsentFromEnv(input: {
  cookieHeader?: string;
  timeZone?: string;
}): boolean {
  const cookieValue = parseCookieValue(input.cookieHeader, COOKIE_CONSENT_REGION_COOKIE);
  if (cookieValue) {
    const normalized = cookieValue.trim().toUpperCase();
    if (normalized === 'EEA' || normalized === 'EU' || normalized === 'EUROPE') return true;
    if (normalized === 'OTHER' || normalized === 'ROW' || normalized === 'NONE') return false;
    if (/^[A-Z]{2}$/u.test(normalized)) return EUROPE_CONSENT_COUNTRY_SET.has(normalized);
  }
  const tz = input.timeZone?.trim();
  if (!tz) return false;
  if (EUROPE_EXTRA_TIMEZONES.has(tz)) return true;
  if (tz.startsWith('Europe/')) return !NON_EEA_EUROPE_TIMEZONES.has(tz);
  return false;
}

export type TrafficChannel =
  | 'organic_search'
  | 'paid_search'
  | 'ai_referral'
  | 'utm'
  | 'referral'
  | 'direct';

export type LandingAttribution = {
  entry_page: string;
  entry_locale: SiteLocale;
  traffic_channel: TrafficChannel;
  referrer_host: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

const SEARCH_ENGINE_HOST_PATTERNS: readonly RegExp[] = [
  /(?:^|\.)google\.[a-z.]{2,6}$/iu,
  /(?:^|\.)bing\.com$/iu,
  /(?:^|\.)duckduckgo\.com$/iu,
  /(?:^|\.)baidu\.com$/iu,
  /(?:^|\.)yandex\.[a-z.]{2,6}$/iu,
  /(?:^|\.)yahoo\.[a-z.]{2,6}$/iu,
  /(?:^|\.)naver\.com$/iu,
  /(?:^|\.)ecosia\.org$/iu,
  /(?:^|\.)qwant\.com$/iu,
  /^search\.brave\.com$/iu,
  /(?:^|\.)sogou\.com$/iu,
  /(?:^|\.)so\.com$/iu,
  /(?:^|\.)seznam\.cz$/iu,
];

const AI_ENGINE_HOST_PATTERNS: readonly RegExp[] = [
  /(?:^|\.)chatgpt\.com$/iu,
  /^chat\.openai\.com$/iu,
  /(?:^|\.)perplexity\.ai$/iu,
  /(?:^|\.)claude\.ai$/iu,
  /^gemini\.google\.com$/iu,
  /^copilot\.microsoft\.com$/iu,
  /(?:^|\.)you\.com$/iu,
  /(?:^|\.)phind\.com$/iu,
  /^kimi\.moonshot\.cn$/iu,
  /^chat\.deepseek\.com$/iu,
  /(?:^|\.)doubao\.com$/iu,
];

function isSameSiteHost(hostname: string, currentHost: string): boolean {
  const h = hostname.toLowerCase();
  const c = currentHost.toLowerCase();
  return (
    h === c || h === 'lody.ai' || h === 'www.lody.ai' || h === 'localhost' || h === '127.0.0.1'
  );
}

export function normalizeDirectoryPagePath(pathname: string): string {
  const clean = pathname.replace(/\/+$/u, '');
  if (!clean || clean === '/') return '/';
  return `${clean}/`;
}

function sanitizeCampaignParam(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 64);
  return /^[a-zA-Z0-9._:/ -]+$/u.test(trimmed) ? trimmed : undefined;
}

export function deriveLandingAttribution(input: {
  href: string;
  referrer?: string;
}): LandingAttribution {
  let url: URL;
  try {
    url = new URL(input.href, SITE_URL);
  } catch {
    url = new URL(SITE_URL);
  }

  const entryPage = normalizeDirectoryPagePath(url.pathname);
  const entryLocale = detectSiteLocaleFromPath(url.pathname);
  const utmSource = sanitizeCampaignParam(url.searchParams.get('utm_source'));
  const utmMedium = sanitizeCampaignParam(url.searchParams.get('utm_medium'));
  const utmCampaign = sanitizeCampaignParam(url.searchParams.get('utm_campaign'));
  const hasClickId = url.searchParams.has('gclid') || url.searchParams.has('msclkid');

  let referrerHost = '(none)';
  if (input.referrer) {
    try {
      const refUrl = new URL(input.referrer);
      if (refUrl.hostname && !isSameSiteHost(refUrl.hostname, url.hostname)) {
        referrerHost = refUrl.hostname.toLowerCase();
      }
    } catch {
      // Ignore malformed referrer strings.
    }
  }

  let trafficChannel: TrafficChannel = 'direct';
  if (hasClickId || (utmMedium && /^(cpc|ppc|paid|paid[-_]?search|sem)$/iu.test(utmMedium))) {
    trafficChannel = 'paid_search';
  } else if (utmSource || utmMedium || utmCampaign) {
    trafficChannel = 'utm';
  } else if (referrerHost !== '(none)') {
    if (AI_ENGINE_HOST_PATTERNS.some((pattern) => pattern.test(referrerHost))) {
      trafficChannel = 'ai_referral';
    } else if (SEARCH_ENGINE_HOST_PATTERNS.some((pattern) => pattern.test(referrerHost))) {
      trafficChannel = 'organic_search';
    } else {
      trafficChannel = 'referral';
    }
  }

  return {
    entry_page: entryPage,
    entry_locale: entryLocale,
    traffic_channel: trafficChannel,
    referrer_host: referrerHost,
    ...(utmSource ? { utm_source: utmSource } : {}),
    ...(utmMedium ? { utm_medium: utmMedium } : {}),
    ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
  };
}

export type ConversionAction =
  | {
      event: 'download_installer';
      platform: 'mac' | 'win' | 'linux' | 'ios' | 'android';
      arch: 'arm64' | 'x64' | 'universal';
      installer_format: 'dmg' | 'exe' | 'appimage' | 'deb' | 'apk' | 'app_store' | 'google_play';
      release_channel: 'stable' | 'nightly';
    }
  | {
      event: 'open_web_app';
      destination: '/login';
    }
  | {
      event: 'book_founder_call';
      booking_source: string;
    }
  | {
      event: 'copy_install_command';
      install_method: 'npx_lody' | 'homebrew';
    };

export function classifyConversionHref(
  href: string | null | undefined,
  options?: { baseOrigin?: string; nightlyBaseUrl?: string }
): ConversionAction | null {
  if (!href) return null;

  if (isAppOwnedHref(href)) {
    return {
      event: 'open_web_app',
      destination: '/login',
    };
  }

  let url: URL;
  try {
    url = new URL(href, options?.baseOrigin ?? SITE_URL);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;

  if (host === 'apps.apple.com' && pathname.includes('id6761373528')) {
    return {
      event: 'download_installer',
      platform: 'ios',
      arch: 'universal',
      installer_format: 'app_store',
      release_channel: 'stable',
    };
  }

  if (host === 'play.google.com' && url.searchParams.get('id') === 'ai.lody.android') {
    return {
      event: 'download_installer',
      platform: 'android',
      arch: 'universal',
      installer_format: 'google_play',
      release_channel: 'stable',
    };
  }

  if (host === 'calendar.notion.so' && pathname.startsWith('/meet/remch183/')) {
    const rawSource = sanitizeCampaignParam(url.searchParams.get('utm_source')) ?? 'site';
    return {
      event: 'book_founder_call',
      booking_source: rawSource,
    };
  }

  const normalizedNightlyBase = options?.nightlyBaseUrl?.trim().replace(/\/+$/u, '');
  const fullWithoutQuery = `${url.origin}${pathname}`;
  const isConfiguredNightly = Boolean(
    normalizedNightlyBase && fullWithoutQuery.startsWith(`${normalizedNightlyBase}/`)
  );
  const isUpdatesHost = host === 'updates.lody.ai';

  if (!isUpdatesHost && !isConfiguredNightly) {
    return null;
  }

  const filename = pathname.split('/').pop() ?? '';
  const lowerFile = filename.toLowerCase();
  const releaseChannel: 'stable' | 'nightly' =
    isConfiguredNightly || pathname.includes('/nightly/') || lowerFile.includes('nightly')
      ? 'nightly'
      : 'stable';

  const detectArch = (fallback: 'arm64' | 'x64' | 'universal'): 'arm64' | 'x64' | 'universal' => {
    if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/iu.test(lowerFile)) return 'arm64';
    if (/(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/iu.test(lowerFile)) return 'x64';
    return fallback;
  };

  if (lowerFile.endsWith('.dmg')) {
    return {
      event: 'download_installer',
      platform: 'mac',
      arch: detectArch('arm64'),
      installer_format: 'dmg',
      release_channel: releaseChannel,
    };
  }

  if (lowerFile.endsWith('.exe')) {
    return {
      event: 'download_installer',
      platform: 'win',
      arch: detectArch('x64'),
      installer_format: 'exe',
      release_channel: releaseChannel,
    };
  }

  if (lowerFile.endsWith('.appimage')) {
    return {
      event: 'download_installer',
      platform: 'linux',
      arch: detectArch('x64'),
      installer_format: 'appimage',
      release_channel: releaseChannel,
    };
  }

  if (lowerFile.endsWith('.deb')) {
    return {
      event: 'download_installer',
      platform: 'linux',
      arch: detectArch('x64'),
      installer_format: 'deb',
      release_channel: releaseChannel,
    };
  }

  if (lowerFile.endsWith('.apk')) {
    return {
      event: 'download_installer',
      platform: 'android',
      arch: 'universal',
      installer_format: 'apk',
      release_channel: releaseChannel,
    };
  }

  return null;
}

export function classifyInstallCommand(
  text: string | null | undefined
): Extract<ConversionAction, { event: 'copy_install_command' }> | null {
  if (!text) return null;
  if (/\bbrew\s+install\s+--cask\s+lody\b/u.test(text)) {
    return { event: 'copy_install_command', install_method: 'homebrew' };
  }
  if (/\bnpx\s+lody(?:\s|$)/u.test(text)) {
    return { event: 'copy_install_command', install_method: 'npx_lody' };
  }
  return null;
}

export type CtaSurface =
  | 'landing_hero'
  | 'landing_cta'
  | 'landing_cli'
  | 'pricing_card'
  | 'nightly_card'
  | 'download_card'
  | 'footer'
  | 'nav'
  | 'docs_body'
  | 'blog_body'
  | 'page_body';

export function resolveCtaSurface(element: Element | null): CtaSurface {
  if (!element || typeof element.closest !== 'function') return 'page_body';
  if (element.closest('.underwater-hero')) return 'landing_hero';
  if (element.closest('.uw-cta')) return 'landing_cta';
  if (element.closest('.uw-cli')) return 'landing_cli';
  if (element.closest('.pricing-card')) return 'pricing_card';
  if (element.closest('.download-nightly')) return 'nightly_card';
  if (element.closest('.download-card')) return 'download_card';
  if (element.closest('.site-footer')) return 'footer';
  if (element.closest('.site-nav')) return 'nav';
  if (element.closest('#nd-page')) return 'docs_body';
  if (element.closest('.blog-prose, article')) return 'blog_body';
  return 'page_body';
}

type GtagWindow = Window & {
  gtag?: (...args: unknown[]) => void;
};

let cachedEntryAttribution: LandingAttribution | null = null;

export function captureEntryLandingAttribution(): LandingAttribution | null {
  if (typeof window === 'undefined') return null;
  if (!cachedEntryAttribution) {
    cachedEntryAttribution = deriveLandingAttribution({
      href: window.location.href,
      referrer: document.referrer,
    });
  }
  return cachedEntryAttribution;
}

export function emitSiteConversionEvent(
  action: ConversionAction,
  context: {
    currentPathname: string;
    surface: CtaSurface;
  }
): void {
  if (typeof window === 'undefined') return;
  const gtag = (window as GtagWindow).gtag;
  if (typeof gtag !== 'function') return;

  const entry = captureEntryLandingAttribution();
  const { event, ...actionDetails } = action;
  gtag('event', event, {
    ...(entry ?? {}),
    ...actionDetails,
    source_page: normalizeDirectoryPagePath(context.currentPathname),
    locale: detectSiteLocaleFromPath(context.currentPathname),
    cta_surface: context.surface,
    transport_type: 'beacon',
  });
}

export function installSiteAnalyticsListeners(options?: { nightlyBaseUrl?: string }): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  captureEntryLandingAttribution();

  const handleLinkEvent = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && event.button !== 1) return;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const anchor = target.closest('a[href]');
    if (anchor) {
      const conversion = classifyConversionHref(anchor.getAttribute('href'), {
        baseOrigin: window.location.origin,
        nightlyBaseUrl: options?.nightlyBaseUrl,
      });
      if (conversion) {
        emitSiteConversionEvent(conversion, {
          currentPathname: window.location.pathname,
          surface: resolveCtaSurface(anchor),
        });
      }
      return;
    }

    if (event.type === 'click') {
      const copyButton = target.closest('button');
      if (copyButton) {
        const label = (copyButton.getAttribute('aria-label') ?? '').toLowerCase();
        const codeContainer = copyButton.closest('figure, .nd-codeblock');
        if (codeContainer && (label.includes('copy') || copyButton.querySelector('svg'))) {
          const codeText = codeContainer.querySelector('pre code, pre')?.textContent ?? '';
          const cmdAction = classifyInstallCommand(codeText);
          if (cmdAction) {
            emitSiteConversionEvent(cmdAction, {
              currentPathname: window.location.pathname,
              surface: resolveCtaSurface(copyButton),
            });
          }
        }
      }
    }
  };

  const handleCopy = () => {
    const selectionText = window.getSelection?.()?.toString() ?? '';
    const cmdAction = classifyInstallCommand(selectionText);
    if (!cmdAction) return;
    const anchorNode = window.getSelection?.()?.anchorNode ?? null;
    const anchorElement =
      anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
    emitSiteConversionEvent(cmdAction, {
      currentPathname: window.location.pathname,
      surface: resolveCtaSurface(anchorElement),
    });
  };

  document.addEventListener('click', handleLinkEvent, { capture: true });
  document.addEventListener('auxclick', handleLinkEvent, { capture: true });
  document.addEventListener('copy', handleCopy, { capture: true });

  return () => {
    document.removeEventListener('click', handleLinkEvent, { capture: true });
    document.removeEventListener('auxclick', handleLinkEvent, { capture: true });
    document.removeEventListener('copy', handleCopy, { capture: true });
  };
}
