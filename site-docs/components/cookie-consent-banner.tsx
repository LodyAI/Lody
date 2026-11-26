import { useEffect, useState } from 'react';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
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

type CookieConsentCopy = {
  ariaLabel: string;
  title: string;
  description: string;
  privacy: string;
  reject: string;
  accept: string;
};

const copy: Record<SiteLocale, CookieConsentCopy> = {
  en: {
    ariaLabel: 'Cookie preferences',
    title: 'Cookie preferences',
    description:
      'We use essential storage for site functionality and optional analytics cookies to understand site traffic. Analytics cookies remain off unless you accept.',
    privacy: 'Privacy Policy',
    reject: 'Reject optional cookies',
    accept: 'Accept analytics cookies',
  },
  zh: {
    ariaLabel: 'Cookie 偏好设置',
    title: 'Cookie 偏好设置',
    description:
      '我们使用必要存储以保障网站运行，并在你同意后使用可选的网站分析 Cookie 统计访问情况。未经同意，分析类 Cookie 保持关闭。',
    privacy: '隐私政策',
    reject: '仅使用必要 Cookie',
    accept: '接受分析 Cookie',
  },
  'zh-hant': {
    ariaLabel: 'Cookie 偏好設定',
    title: 'Cookie 偏好設定',
    description:
      '我們使用必要儲存空間以維持網站運作，並在您同意後使用選用的分析 Cookie 來了解網站流量。未經同意前，分析 Cookie 會保持關閉。',
    privacy: '隱私權政策',
    reject: '僅使用必要 Cookie',
    accept: '接受分析 Cookie',
  },
  ja: {
    ariaLabel: 'Cookie 設定',
    title: 'Cookie 設定',
    description:
      'サイトの機能維持に必要なストレージと、トラフィック把握のための任意のアナリティクス Cookie を使用しています。同意いただくまでアナリティクス Cookie は無効のままです。',
    privacy: 'プライバシーポリシー',
    reject: '任意の Cookie を拒否',
    accept: 'アナリティクス Cookie を許可',
  },
  ko: {
    ariaLabel: '쿠키 환경설정',
    title: '쿠키 환경설정',
    description:
      '사이트 기능을 위한 필수 저장소와 트래픽 분석을 위한 선택적 분석 쿠키를 사용합니다. 동의하기 전까지 분석 쿠키는 비활성 상태로 유지됩니다.',
    privacy: '개인정보처리방침',
    reject: '선택 쿠키 거부',
    accept: '분석 쿠키 허용',
  },
  es: {
    ariaLabel: 'Preferencias de cookies',
    title: 'Preferencias de cookies',
    description:
      'Usamos almacenamiento esencial para el funcionamiento del sitio y cookies de analítica opcionales para comprender el tráfico. Las cookies de analítica permanecen desactivadas salvo que las aceptes.',
    privacy: 'Política de privacidad',
    reject: 'Rechazar cookies opcionales',
    accept: 'Aceptar cookies de analítica',
  },
  fr: {
    ariaLabel: 'Préférences de cookies',
    title: 'Préférences de cookies',
    description:
      "Nous utilisons un stockage essentiel au fonctionnement du site ainsi que des cookies d'analyse facultatifs pour comprendre le trafic. Les cookies d'analyse restent désactivés sauf acceptation de votre part.",
    privacy: 'Politique de confidentialité',
    reject: 'Refuser les cookies facultatifs',
    accept: "Accepter les cookies d'analyse",
  },
  ru: {
    ariaLabel: 'Настройки cookie',
    title: 'Настройки cookie',
    description:
      'Мы используем обязательное хранилище для работы сайта и необязательные аналитические cookie для оценки посещаемости. Аналитические cookie отключены, пока вы их не примете.',
    privacy: 'Политика конфиденциальности',
    reject: 'Отклонить необязательные cookie',
    accept: 'Принять аналитические cookie',
  },
};

export function CookieConsentBanner({ locale }: { locale: SiteLocale }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readCookieConsent() === null && requiresRegionalCookieConsent());
    const open = () => setVisible(true);
    window.addEventListener(OPEN_COOKIE_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_COOKIE_CONSENT_EVENT, open);
  }, []);

  if (!visible) return null;
  const t = copy[locale];
  const privacyHref = localizeSitePath('/privacy', locale);

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
            <SiteAnchor href={privacyHref} className="underline underline-offset-2">
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
