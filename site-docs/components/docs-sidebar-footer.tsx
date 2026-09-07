'use client';

/**
 * Docs sidebar bottom bar: Discord / X / GitHub + a single sliding theme toggle.
 *
 * Replaces fumadocs' default "icon links + dual sun/moon segment" footer.
 * Socials sit quietly on the left; theme control matches the site-nav toggle.
 */

import { useEffect, useState } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';

import { GITHUB_REPO_URL } from '@site/lib/github';

import { GithubMark } from './github-mark';

const DISCORD_HREF = 'https://discord.gg/E8mZtMu38s';
const X_HREF = 'https://x.com/lody_ai';

function DiscordIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      className="docs-sidebar-footer__theme-icon"
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
      className="docs-sidebar-footer__theme-icon"
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

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Before mount, assume dark (site default) to avoid a hydration flash.
  const isDark = !mounted || resolvedTheme === 'dark';

  return (
    <button
      type="button"
      className="docs-sidebar-footer__theme"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      data-theme={isDark ? 'dark' : 'light'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <span className="docs-sidebar-footer__theme-window">
        <span className="docs-sidebar-footer__theme-track">
          <SunIcon />
          <MoonIcon />
        </span>
      </span>
    </button>
  );
}

export function DocsSidebarFooter() {
  return (
    <div className="docs-sidebar-footer">
      <div className="docs-sidebar-footer__links" aria-label="Community">
        <a
          className="docs-sidebar-footer__link"
          href={DISCORD_HREF}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Discord"
          title="Discord"
        >
          <DiscordIcon />
        </a>
        <a
          className="docs-sidebar-footer__link"
          href={X_HREF}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="X"
          title="X"
        >
          <XIcon />
        </a>
        <a
          className="docs-sidebar-footer__link"
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          title="GitHub"
        >
          <GithubMark />
        </a>
      </div>
      <ThemeToggle />
    </div>
  );
}

export default DocsSidebarFooter;
