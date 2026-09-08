// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';
import type { LocalProjectId, MachineId, SessionMeta } from '@lody/shared';

const machineId = 'machine-local' as MachineId;
const localProjectId = 'project-lody' as LocalProjectId;

const baseSession = {
  machineId,
  createdAt: '2026-05-09T10:00:00.000Z',
  lastMessageAt: Date.parse('2026-05-09T11:45:00.000Z'),
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'codex',
  project: {
    kind: 'local',
    localProjectId,
    machineId,
  },
} satisfies Omit<SessionMeta, 'id'>;

describe('LocalProjectItem session-type icon', () => {
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

  it('does not render a session-type icon in the row (it lives in the hover card now)', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const sessionsForProject: SessionMeta[] = [
      {
        ...baseSession,
        id: 'session-worktree',
        title: 'Worktree local session',
        isWorktree: true,
      },
      {
        ...baseSession,
        id: 'session-local',
        title: 'Plain local session',
      },
    ];

    flushSync(() => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(LocalProjectItem, {
            machineId,
            machineName: 'Local machine',
            project: {
              id: localProjectId,
              name: 'lody',
              rootPath: '/Users/me/lody',
              createdAtMs: Date.parse('2026-05-09T09:00:00.000Z'),
            },
            sectionKind: 'local',
            canNavigateProject: true,
            collapsed: false,
            isSelected: false,
            sessionsForProject,
            childSessionsByParent: new Map(),
            formattedPath: '/Users/me/lody',
            defaultSessionTitle: 'Untitled session',
            now: new Date('2026-05-09T12:00:00.000Z'),
            onlineMachineIds: new Set([machineId]),
            selectedSessionId: null,
            removeProjectLabel: 'Remove folder',
            archiveTooltipLabel: 'Archive session',
            archiveActionLabel: 'Archive',
            archiveConfirmLabel: 'Confirm',
            isMobile: false,
            toggleLabel: 'Toggle',
            onNavigateProject: vi.fn(),
            onNavigateSession: vi.fn(),
            onArchive: vi.fn(),
            onToggleCollapsed: vi.fn(),
            onRequestRemoval: vi.fn(),
          })
        )
      );
    });

    // The worktree / folder type icon was removed from the row; the worktree
    // distinction now lives only in the desktop hover info card.
    const worktreeIcon = container.querySelector(
      '[data-sidebar-session-id="session-worktree"] [aria-label="Running in a worktree"]'
    );
    const plainIcon = container.querySelector(
      '[data-sidebar-session-id="session-local"] [aria-label="Running in a worktree"]'
    );

    expect(worktreeIcon).toBeNull();
    expect(plainIcon).toBeNull();
  });

  it('renders the PR status icon for a resting local session linked to a GitHub PR', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const sessionsForProject: SessionMeta[] = [
      {
        ...baseSession,
        id: 'session-with-pr',
        title: 'Local session with PR',
        // Read, so the end slot shows its resting metrics: a status mark would
        // take that slot for itself (`sidebar-row-shared.tsx`).
        lastReadAt: Date.parse('2026-05-09T11:45:00.000Z'),
        project: {
          kind: 'local',
          localProjectId,
          machineId,
          githubRepoFullName: 'loro-dev/lody',
        },
        pullRequests: [{ url: 'https://github.com/loro-dev/lody/pull/42', status: 'open' }],
      },
      {
        ...baseSession,
        id: 'session-without-pr',
        title: 'Plain local session',
        lastReadAt: Date.parse('2026-05-09T11:45:00.000Z'),
      },
      {
        ...baseSession,
        id: 'session-unread-with-pr',
        title: 'Unread local session with PR',
        project: {
          kind: 'local',
          localProjectId,
          machineId,
          githubRepoFullName: 'loro-dev/lody',
        },
        pullRequests: [{ url: 'https://github.com/loro-dev/lody/pull/43', status: 'open' }],
      },
    ];

    flushSync(() => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(LocalProjectItem, {
            machineId,
            machineName: 'Local machine',
            project: {
              id: localProjectId,
              name: 'lody',
              rootPath: '/Users/me/lody',
              createdAtMs: Date.parse('2026-05-09T09:00:00.000Z'),
            },
            sectionKind: 'local',
            canNavigateProject: true,
            collapsed: false,
            isSelected: false,
            sessionsForProject,
            childSessionsByParent: new Map(),
            formattedPath: '/Users/me/lody',
            defaultSessionTitle: 'Untitled session',
            now: new Date('2026-05-09T12:00:00.000Z'),
            onlineMachineIds: new Set([machineId]),
            selectedSessionId: null,
            removeProjectLabel: 'Remove folder',
            archiveTooltipLabel: 'Archive session',
            archiveActionLabel: 'Archive',
            archiveConfirmLabel: 'Confirm',
            isMobile: false,
            toggleLabel: 'Toggle',
            onNavigateProject: vi.fn(),
            onNavigateSession: vi.fn(),
            onArchive: vi.fn(),
            onToggleCollapsed: vi.fn(),
            onRequestRemoval: vi.fn(),
          })
        )
      );
    });

    const rowWithPr = container.querySelector('[data-sidebar-session-id="session-with-pr"]');
    const rowWithoutPr = container.querySelector('[data-sidebar-session-id="session-without-pr"]');
    expect(rowWithPr?.querySelector('.lucide-git-pull-request')).not.toBeNull();
    expect(rowWithoutPr?.querySelector('.lucide-git-pull-request')).toBeNull();

    // An unread row spends its end slot on the status mark instead — the PR icon
    // is one of the resting metrics that yields to it.
    const unreadRow = container.querySelector('[data-sidebar-session-id="session-unread-with-pr"]');
    expect(unreadRow?.querySelector('.lucide-git-pull-request')).toBeNull();
    expect(unreadRow?.querySelector('[data-session-row-indicator]')).not.toBeNull();
  });
});
