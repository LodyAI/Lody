// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectMeta, MachineId, SessionId, SessionMeta } from '@lody/shared';

import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { SessionList } from '../src/components/session-list';
import { SidebarUpdatedSessionList } from '../src/components/sidebar-updated-session-list';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

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

  it('marks a Workspace-mode GitHub/Chat row unread from its More menu', () => {
    const onMarkSessionUnread = vi.fn();
    flushSync(() => {
      root?.render(
        <SessionList
          sessions={[
            {
              sessionId: 'workspace-session',
              title: 'Workspace session',
              repoFullName: 'lody/lody',
              branchName: 'feat/mark-unread',
              latestMessageAt: 500,
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
          ]}
          repos={[{ repoFullName: 'lody/lody', collapsed: false }]}
          onMarkSessionUnread={onMarkSessionUnread}
        />
      );
    });

    selectMarkUnread(container?.querySelector('[data-sidebar-session-id="workspace-session"]'));
    expect(onMarkSessionUnread).toHaveBeenCalledWith('workspace-session');
  });

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

  it('marks an Updated/Pinned row unread from its More menu', () => {
    const onMarkItemUnread = vi.fn();
    flushSync(() => {
      root?.render(
        <SidebarUpdatedSessionList
          items={[
            {
              id: 'updated-session',
              kind: 'chat',
              title: 'Updated session',
              sectionLabel: 'Chats',
              latestMessageAt: 500,
              hasUnreadMessages: false,
            },
          ]}
          now={new Date(1_000)}
          onMarkItemUnread={onMarkItemUnread}
        />
      );
    });

    selectMarkUnread(container?.querySelector('[data-sidebar-updated-id="updated-session"]'));
    expect(onMarkItemUnread).toHaveBeenCalledWith('updated-session');
  });

  it('marks a Local Project row unread from its More menu', () => {
    const machineId = 'machine-1' as MachineId;
    const sessionId = 'local-session' as SessionId;
    const session = {
      id: sessionId,
      machineId,
      createdAt: '2026-09-04T00:00:00.000Z',
      lastMessageAt: 500,
      lastReadAt: 500,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      title: 'Local session',
    } as SessionMeta;
    const project = {
      id: 'project-1',
      name: 'Lody',
      rootPath: '/workspace/lody',
    } as LocalProjectMeta;
    const onMarkSessionUnread = vi.fn();

    flushSync(() => {
      root?.render(
        <TooltipProvider>
          <LocalProjectItem
            machineId={machineId}
            machineName="This device"
            project={project}
            canRemoveProject={false}
            canNavigateProject
            collapsed={false}
            isSelected={false}
            sessionsForProject={[session]}
            childSessionsByParent={new Map()}
            liveSessionStatuses={new Map()}
            formattedPath={project.rootPath}
            defaultSessionTitle="New session"
            selectedSessionId={null}
            removeProjectLabel="Remove folder"
            archiveTooltipLabel="Archive session"
            archiveActionLabel="Archive"
            archiveConfirmLabel="Confirm"
            isMobile={false}
            toggleLabel="Toggle"
            onNavigateProject={() => undefined}
            onNavigateSession={() => undefined}
            onArchive={() => undefined}
            onMarkSessionUnread={onMarkSessionUnread}
            collapsedOpenedBySessionIds={{}}
            onToggleOpenedBySessions={() => undefined}
            onToggleCollapsed={() => undefined}
            onRequestRemoval={() => undefined}
          />
        </TooltipProvider>
      );
    });

    selectMarkUnread(container?.querySelector('[data-sidebar-session-id="local-session"]'));
    expect(onMarkSessionUnread).toHaveBeenCalledWith('local-session');
  });
});
