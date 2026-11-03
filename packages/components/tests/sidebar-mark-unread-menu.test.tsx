// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionList } from '../src/components/session-list';

import { initI18n } from '../src/i18n';

describe('desktop sidebar mark-unread menus', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function selectMarkUnread(row: Element | null) {
    const moreButton = row?.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(moreButton).toBeInstanceOf(HTMLButtonElement);
    flushSync(() => {
      moreButton?.click();
    });

    const menuItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Mark as unread')
    );
    expect(menuItem).toBeInstanceOf(HTMLElement);
    flushSync(() => {
      menuItem?.click();
    });
  }

  it('hides the action once the row is already unread', () => {
    flushSync(() => {
      root?.render(
        <SessionList
          sessions={[
            {
              sessionId: 'unread-session',
              title: 'Unread session',
              repoFullName: null,
              branchName: '',
              latestMessageAt: 500,
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: true,
              isOffline: false,
              isWaitingPermission: false,
            },
          ]}
          repos={[]}
          onArchiveSession={() => undefined}
          onMarkSessionUnread={() => undefined}
        />
      );
    });

    const row = container?.querySelector('[data-sidebar-session-id="unread-session"]');
    const moreButton = row?.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(moreButton).toBeInstanceOf(HTMLButtonElement);
    flushSync(() => {
      moreButton?.click();
    });
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some((item) =>
        item.textContent?.includes('Mark as unread')
      )
    ).toBe(false);
  });
});
