import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

function docsNavTitle() {
  return (
    <span className="inline-flex items-center gap-2 ps-2 text-fd-foreground">
      <img
        alt=""
        aria-hidden="true"
        className="size-6 rounded-md"
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

export function baseOptions(locale: SiteLocale): BaseLayoutProps {
  return {
    nav: {
      title: docsNavTitle(),
      url: localizeSitePath('/', locale),
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
