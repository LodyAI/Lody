// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { act, Component, StrictMode, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootShell, BootShellProvider } from '../src/components/boot-shell';
import { DocumentStyle } from '../src/components/document-style';
import { BOOT_SHELL_COLORS, BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';
import { createBootShellScript, resolveBootShellLayout } from '../src/lib/boot-shell-script';
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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  html.removeAttribute('class');
  html.removeAttribute('style');
  html.removeAttribute('data-lody-boot-sidebar');
  html.removeAttribute('data-lody-boot-layout');
  html.removeAttribute('data-lody-boot-mobile');
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
      'the root ignores a legacy saved route',
      '/',
      {
        'lody:lastAppRoute': JSON.stringify({
          version: 1,
          path: '/acme/sessions/s1',
          updatedAt: 1,
        }),
      },
      {},
      null,
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
        frameBorder: variables['--border'],
        status: variables['--muted-foreground'],
      };
    };
    expect(resolve(DEFAULT_VSCODE_THEME_SELECTION.lightThemeId)).toEqual(BOOT_SHELL_COLORS.light);
    expect(resolve(DEFAULT_VSCODE_THEME_SELECTION.darkThemeId)).toEqual(BOOT_SHELL_COLORS.dark);
  });
});

describe('boot shell geometry decisions', () => {
  it.each([
    ['/acme/chat', 'workspace'],
    ['/acme/sessions/s1?window=session', 'workspace'],
    ['/acme/settings/general', 'plain'],
    ['/login?redirect=/acme/chat', 'plain'],
    ['/', 'plain'],
  ] as const)('resolves %s as %s', (path, layout) => {
    expect(resolveBootShellLayout(path)).toBe(layout);
  });

  it.each([
    ['/acme/chat', { 'lody-sidebar-collapsed': 'true' }, 'workspace'],
    ['/acme/settings/general', {}, 'plain'],
    ['/login', {}, 'plain'],
  ] as const)('keeps layout independent of sidebar visibility for %s', (path, storage, layout) => {
    boot(path, storage);
    expect(html.getAttribute('data-lody-boot-layout')).toBe(layout);
    expect(html.hasAttribute('data-lody-boot-sidebar')).toBe(false);
  });

  it.each([
    [1280, 'Desktop browser', '120', '240px', true, false],
    [1280, 'Desktop browser', '900', '420px', true, false],
    [700, 'Desktop browser', '312', '312px', false, false],
    [390, 'iPhone Mobile', '312', '312px', false, true],
    [1024, 'iPad', '312', '312px', true, false],
  ] as const)(
    'publishes geometry at width %s with %s',
    (width, ua, stored, expected, sidebar, mobile) => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
      boot('/acme/chat', { 'lody-sidebar-last-width': stored });
      expect(html.style.getPropertyValue('--lody-boot-sidebar-width')).toBe(expected);
      expect(html.hasAttribute('data-lody-boot-sidebar')).toBe(sidebar);
      expect(html.getAttribute('data-lody-boot-mobile')).toBe(String(mobile));
      expect(html.getAttribute('data-lody-boot-layout')).toBe('workspace');
    }
  );
});

describe('live document styles', () => {
  it('takes over the static sheet before paint, updates the same live sheet, and removes it on unmount', () => {
    const name = 'test-boot-frame';
    const initialCss = '.test-style-target { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06); }';
    const revisedCss = '.test-style-target { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03); }';
    const staticSheet = document.createElement('style');
    staticSheet.dataset.href = name;
    staticSheet.textContent = initialCss;
    const unrelatedSheet = document.createElement('style');
    unrelatedSheet.dataset.href = 'unrelated-sheet';
    document.head.append(staticSheet, unrelatedSheet);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (css: string) =>
      act(() =>
        root.render(
          <>
            <DocumentStyle name={name} css={css} />
            <div className="test-style-target" />
          </>
        )
      );
    try {
      render(initialCss);
      const target = container.querySelector('.test-style-target')!;
      const liveSheet = container.querySelector('style')!;
      expect(staticSheet.isConnected).toBe(false);
      expect(unrelatedSheet.isConnected).toBe(true);
      expect(getComputedStyle(target).boxShadow).toBe('0 2px 8px rgba(0, 0, 0, 0.06)');
      render(revisedCss);
      expect(container.querySelector('style')).toBe(liveSheet);
      expect(container.querySelector('.test-style-target')).toBe(target);
      expect(getComputedStyle(target).boxShadow).toBe('0 1px 2px rgba(0, 0, 0, 0.03)');
      act(() => root.render(null));
      expect(liveSheet.isConnected).toBe(false);
      expect(unrelatedSheet.isConnected).toBe(true);
    } finally {
      act(() => root.unmount());
      staticSheet.remove();
      unrelatedSheet.remove();
    }
  });
});

class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <button>Recover render</button> : this.props.children;
  }
}

describe('boot shell provider handoff', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  const frame = () => container.querySelector('.lody-boot-shell')!;
  const expectReleased = (shell: Element) => {
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(false);
    expect(shell.getAttribute('aria-hidden')).toBe('true');
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(shell.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  };
  const expectAccessible = (element: HTMLElement) => {
    expect(element.closest('[inert], [aria-hidden="true"]')).toBeNull();
    element.focus();
    expect(document.activeElement).toBe(element);
  };

  it('replaces static markup, retains the frame and mark across distinct gates, and releases on destination commit', () => {
    container.innerHTML = BOOT_SHELL_MARKUP;
    const staticFrame = frame();
    const EntryGate = () => <BootShell status="Signing in" />;
    const DestinationGate = () => <BootShell path="/acme/chat" status="Opening workspace" />;
    const render = (children: ReactNode) =>
      act(() => root.render(<BootShellProvider path="/login">{children}</BootShellProvider>));
    render(<EntryGate />);
    const shell = frame();
    const mark = shell.querySelector('img');
    expect(shell).not.toBe(staticFrame);
    expect(staticFrame.isConnected).toBe(false);
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(true);
    expect(shell.getAttribute('data-layout')).toBe('plain');
    render(<DestinationGate />);
    expect(frame()).toBe(shell);
    expect(shell.querySelector('img')).toBe(mark);
    expect(container.querySelectorAll('.lody-boot-shell')).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Opening workspace');
    expect(shell.getAttribute('data-layout')).toBe('workspace');
    expect(shell.getAttribute('data-sidebar')).toBe('shown');
    render(<button>Destination</button>);
    expect(frame()).toBe(shell);
    expect(shell.querySelector('img')).toBe(mark);
    expectReleased(shell);
    expectAccessible(container.querySelector('button')!);
  });

  it('renders real children while pending and releases immediately for an interactive recovery page', () => {
    function Pending() {
      const [recover, setRecover] = useState(false);
      return recover ? (
        <button>Reload workspace</button>
      ) : (
        <>
          <BootShell status="Connecting" />
          <button onClick={() => setRecover(true)}>Show recovery</button>
        </>
      );
    }
    act(() =>
      root.render(
        <BootShellProvider>
          <Pending />
        </BootShellProvider>
      )
    );
    const shell = frame();
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(true);
    const pendingButton = container.querySelector('button')!;
    expectAccessible(pendingButton);
    act(() => pendingButton.click());
    expect(frame()).toBe(shell);
    expectReleased(shell);
    expect(container.querySelector('button')?.textContent).toBe('Reload workspace');
    expectAccessible(container.querySelector('button')!);
  });

  it('bridges a router pending gap and never resurrects the previous boot on later navigation', () => {
    const render = (pending: boolean, gate: boolean) =>
      act(() =>
        root.render(
          <BootShellProvider path="/acme/chat" pending={pending}>
            {gate ? <BootShell status="Opening workspace" /> : <button>Committed content</button>}
          </BootShellProvider>
        )
      );
    render(false, true);
    const shell = frame();
    render(true, false);
    expect(frame()).toBe(shell);
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Opening workspace');
    render(false, false);
    expectReleased(shell);
    expectAccessible(container.querySelector('button')!);
    render(true, false);
    expectReleased(shell);
    expectAccessible(container.querySelector('button')!);
  });

  it('owner cleanup cannot hide a different committed gate', () => {
    const render = (first: boolean, second: boolean) =>
      act(() =>
        root.render(
          <BootShellProvider path="/acme/chat">
            {first && <BootShell key="first" status="First owner" />}
            {second && <BootShell key="second" status="Second owner" path="/login" />}
          </BootShellProvider>
        )
      );
    render(true, true);
    const shell = frame();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Second owner');
    render(false, true);
    expect(frame()).toBe(shell);
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(true);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Second owner');
    render(false, false);
    expectReleased(shell);
  });

  it('replays StrictMode effects without losing ownership or leaving a stale owner on cleanup', () => {
    const render = (pending: boolean) =>
      act(() =>
        root.render(
          <StrictMode>
            <BootShellProvider>
              {pending ? <BootShell status="Strict pending" /> : <button>Ready</button>}
            </BootShellProvider>
          </StrictMode>
        )
      );
    render(true);
    const shell = frame();
    const mark = shell.querySelector('img');
    expect(container.querySelectorAll('[data-lody-boot-shell]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    render(false);
    expectReleased(shell);
    render(true);
    expect(frame()).toBe(shell);
    expect(shell.querySelector('img')).toBe(mark);
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(shell.hasAttribute('aria-hidden')).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Strict pending');
    render(false);
    expectReleased(shell);
  });

  it('lets an outer render boundary replace the provider and expose recovery after a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Child({ fail }: { fail: boolean }) {
      if (fail) throw new Error('Synthetic destination failure');
      return <BootShell status="Loading destination" />;
    }
    const render = (fail: boolean) =>
      act(() =>
        root.render(
          <RecoveryBoundary>
            <BootShellProvider>
              <Child fail={fail} />
            </BootShellProvider>
          </RecoveryBoundary>
        )
      );
    render(false);
    const shell = frame();
    expect(shell.hasAttribute('data-lody-boot-shell')).toBe(true);
    render(true);
    expect(shell.isConnected).toBe(false);
    expect(container.querySelector('.lody-boot-shell')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Recover render');
    expectAccessible(container.querySelector('button')!);
  });
});
