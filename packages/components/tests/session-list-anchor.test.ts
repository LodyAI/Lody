// @vitest-environment jsdom

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SessionList } from '../src/components/session-list';
import { initI18n } from '../src/i18n';

const SAMPLE_SESSION = {
  sessionId: 'session-1',
  title: 'Anchor row',
  repoFullName: 'loro-dev/lody',
  branchName: 'feat/anchor-row',
  latestMessageAt: '2026-04-22T00:00:00.000Z',
  addedLines: 0,
  deletedLines: 0,
  isWorking: false,
  hasUnreadMessages: false,
  isOffline: false,
  isWaitingPermission: false,
};

describe('SessionList anchor mode', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
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
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function renderList(getSessionHref?: (sessionId: string) => string | undefined) {
    const onSelectSession = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [SAMPLE_SESSION],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          onSelectSession,
          getSessionHref,
        })
      );
    });

    return { onSelectSession };
  }

  it('intercepts plain left-click and routes through onSelectSession', () => {
    const { onSelectSession } = renderList((sessionId) => `/workspace-a/sessions/${sessionId}`);
    const anchor = container?.querySelector<HTMLAnchorElement>(
      'a[href="/workspace-a/sessions/session-1"]'
    );
    expect(anchor).not.toBeNull();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    flushSync(() => {
      anchor?.dispatchEvent(event);
    });

    expect(onSelectSession).toHaveBeenCalledWith('session-1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets the browser open a new tab on Cmd/Ctrl-click without intercepting', () => {
    const { onSelectSession } = renderList((sessionId) => `/workspace-a/sessions/${sessionId}`);
    const anchor = container?.querySelector<HTMLAnchorElement>(
      'a[href="/workspace-a/sessions/session-1"]'
    );
    expect(anchor).not.toBeNull();

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    flushSync(() => {
      anchor?.dispatchEvent(event);
    });

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
