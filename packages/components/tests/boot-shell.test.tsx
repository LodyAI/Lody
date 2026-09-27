// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootShell } from '../src/components/boot-shell';
import { BOOT_SHELL_COLORS, BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';
import { createBootShellScript } from '../src/lib/boot-shell-script';
import {
  createThemeCssVariables,
  DEFAULT_VSCODE_THEME_SELECTION,
  getBundledVSCodeThemeByIdSync,
} from '../src/lib/vscode-theme';
import {
  BOOT_SHELL_HEAD_MARKER,
  BOOT_SHELL_ROOT_MARKER,
  bootShellScriptCspSource,
  injectBootShell,
  moveStylesheetsAfterBootShell,
} from '../vite-boot-shell';

const html = document.documentElement;
let osPrefersDark = false;

function boot(
  url: string,
  storage: Record<string, string> = {},
  session: Record<string, string> = {}
) {
  window.history.replaceState(null, '', url);
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
  // Same evaluation as the inline `<script>` in `<head>`.
  runInThisContext(createBootShellScript());
  return {
    theme: html.classList.contains('dark')
      ? 'dark'
      : html.classList.contains('light')
        ? 'light'
        : null,
    sidebarWidth: html.hasAttribute('data-lody-boot-sidebar')
      ? html.style.getPropertyValue('--lody-boot-sidebar-width')
      : null,
  };
}

beforeEach(() => {
  osPrefersDark = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && osPrefersDark,
      media: query,
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  html.removeAttribute('class');
  html.removeAttribute('style');
  html.removeAttribute('data-lody-boot-sidebar');
  document.body.innerHTML = '';
});

describe('boot shell script', () => {
  it('resolves the theme ThemeProvider will apply', () => {
    expect(boot('/acme/chat', { 'vite-ui-theme': 'dark' }).theme).toBe('dark');
    html.removeAttribute('class');
    osPrefersDark = true;
    expect(boot('/acme/chat', { 'vite-ui-theme': 'light' }).theme).toBe('light');
    html.removeAttribute('class');
    localStorage.clear();
    expect(boot('/acme/chat').theme).toBe('dark');
    html.removeAttribute('class');
    osPrefersDark = false;
    expect(boot('/acme/chat', { 'vite-ui-theme': 'system' }).theme).toBe('light');
  });

  it.each([
    ['a workspace route', '/acme/chat', {}, {}, '280px'],
    ['a hash-history session route', '/index.html#/acme/sessions/s1', {}, {}, '280px'],
    ['the stored width', '/acme/chat', { 'lody-sidebar-last-width': '312' }, {}, '312px'],
    ['a width past the maximum', '/acme/chat', { 'lody-sidebar-last-width': '900' }, {}, '420px'],
    ['a collapsed sidebar', '/acme/chat', { 'lody-sidebar-collapsed': 'true' }, {}, null],
    ['settings, which has no sidebar', '/acme/settings/general', {}, {}, null],
    ['login', '/login', {}, {}, null],
    ['onboarding', '/index.html#/onboarding', {}, {}, null],
    [
      'the root after a workspace visit',
      '/',
      { 'lody:lastAppRoute': JSON.stringify({ version: 1, path: '/acme/chat', updatedAt: 1 }) },
      {},
      '280px',
    ],
    ['the root on a first visit', '/', {}, {}, null],
    ['a session window, collapsed by default', '/acme/sessions/s1?window=session', {}, {}, null],
    [
      'an auxiliary window, which keeps its own collapse state',
      '/acme/chat?window=workspace',
      { 'lody-sidebar-collapsed': 'true' },
      { 'lody-sidebar-collapsed': 'false' },
      '280px',
    ],
  ])('sidebar column for %s', (_label, url, storage, session, expected) => {
    expect(boot(url, storage, session).sidebarWidth).toBe(expected);
  });

  it('falls back to the mark alone when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(boot('/acme/chat')).toEqual({ theme: null, sidebarWidth: null });
    expect(html.style.getPropertyValue('--lody-boot-elapsed')).toMatch(/^\d+ms$/);
  });
});

describe('boot shell document', () => {
  const entry = `<html><head><meta charset="UTF-8" />${BOOT_SHELL_HEAD_MARKER}</head><body><div id="root">${BOOT_SHELL_ROOT_MARKER}</div><script type="module" src="/src/main.tsx"></script></body></html>`;

  it('inlines exactly the script the CSP hash allows', () => {
    const doc = new DOMParser().parseFromString(injectBootShell(entry), 'text/html');
    const script = doc.head.querySelector('script:not([src])')?.textContent ?? '';
    const digest = createHash('sha256').update(script).digest('base64');
    expect(`'sha256-${digest}'`).toBe(bootShellScriptCspSource());
    expect(doc.querySelector('#root > [data-lody-boot-shell]')).not.toBeNull();
  });

  it('leaves entries without markers alone and rejects half-marked ones', () => {
    const recovery = '<html><head></head><body><div id="root"></div></body></html>';
    expect(injectBootShell(recovery)).toBe(recovery);
    expect(() => injectBootShell(entry.replace(BOOT_SHELL_ROOT_MARKER, ''))).toThrow();
  });

  it('links the built stylesheet after the shell so it cannot delay the first paint', () => {
    const built = injectBootShell(entry).replace(
      '</head>',
      '<link rel="stylesheet" crossorigin href="./assets/index.css">\n</head>'
    );
    const doc = new DOMParser().parseFromString(moveStylesheetsAfterBootShell(built), 'text/html');
    expect(doc.head.querySelector('link[rel="stylesheet"]')).toBeNull();
    const link = doc.body.querySelector('link[rel="stylesheet"]');
    expect(link?.getAttribute('href')).toBe('./assets/index.css');
    expect(
      doc.querySelector('#root')!.compareDocumentPosition(link!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const plain = '<html><head><link rel="stylesheet" href="a.css"></head><body></body></html>';
    expect(moveStylesheetsAfterBootShell(plain)).toBe(plain);
  });

  it('renders the same frame from React as the static markup', () => {
    const staticShell = document.createElement('div');
    staticShell.innerHTML = BOOT_SHELL_MARKUP;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    flushSync(() => root.render(<BootShell />));

    const outline = (shell: Element) =>
      Array.from(shell.querySelectorAll('*'), (element) => element.getAttribute('class'));
    const reactShell = container.querySelector('[data-lody-boot-shell]')!;
    const htmlShell = staticShell.querySelector('[data-lody-boot-shell]')!;
    expect(outline(reactShell)).toEqual(outline(htmlShell));
    // React sets `src` last, so compare attributes rather than serialized order.
    const attributes = (element: Element) =>
      Object.fromEntries(Array.from(element.attributes, (a) => [a.name, a.value]));
    expect(attributes(reactShell.querySelector('img')!)).toEqual(
      attributes(htmlShell.querySelector('img')!)
    );
    root.unmount();
  });

  it('paints the colours the bundled themes resolve to', () => {
    const resolve = (id: string | undefined) => {
      const variables = createThemeCssVariables(getBundledVSCodeThemeByIdSync(id!)!) as Record<
        string,
        string
      >;
      return {
        canvas: variables['--background'],
        sidebar: variables['--sidebar-background'],
        sidebarBorder: variables['--sidebar-border'],
        status: variables['--muted-foreground'],
      };
    };
    expect(resolve(DEFAULT_VSCODE_THEME_SELECTION.lightThemeId)).toEqual(BOOT_SHELL_COLORS.light);
    expect(resolve(DEFAULT_VSCODE_THEME_SELECTION.darkThemeId)).toEqual(BOOT_SHELL_COLORS.dark);
  });
});
