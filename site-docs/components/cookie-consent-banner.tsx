import { useEffect, useState } from 'react';
import { SiteAnchor } from './site-anchor';

export const COOKIE_CONSENT_STORAGE_KEY = 'lody:cookie-consent';
export const COOKIE_CONSENT_REGION_COOKIE = 'lody-consent-region';
export const OPEN_COOKIE_CONSENT_EVENT = 'lody:open-cookie-consent';

const EUROPE_CONSENT_COUNTRIES = new Set([
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
]);

const EUROPE_EXTRA_TIMEZONES = new Set([
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

function readRegionCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === COOKIE_CONSENT_REGION_COOKIE) {
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

export function requiresRegionalCookieConsent(): boolean {
  const cookieValue = readRegionCookie();
  if (cookieValue) {
    const normalized = cookieValue.toUpperCase();
    if (normalized === 'EEA' || normalized === 'EU' || normalized === 'EUROPE') return true;
    if (normalized === 'OTHER' || normalized === 'ROW' || normalized === 'NONE') return false;
    if (/^[A-Z]{2}$/.test(normalized)) return EUROPE_CONSENT_COUNTRIES.has(normalized);
  }
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (
      typeof timeZone === 'string' &&
      (timeZone.startsWith('Europe/') || EUROPE_EXTRA_TIMEZONES.has(timeZone))
    );
  } catch {
    return false;
  }
}

export type CookieConsentDecision = 'granted' | 'denied';

type GtagWindow = Window & {
  gtag?: (...args: unknown[]) => void;
};

export function readCookieConsent(): CookieConsentDecision | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function applyGoogleConsent(decision: CookieConsentDecision): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, decision);
  } catch {
    // Storage may be unavailable in restricted browsing modes; still update gtag for this page load.
  }
  const gtag = (window as GtagWindow).gtag;
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: decision,
    });
  }
}

const copy = {
  en: {
    ariaLabel: 'Cookie preferences',
    title: 'Cookie preferences',
    description:
      'We use essential storage for site functionality and optional analytics cookies to understand site traffic. Analytics cookies remain off unless you accept.',
    privacy: 'Privacy Policy',
    privacyHref: '/privacy',
    reject: 'Reject optional cookies',
    accept: 'Accept analytics cookies',
  },
  zh: {
    ariaLabel: 'Cookie 偏好设置',
    title: 'Cookie 偏好设置',
    description:
      '我们使用必要存储以保障网站运行，并在你同意后使用可选的网站分析 Cookie 统计访问情况。未经同意，分析类 Cookie 保持关闭。',
    privacy: '隐私政策',
    privacyHref: '/zh/privacy',
    reject: '仅使用必要 Cookie',
    accept: '接受分析 Cookie',
  },
} as const;

export function CookieConsentBanner({ locale }: { locale: 'en' | 'zh' }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readCookieConsent() === null && requiresRegionalCookieConsent());
    const open = () => setVisible(true);
    window.addEventListener(OPEN_COOKIE_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_COOKIE_CONSENT_EVENT, open);
  }, []);

  if (!visible) return null;
  const t = copy[locale];

  const decide = (decision: CookieConsentDecision) => {
    applyGoogleConsent(decision);
    setVisible(false);
  };

  return (
    <aside
      aria-label={t.ariaLabel}
      role="region"
      className="fixed right-4 bottom-4 left-4 z-50 rounded-xl border border-fd-border bg-fd-popover/95 p-4 text-fd-popover-foreground shadow-lg backdrop-blur sm:left-auto sm:w-full sm:max-w-[420px]"
    >
      <div className="flex flex-col gap-3">
        <div className="space-y-1 text-sm">
          <p className="font-medium text-fd-foreground">{t.title}</p>
          <p className="text-xs leading-relaxed text-fd-muted-foreground">
            {t.description}{' '}
            <SiteAnchor href={t.privacyHref} className="underline underline-offset-2">
              {t.privacy}
            </SiteAnchor>
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => decide('denied')}
            className="rounded-lg border border-fd-border bg-fd-secondary px-3 py-1.5 text-xs font-medium text-fd-secondary-foreground transition hover:opacity-90"
          >
            {t.reject}
          </button>
          <button
            type="button"
            onClick={() => decide('granted')}
            className="rounded-lg bg-fd-primary px-3 py-1.5 text-xs font-medium text-fd-primary-foreground transition hover:opacity-90"
          >
            {t.accept}
          </button>
        </div>
      </div>
    </aside>
  );
}
