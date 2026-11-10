// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarUpdatedSessionList } from '../src/components/sidebar-updated-session-list';
import { SessionList } from '../src/components/session-list';
import { initI18n } from '../src/i18n';
import type { SessionSharingState } from '../src/lib/session-sharing';

const PRIVATE_SHARING: SessionSharingState = {
  visibility: 'private',
  privateReason: 'machine',
  canManage: true,
  machineId: null,
  localProjectId: null,
  machineName: null,
  projectName: null,
};

describe('sidebar share-only context menus', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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

  function openContextMenu(row: Element | null) {
    expect(row).not.toBeNull();
    flushSync(() => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      );
    });
  }

  function getShareMenuItem() {
    return Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      node.textContent?.includes('Share with team')
    );
  }

  it('keeps the SessionList menu reachable when Share is its only action', () => {
    const onShareSessionWithTeam = vi.fn();

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [
            {
              sessionId: 'task-list-session',
              title: 'Private conversation',
              repoFullName: 'loro-dev/lody',
              branchName: '',
              latestMessageAt: '2026-07-19T00:00:00.000Z',
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
              sharing: PRIVATE_SHARING,
            },
          ],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          onShareSessionWithTeam,
        })
      );
    });

    openContextMenu(container?.querySelector('[data-sidebar-session-id="task-list-session"]'));
    const shareItem = getShareMenuItem();
    expect(shareItem).not.toBeUndefined();

    flushSync(() => {
      shareItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onShareSessionWithTeam).toHaveBeenCalledWith('task-list-session');
  });

  it('keeps the Updated list menu reachable when Share is its only action', () => {
    const onShareItemWithTeam = vi.fn();

    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-07-19T01:00:00.000Z'),
          items: [
            {
              id: 'updated-session',
              kind: 'local',
              title: 'Private conversation',
              sectionLabel: 'Local Projects · lody',
              latestMessageAt: new Date('2026-07-19T00:00:00.000Z'),
              sharing: PRIVATE_SHARING,
            },
          ],
          onShareItemWithTeam,
        })
      );
    });

    openContextMenu(container?.querySelector('[data-sidebar-updated-id="updated-session"]'));
    const shareItem = getShareMenuItem();
    expect(shareItem).not.toBeUndefined();

    flushSync(() => {
      shareItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onShareItemWithTeam).toHaveBeenCalledWith('updated-session');
  });
  it.each(['sessions', 'updated'] as const)(
    'hides management controls but retains read preferences in %s rows',
    (surface) => {
      const sharing: SessionSharingState = {
        ...PRIVATE_SHARING,
        visibility: 'team',
        access: 'read',
        canManage: false,
      };
      const actions = { pin: false, unread: false };
      const forbidden = () => {
        throw new Error('management must stay hidden');
      };
      flushSync(() =>
        root?.render(
          surface === 'sessions' ? (
            <SessionList
              sessions={[
                {
                  sessionId: 'read-only',
                  title: 'Read-only conversation',
                  repoFullName: null,
                  branchName: '',
                  latestMessageAt: 100,
                  addedLines: 0,
                  deletedLines: 0,
                  isWorking: false,
                  hasUnreadMessages: false,
                  isOffline: false,
                  isWaitingPermission: false,
                  sharing,
                },
              ]}
              repos={[]}
              onArchiveSession={forbidden}
              onRenameSession={forbidden}
              onTogglePinSession={() => {
                actions.pin = true;
              }}
              onMarkSessionUnread={() => {
                actions.unread = true;
              }}
            />
          ) : (
            <SidebarUpdatedSessionList
              items={[
                {
                  id: 'read-only',
                  kind: 'local',
                  title: 'Read-only conversation',
                  sectionLabel: 'Local',
                  latestMessageAt: new Date(100),
                  sharing,
                },
              ]}
              onArchiveItem={forbidden}
              onRenameItem={forbidden}
              onTogglePinItem={() => {
                actions.pin = true;
              }}
              onMarkItemUnread={() => {
                actions.unread = true;
              }}
            />
          )
        )
      );
      const row =
        container?.querySelector(
          '[data-sidebar-session-id="read-only"], [data-sidebar-updated-id="read-only"]'
        ) ?? null;
      expect(
        row?.querySelector('[aria-label="Archive session"], [aria-label="Archive Session"]')
      ).toBeNull();
      for (const label of ['Pin Session', 'Mark as unread']) {
        openContextMenu(row);
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        expect(
          items
            .map((item) => item.textContent)
            .some((text) => /Rename|Archive|Delete/.test(text ?? ''))
        ).toBe(false);
        const action = items.find((item) => item.textContent === label);
        expect(action).toBeDefined();
        flushSync(() => action!.click());
      }
      expect(actions).toEqual({ pin: true, unread: true });
      const title = [...row!.querySelectorAll('span')].find(
        (node) => node.textContent === 'Read-only conversation'
      );
      expect(title).toBeDefined();
      flushSync(() => title!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  );
});
