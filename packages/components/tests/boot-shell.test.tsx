// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { act, Component, useState, type ReactNode } from 'react';

import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootShell, BootShellProvider } from '../src/components/boot-shell';

import { BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';
import { createBootShellScript } from '../src/lib/boot-shell-script';

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
  vi.stubGlobal('localStorage', window.localStorage);
  vi.stubGlobal('sessionStorage', window.sessionStorage);
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
  vi.unstubAllGlobals();
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
