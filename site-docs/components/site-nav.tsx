'use client';

import { useNavigate } from '@tanstack/react-router';
import { useTheme } from 'fumadocs-ui/provider/base';
import { type MouseEvent, useCallback, useEffect, useId, useState } from 'react';

type SiteNavLocale = 'en' | 'zh';

type SiteNavProps = {
  locale: SiteNavLocale;
  languageHref: string;
};

const DISCORD_HREF = 'https://discord.gg/E8mZtMu38s';

const copy = {
  en: {
    language: '简体中文',
    docs: 'Docs',
    blog: 'Blog',
    pricing: 'Pricing',
    changelog: 'Changelog',
    download: 'Download',
    menu: 'Menu',
    homeHref: '/home',
    docsHref: '/docs',
    blogHref: '/blog',
    pricingHref: '/price',
    changelogHref: '/changelog',
    downloadHref: '/download',
  },
  zh: {
    language: 'English',
    docs: '文档',
    blog: '博客',
    pricing: '价格',
    changelog: '更新日志',
    download: '下载',
    menu: '菜单',
    homeHref: '/zh/home',
    docsHref: '/zh/docs',
    blogHref: '/zh/blog',
    pricingHref: '/zh/price',
    changelogHref: '/zh/changelog',
    downloadHref: '/zh/download',
  },
} as const;

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  );
}

// Official Discord brand mark (simple-icons). Lucide dropped brand glyphs, so we
// inline the path and fill with currentColor to inherit the nav link color.
function DiscordIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      className="site-nav__theme-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      className="site-nav__theme-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

// Single-icon theme toggle. The two icons are stacked in a clipped window and
// the track slides vertically on click, so toggling scrolls the new icon in.
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Before mount, assume the site default (dark) to avoid a hydration flash.
  const isDark = !mounted || resolvedTheme === 'dark';
  return (
    <button
      aria-label="Toggle color theme"
      className="site-nav__theme-toggle"
      data-theme={isDark ? 'dark' : 'light'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      type="button"
    >
      <span className="site-nav__theme-window">
        <span className="site-nav__theme-track">
          <SunIcon />
          <MoonIcon />
        </span>
      </span>
    </button>
  );
}

/**
 * Route these links through the router instead of letting the browser do a full
 * document load. Beyond being faster, it is what keeps the shared WebGL field in
 * `MarketingAtmosphereHost` alive across price ↔ download ↔ changelog: a document
 * navigation tears down the GL context and the canvas has to fade back in from the
 * CSS gradient, which reads as the background blinking dark on every switch.
 *
 * The `href` stays on the anchor so middle-click, cmd-click, "copy link" and
 * crawlers all behave normally; only an unmodified primary click is intercepted.
 */
function useRouteLink() {
  const navigate = useNavigate();
  return useCallback(
    (href: string, onNavigate?: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate?.();
      // `as never` matches site-root-provider: these paths are real routes, but the
      // typed router cannot narrow a value computed from the locale table.
      void navigate({ to: href as never });
    },
    [navigate]
  );
}

export function SiteNav({ locale, languageHref }: SiteNavProps) {
  const t = copy[locale];
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const routeLink = useRouteLink();

  const navItems = [
    { label: t.docs, href: t.docsHref },
    { label: t.blog, href: t.blogHref },
    { label: t.pricing, href: t.pricingHref },
    { label: t.changelog, href: t.changelogHref },
    { label: t.download, href: t.downloadHref },
  ];

  // Close the mobile menu on Escape, on a jump to desktop width, and lock body scroll
  // while it is open so the backdrop doesn't scroll the page behind it.
  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const desktop = window.matchMedia('(min-width: 769px)');
    const onDesktop = () => {
      if (desktop.matches) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    desktop.addEventListener('change', onDesktop);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      desktop.removeEventListener('change', onDesktop);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <header className="site-nav" data-open={open}>
        <div className="site-nav__inner">
          <a className="site-nav__brand" href={t.homeHref} onClick={routeLink(t.homeHref)}>
            <img
              alt="Lody"
              decoding="async"
              fetchPriority="high"
              height={24}
              src="/_docs-assets/logo-96.png"
              width={24}
            />
            <span>Lody</span>
          </a>
          <div className="site-nav__right">
            <nav aria-label="Primary" className="site-nav__links">
              {navItems.map((item) => (
                <a
                  className="site-nav__link"
                  href={item.href}
                  key={item.href}
                  onClick={routeLink(item.href)}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="site-nav__actions">
              <ThemeToggle />
              <a
                className="site-nav__link site-nav__desktop"
                href={languageHref}
                onClick={routeLink(languageHref)}
              >
                {t.language}
              </a>
              <span aria-hidden="true" className="site-nav__divider site-nav__desktop" />
              <a
                aria-label="Discord"
                className="site-nav__link site-nav__social site-nav__desktop"
                href={DISCORD_HREF}
                rel="noreferrer"
                target="_blank"
              >
                <DiscordIcon />
              </a>
              <button
                aria-controls={menuId}
                aria-expanded={open}
                aria-label={t.menu}
                className="site-nav__toggle"
                onClick={() => setOpen((value) => !value)}
                type="button"
              >
                {open ? <CloseIcon /> : <MenuIcon />}
              </button>
            </div>
          </div>
        </div>

        <div className="site-nav__menu" data-open={open} id={menuId}>
          <nav aria-label="Primary mobile" className="site-nav__menu-links">
            {navItems.map((item) => (
              <a
                className="site-nav__menu-link"
                href={item.href}
                key={item.href}
                onClick={routeLink(item.href, () => setOpen(false))}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="site-nav__menu-footer">
            <a
              className="site-nav__menu-secondary"
              href={languageHref}
              onClick={routeLink(languageHref, () => setOpen(false))}
            >
              {t.language}
            </a>
            <a
              aria-label="Discord"
              className="site-nav__menu-secondary site-nav__menu-social"
              href={DISCORD_HREF}
              rel="noreferrer"
              target="_blank"
            >
              <DiscordIcon />
            </a>
          </div>
        </div>
      </header>

      {/* Outside the header so blur/scrim stacks cleanly under the sheet. */}
      <button
        aria-hidden="true"
        className="site-nav__backdrop"
        data-open={open}
        onClick={() => setOpen(false)}
        tabIndex={-1}
        type="button"
      />
    </>
  );
}
