// @vitest-environment jsdom

import React, { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import lodyLogo from '../src/assets/lody-icon.png';
import { LoadingPlaceholder } from '../src/components/loading-placeholder';
import { LoroSidebar, type LoroSidebarProps } from '../src/components/loro-sidebar';
import { MobileHomeScreen } from '../src/components/mobile/mobile-home-screen';
import { initI18n } from '../src/i18n';
import { resolveWorkspaceIdentityLogo } from '../src/lib/workspace-identity';

const sidebarProps: LoroSidebarProps = {
  workspaceName: 'Lody',
  userEmail: 'local@lody.invalid',
  workspaces: [{ id: 'local-workspace', name: 'Lody', logo: lodyLogo }],
  currentWorkspaceId: 'local-workspace',
  repoSections: [],
  chats: [],
};

describe('workspace identity capability boundary', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

  it('uses the Lody brand logo only for the implicit local workspace', () => {
    expect(resolveWorkspaceIdentityLogo('https://example.com/org.png', false)).toBe(lodyLogo);
    expect(resolveWorkspaceIdentityLogo('https://example.com/org.png', true)).toBe(
      'https://example.com/org.png'
    );
    expect(resolveWorkspaceIdentityLogo(null, true)).toBeNull();
  });

  it('renders the desktop local workspace as a static nameplate', () => {
    render(<LoroSidebar {...sidebarProps} workspaceSwitcherEnabled={false} />);

    const identity = container?.querySelector('[data-workspace-identity]');
    expect(identity?.tagName).toBe('DIV');
    expect(identity?.textContent).toContain('Lody');
    expect(container?.querySelector('[data-workspace-switcher-trigger]')).toBeNull();
  });

  it('keeps the desktop cloud workspace trigger enabled by default', () => {
    render(<LoroSidebar {...sidebarProps} />);

    expect(container?.querySelector('[data-workspace-switcher-trigger]')?.tagName).toBe('BUTTON');
    expect(container?.querySelector('[data-workspace-identity]')).toBeNull();
    expect(container?.querySelectorAll('[data-workspace-switcher-trigger]')).toHaveLength(1);
    expect(container?.querySelector('button button')).toBeNull();
  });

  it('highlights desktop workspace rows, anchors their hint, and selects in the dropdown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('__LODY_ELECTRON__', true);
    let selectedWorkspace = 'alpha';
    const settle = async (run: () => void = () => {}) => {
      await act(async () => {
        run();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    };
    try {
      render(
        <LoroSidebar
          {...sidebarProps}
          currentWorkspaceId="alpha"
          workspaces={[
            { id: 'alpha', name: 'Alpha', slug: 'alpha' },
            { id: 'beta', name: 'Beta', slug: 'beta' },
          ]}
          onWorkspaceSelected={(value) => {
            selectedWorkspace = value;
          }}
        />
      );
      const trigger = container!.querySelector<HTMLElement>('[data-workspace-switcher-trigger]')!;
      await settle(() => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(rows).toHaveLength(2);
      const [alpha, beta] = rows;
      await settle(() => {
        alpha.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        );
        alpha.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(alpha.hasAttribute('data-highlighted')).toBe(true);
      const betaRestClass = beta.className;
      await settle(() => {
        beta.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
        );
        beta.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        beta.dispatchEvent(new MouseEvent('mouseenter'));
        beta.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        );
        beta.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(beta.hasAttribute('data-highlighted')).toBe(true);
      expect(alpha.hasAttribute('data-highlighted')).toBe(false);
      expect(beta.className).not.toBe(betaRestClass);
      expect(beta.hasAttribute('data-popup-open')).toBe(true);
      expect(document.body.textContent).toContain('click to open in a new window');
      await settle(() => {
        beta.click();
      });
      expect(selectedWorkspace).toBe('beta');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      flushSync(() => root?.unmount());
      root = undefined;
      vi.useRealTimers();
    }
  });

  it('restores the sidebar viewport after unmount and keeps workspace positions separate', () => {
    const store = createStore();
    const sidebar = (key: string) => <LoroSidebar {...sidebarProps} scrollStateKey={key} />;
    render(<Provider store={store}>{sidebar('workspace-a')}</Provider>);

    const viewport = () =>
      container?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]');
    expect(viewport()).not.toBeNull();
    viewport()!.scrollTop = 180;
    flushSync(() => root?.render(<Provider store={store}>{null}</Provider>));
    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-a')}</Provider>));
    expect(viewport()?.scrollTop).toBe(180);

    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-b')}</Provider>));
    expect(viewport()?.scrollTop).toBe(0);
    viewport()!.scrollTop = 55;
    flushSync(() => root?.render(<Provider store={store}>{sidebar('workspace-a')}</Provider>));
    expect(viewport()?.scrollTop).toBe(180);
  });

  it('keeps scoped workspace synchronization visible after the connection is online', () => {
    render(
      <LoroSidebar
        {...sidebarProps}
        connectionUiState="online"
        workspaceSyncing
        labels={{ workspaceSyncing: 'Syncing target workspace…' }}
      />
    );

    const trigger = container?.querySelector('[data-workspace-switcher-trigger]');
    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    expect(trigger?.getAttribute('data-workspace-syncing')).toBe('true');
    const status = container?.querySelector('[data-workspace-status]');
    expect(status?.getAttribute('data-workspace-status')).toBe('syncing');
    expect(status?.textContent).toBe('Syncing target workspace…');
  });

  it('keeps connection failures ahead of workspace synchronization', () => {
    render(
      <LoroSidebar
        {...sidebarProps}
        connectionUiState="offline"
        workspaceSyncing
        labels={{ connectionOffline: 'No connection' }}
      />
    );

    const status = container?.querySelector('[data-workspace-status]');
    expect(status?.getAttribute('data-workspace-status')).toBe('offline');
    expect(status?.textContent).toBe('No connection');
  });

  it('supports a content-scoped loading placeholder without taking over the viewport', () => {
    render(<LoadingPlaceholder variant="content" title="Switching workspace" />);

    const placeholder = container?.querySelector('[data-loading-placeholder-scope]');
    expect(placeholder?.getAttribute('data-loading-placeholder-scope')).toBe('content');
    expect(placeholder?.className).toContain('h-full');
    expect(placeholder?.className).not.toContain('min-h-[100dvh]');
  });

  it('renders the mobile local workspace identity without a dialog trigger', () => {
    render(
      <MobileHomeScreen
        workspace={{ id: 'local-workspace', name: 'Lody', avatarUrl: lodyLogo }}
        machines={[]}
        selectedTab="chat"
        localProjects={[]}
        githubRepositories={[]}
        chats={[]}
      />
    );

    const identity = container?.querySelector('[data-workspace-identity]');
    expect(identity?.tagName).toBe('DIV');
    expect(container?.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });
});
