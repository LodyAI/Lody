import * as stylex from '@stylexjs/stylex';
import { SiteAnchor } from '@site/components/site-anchor';
import { localeFromPathname, notFoundCopy, type NotFoundSeoLocale } from '@site/lib/not-found-seo';
import { useLocation } from '@tanstack/react-router';

const notFoundStyles = stylex.create({
  page: {
    display: 'flex',
    minHeight: '100vh',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 4)',
    paddingInline: 'calc(var(--spacing) * 6)',
    textAlign: 'center',
  },
  status: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    textTransform: 'uppercase',
    letterSpacing: '.22em',
    color: 'var(--color-fd-muted-foreground)',
  },
  heading: {
    fontSize: 'var(--text-3xl)',
    lineHeight: 'var(--text-3xl--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  description: {
    maxWidth: 'var(--container-md)',
    color: 'var(--color-fd-muted-foreground)',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 'calc(var(--spacing) * 4)',
    rowGap: 'calc(var(--spacing) * 2)',
  },
  link: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'var(--color-fd-primary)',
    textDecorationLine: {
      default: null,
      '@media (hover: hover)': { ':hover': 'underline' },
    },
  },
});

/**
 * Lives in its own module because `src/routes/__root.tsx` wires it as the global
 * `notFoundComponent`. The root route is on EVERY page, so anything it imports is
 * in the common chunk — when this sat in the old `src/site-pages.tsx` barrel it
 * dragged the docs layout, blog, changelog and pricing pages onto the landing.
 */
export function SiteNotFound() {
  return <NotFoundPage />;
}

export function NotFoundPage({ locale }: { locale?: NotFoundSeoLocale }) {
  const location = useLocation();
  const resolved = locale ?? localeFromPathname(location.pathname);
  const copy = notFoundCopy[resolved];

  return (
    <main {...stylex.props(notFoundStyles.page)}>
      <p {...stylex.props(notFoundStyles.status)}>404</p>
      <h1 {...stylex.props(notFoundStyles.heading)}>{copy.heading}</h1>
      <p {...stylex.props(notFoundStyles.description)}>{copy.description}</p>
      <p {...stylex.props(notFoundStyles.actions)}>
        <SiteAnchor {...stylex.props(notFoundStyles.link)} href={copy.homeHref}>
          {copy.home}
        </SiteAnchor>
        <SiteAnchor {...stylex.props(notFoundStyles.link)} href={copy.docsHref}>
          {copy.docs}
        </SiteAnchor>
      </p>
    </main>
  );
}
