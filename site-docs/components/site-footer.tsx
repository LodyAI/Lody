import { SiteAnchor } from '@site/components/site-anchor';
/**
 * Shared site footer — same structure as the homepage underwater footer:
 * copyright, support / terms / privacy / GitHub / X.
 * Primary product nav lives in SiteNav; English workflow guides are linked here.
 */

import { founderCallUrl } from '@site/lib/founder-call';
import { GITHUB_REPO_URL } from '@site/lib/github';

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
        <p className="underwater-footer__rights">{t.rights}</p>
        <nav className="underwater-footer__links" aria-label="Footer">
          {locale === 'en' && (
            <>
              <SiteAnchor href="/coding-agent-gui/">Agent GUI</SiteAnchor>
              <SiteAnchor href="/coding-agent-remote-control/">Remote control</SiteAnchor>
            </>
          )}
          <SiteAnchor href={t.supportHref}>{t.support}</SiteAnchor>
          <SiteAnchor href={founderCallUrl('footer')} rel="noreferrer" target="_blank">
            {t.bookCall}
          </SiteAnchor>
          <SiteAnchor href={t.termsHref}>{t.terms}</SiteAnchor>
          <SiteAnchor href={t.privacyHref}>{t.privacy}</SiteAnchor>
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
