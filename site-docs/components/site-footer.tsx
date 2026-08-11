/**
 * Shared site footer — same structure as the homepage underwater footer:
 * copyright + Loro credit, support / terms / privacy / X.
 * Product nav lives in SiteNav only.
 */

import { founderCallUrl } from '@site/lib/founder-call';

export type SiteFooterLocale = 'en' | 'zh';

const X_HREF = 'https://x.com/lody_ai';

const copy = {
  en: {
    rights: '© 2026 Lody',
    support: 'Support',
    supportHref: '/support',
    bookCall: 'Book a founder call',
    terms: 'Terms',
    termsHref: '/terms',
    privacy: 'Privacy',
    privacyHref: '/privacy',
  },
  zh: {
    rights: '© 2026 Lody',
    support: '支持',
    supportHref: '/zh/support',
    bookCall: '和创始人聊聊',
    terms: '条款',
    termsHref: '/zh/terms',
    privacy: '隐私',
    privacyHref: '/zh/privacy',
  },
} as const;

export function SiteFooter({ locale }: { locale: SiteFooterLocale }) {
  const t = copy[locale];

  return (
    <footer className="underwater-footer site-footer">
      <div className="underwater-footer__inner">
        <p className="underwater-footer__rights">
          {t.rights} · Powered by{' '}
          <a href="https://loro.dev" rel="noreferrer" target="_blank">
            Loro Stack
          </a>
        </p>
        <nav className="underwater-footer__links" aria-label="Footer">
          <a href={t.supportHref}>{t.support}</a>
          <a href={founderCallUrl('footer')} rel="noreferrer" target="_blank">
            {t.bookCall}
          </a>
          <a href={t.termsHref}>{t.terms}</a>
          <a href={t.privacyHref}>{t.privacy}</a>
          <a href={X_HREF} rel="noreferrer" target="_blank">
            X
          </a>
        </nav>
      </div>
    </footer>
  );
}

export default SiteFooter;
