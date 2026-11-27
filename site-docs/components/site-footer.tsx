import { OPEN_COOKIE_CONSENT_EVENT } from '@site/components/cookie-consent-banner';
import { SiteAnchor } from '@site/components/site-anchor';
/**
 * Shared site footer — same structure as the homepage underwater footer:
 * copyright, support / terms / privacy / GitHub / X.
 * Product nav lives in SiteNav only.
 */

import { founderCallUrl } from '@site/lib/founder-call';
import { GITHUB_REPO_URL } from '@site/lib/github';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';

export type SiteFooterLocale = SiteLocale;

const X_HREF = 'https://x.com/lody_ai';

type SiteFooterCopy = {
  rights: string;
  footerNav: string;
  support: string;
  bookCall: string;
  terms: string;
  privacy: string;
  cookies: string;
};

const copy: Record<SiteLocale, SiteFooterCopy> = {
  en: {
    rights: '© 2026 Lody',
    footerNav: 'Footer',
    support: 'Support',
    bookCall: 'Book a founder call',
    terms: 'Terms',
    privacy: 'Privacy',
    cookies: 'Cookie settings',
  },
  zh: {
    rights: '© 2026 Lody',
    footerNav: '页脚',
    support: '支持',
    bookCall: '和创始人聊聊',
    terms: '条款',
    privacy: '隐私',
    cookies: 'Cookie 设置',
  },
  'zh-hant': {
    rights: '© 2026 Lody',
    footerNav: '頁尾',
    support: '支援',
    bookCall: '與創辦人聊聊',
    terms: '條款',
    privacy: '隱私',
    cookies: 'Cookie 設定',
  },
  ja: {
    rights: '© 2026 Lody',
    footerNav: 'フッター',
    support: 'サポート',
    bookCall: '創業者と話す',
    terms: '利用規約',
    privacy: 'プライバシー',
    cookies: 'Cookie 設定',
  },
  ko: {
    rights: '© 2026 Lody',
    footerNav: '푸터',
    support: '지원',
    bookCall: '창업자와 통화 예약',
    terms: '이용약관',
    privacy: '개인정보처리방침',
    cookies: '쿠키 설정',
  },
  es: {
    rights: '© 2026 Lody',
    footerNav: 'Pie de página',
    support: 'Soporte',
    bookCall: 'Hablar con un fundador',
    terms: 'Términos',
    privacy: 'Privacidad',
    cookies: 'Configuración de cookies',
  },
  fr: {
    rights: '© 2026 Lody',
    footerNav: 'Pied de page',
    support: 'Assistance',
    bookCall: 'Échanger avec un fondateur',
    terms: 'Conditions',
    privacy: 'Confidentialité',
    cookies: 'Paramètres des cookies',
  },
  ru: {
    rights: '© 2026 Lody',
    footerNav: 'Нижняя навигация',
    support: 'Поддержка',
    bookCall: 'Созвониться с основателем',
    terms: 'Условия',
    privacy: 'Конфиденциальность',
    cookies: 'Настройки cookie',
  },
};

export function SiteFooter({ locale }: { locale: SiteFooterLocale }) {
  const t = copy[locale];

  return (
    <footer className="underwater-footer site-footer">
      <div className="underwater-footer__inner">
        <p className="underwater-footer__rights">{t.rights}</p>
        <nav className="underwater-footer__links" aria-label={t.footerNav}>
          <SiteAnchor href={localizeSitePath('/support', locale)}>{t.support}</SiteAnchor>
          <SiteAnchor href={founderCallUrl('footer')} rel="noreferrer" target="_blank">
            {t.bookCall}
          </SiteAnchor>
          <SiteAnchor href={localizeSitePath('/terms', locale)}>{t.terms}</SiteAnchor>
          <SiteAnchor href={localizeSitePath('/privacy', locale)}>{t.privacy}</SiteAnchor>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_CONSENT_EVENT))}
            className="cursor-pointer bg-transparent p-0 text-inherit hover:underline"
          >
            {t.cookies}
          </button>
          <SiteAnchor href={GITHUB_REPO_URL} rel="noreferrer" target="_blank">
            GitHub
          </SiteAnchor>
          <SiteAnchor href={X_HREF} rel="noreferrer" target="_blank">
            X
          </SiteAnchor>
        </nav>
      </div>
    </footer>
  );
}

export default SiteFooter;
