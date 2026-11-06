import * as stylex from '@stylexjs/stylex';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
const previewStyles = stylex.create({
  row: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'padding-inline-start': 'calc(var(--spacing) * 2)',
    color: 'var(--color-fd-foreground)',
  },
  frame: {
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    'border-radius': 'var(--radius-md)',
  },
});

type Locale = 'en' | 'zh';

function docsNavTitle() {
  return (
    <span {...stylex.props(previewStyles.row)}>
      <img
        alt=""
        aria-hidden="true"
        {...stylex.props(previewStyles.frame)}
        decoding="async"
        fetchPriority="high"
        height={24}
        src="/_docs-assets/logo-96.png"
        width={24}
      />
      <span>Lody</span>
    </span>
  );
}

export function baseOptions(locale: Locale): BaseLayoutProps {
  const isZh = locale === 'zh';

  return {
    nav: {
      title: docsNavTitle(),
      url: isZh ? '/zh/home' : '/home',
    },
    // Social + theme live only in `DocsSidebarFooter` (sidebar.footer).
    // Empty links + disabled themeSwitch avoid fumadocs' dual sun/moon pill.
    links: [],
    searchToggle: { enabled: true },
    themeSwitch: {
      enabled: false,
    },
    slots: {
      languageSelect: false,
    },
    i18n: true,
  };
}
