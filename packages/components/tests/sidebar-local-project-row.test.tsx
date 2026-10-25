// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalProjectMeta,
  MachineId,
  SessionId,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';

import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { SessionList, type SessionListRow } from '../src/components/session-list';
import { initI18n } from '../src/i18n';
import { Tooltip } from '@lody/ui/tooltip';

// Under `act`, React drains effects and scheduled work before each call returns,
// so nothing is left to run after the jsdom environment is torn down.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// A project hosted on a machine a teammate shared with the workspace. The row
// must behave exactly like one on this user's own device: clicking it steers the
// chat landing to that machine + project, and the new-chat button is offered.
const machineId = 'machine-teammate' as MachineId;
const project = {
  id: 'project-shared',
  name: 'Lody',
  rootPath: '/workspace/lody',
} as LocalProjectMeta;

const NO_LIVE_STATUSES: ReadonlyMap<string, SessionStatus> = new Map();

function localSession(id: string, fields: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId,
    createdAt: '2026-09-17T00:00:00.000Z',
    lastMessageAt: 10,
    lastReadAt: 10,
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    title: id,
    ...fields,
  } as SessionMeta;
}

describe('sidebar local project row', () => {
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
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(options: {
    onNavigateProject: (machineId: MachineId, localProjectId: string) => void;
    onNewChatInProject: (machineId: MachineId, localProjectId: string) => void;
    removalState?: 'waiting_for_device' | 'removing' | null;
    sessions?: SessionMeta[];
    whetherShowFullList?: boolean;
    onToggleFullList?: (groupKey: string) => void;
    collapsed?: boolean;
    liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
  }) {
    act(() => {
      root?.render(
        <Tooltip.Provider>
          <LocalProjectItem
            machineId={machineId}
            machineName="Teammate's Mac"
            project={project}
            // Removal stays owner-only; navigation does not depend on it.
            canRemoveProject={false}
            removalState={options.removalState ?? null}
            collapsed={options.collapsed ?? false}
            whetherShowFullList={options.whetherShowFullList ?? false}
            isSelected={false}
            sessionsForProject={options.sessions ?? []}
            childSessionsByParent={new Map()}
            liveSessionStatuses={options.liveSessionStatuses ?? NO_LIVE_STATUSES}
            formattedPath={project.rootPath}
            defaultSessionTitle="New session"
            selectedSessionId={null}
            removeProjectLabel="Remove folder"
            newChatLabel="New chat"
            archiveTooltipLabel="Archive session"
            archiveActionLabel="Archive"
            archiveConfirmLabel="Confirm"
            isMobile={false}
            toggleLabel="Toggle"
            onNavigateProject={options.onNavigateProject}
            onNewChatInProject={options.onNewChatInProject}
            onNavigateSession={() => undefined}
            onArchive={() => undefined}
            collapsedOpenedBySessionIds={{}}
            onToggleOpenedBySessions={() => undefined}
            onToggleCollapsed={() => undefined}
            onToggleFullList={options.onToggleFullList ?? (() => undefined)}
            onRequestRemoval={() => undefined}
          />
        </Tooltip.Provider>
      );
    });
    return container?.querySelector<HTMLElement>(`[data-id="project:${machineId}:${project.id}"]`);
  }

  it('activates the project on the landing and offers a new chat for a shared machine', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject });

    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('aria-disabled')).toBeNull();

    act(() => row?.click());
    expect(onNavigateProject).toHaveBeenCalledWith(machineId, project.id);

    const newChatButton = row?.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);
    act(() => newChatButton?.click());
    expect(onNewChatInProject).toHaveBeenCalledWith(machineId, project.id);
    // Starting a fresh chat must not double as a plain row activation.
    expect(onNavigateProject).toHaveBeenCalledTimes(1);
  });

  it('goes inert while the project is being removed', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject, removalState: 'removing' });

    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBe('true');

    act(() => row?.click());
    expect(onNavigateProject).not.toHaveBeenCalled();
    expect(row?.querySelector('button[aria-label="New chat"]')).toBeNull();
  });

  it('previews five sessions and can reveal the full local project history', () => {
    const sessions: SessionMeta[] = Array.from({ length: 7 }, (_, index) => ({
      id: `session-${index}` as SessionId,
      machineId,
      createdAt: '2026-09-17T00:00:00.000Z',
      lastMessageAt: 7 - index,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      title: `Session ${index}`,
    }));
    const onToggleFullList = vi.fn();
    const baseOptions = {
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      sessions,
      onToggleFullList,
    };

    render(baseOptions);
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(5);
    const showAll = container?.querySelector<HTMLButtonElement>(
      '[data-sidebar-show-more="local-project:machine-teammate:project-shared"]'
    );
    expect(showAll?.textContent).toBe('Show all (7)');

    act(() => showAll?.click());
    expect(onToggleFullList).toHaveBeenCalledWith('local-project:machine-teammate:project-shared');

    render({ ...baseOptions, whetherShowFullList: true });
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(7);
    expect(container?.querySelector('[data-sidebar-show-more]')?.textContent).toBe('Show less');
  });

  it('keeps the status of the Sessions a folded project hides on its header', () => {
    const sessions = [
      localSession('waiting'),
      localSession('running'),
      localSession('finished', { lastMessageAt: 20, lastReadAt: 10 }),
      localSession('idle'),
    ];
    const liveSessionStatuses = new Map<string, SessionStatus>([
      ['waiting', { type: 'requestPermission' }],
      ['running', { type: 'running' }],
    ]);
    const base = {
      onNavigateProject: vi.fn(),
      onNewChatInProject: vi.fn(),
      sessions,
      liveSessionStatuses,
    };

    // Expanded: the rows carry their own marks; the header adds nothing.
    let row = render({ ...base, collapsed: false });
    expect(row?.querySelector('[data-sidebar-group-activity]')).toBeNull();
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(4);

    // Folded: one mark at the header's trailing edge, by the rows' own priority —
    // a Session waiting on the user outranks the running and unread ones.
    row = render({ ...base, collapsed: true });
    expect(container?.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(0);
    const mark = row?.querySelector('[data-sidebar-group-activity]');
    expect(mark?.querySelectorAll('[data-session-row-indicator]')).toHaveLength(1);
    expect(mark?.querySelector('.lucide-hand')).not.toBeNull();
    // The counts are one hover (or one screen-reader announcement) away.
    expect(row?.getAttribute('aria-label')).toBe(
      "Lody · Teammate's Mac · /workspace/lody · 1 waiting for approval · 1 working · 1 unread"
    );

    // The permission is answered: the running Sessions now lead.
    row = render({
      ...base,
      collapsed: true,
      liveSessionStatuses: new Map<string, SessionStatus>([
        ['waiting', { type: 'running' }],
        ['running', { type: 'running' }],
      ]),
    });
    expect(row?.querySelector('[data-sidebar-group-activity] [data-working-grid]')).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toContain('2 working · 1 unread');

    // Both finish with new output: the folded header rests on the unread dot
    // (jsdom has no Web Animations, so the done transition completes at once).
    row = render({
      ...base,
      sessions: [
        localSession('waiting', { lastMessageAt: 30, lastReadAt: 10 }),
        localSession('running', { lastMessageAt: 30, lastReadAt: 10 }),
        localSession('finished', { lastMessageAt: 20, lastReadAt: 10 }),
        localSession('idle'),
      ],
      collapsed: true,
      liveSessionStatuses: NO_LIVE_STATUSES,
    });
    expect(row?.querySelector('[data-sidebar-group-activity] [data-working-grid]')).toBeNull();
    expect(
      row?.querySelector('[data-sidebar-group-activity] [data-session-unread-dot]')
    ).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toContain('3 unread');

    // Everything read: a folded, quiet project draws nothing.
    row = render({
      ...base,
      sessions: [localSession('idle')],
      collapsed: true,
      liveSessionStatuses: NO_LIVE_STATUSES,
    });
    expect(row?.querySelector('[data-session-row-indicator]')).toBeNull();
    expect(row?.getAttribute('aria-label')).toBe("Lody · Teammate's Mac · /workspace/lody");
  });
});

// A Project group's row is a project row: the same hover controls in the same
// places, the row itself starts a conversation, and there is no separate "+".
describe('sidebar project group row', () => {
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
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const row = (sessionId: string, projectGroup: { id: string; name: string }): SessionListRow => ({
    sessionId,
    title: sessionId,
    repoFullName: 'acme/web',
    branchName: '',
    latestMessageAt: '2026-10-18T00:00:00.000Z',
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    projectGroup,
  });

  function render() {
    const handlers = {
      onNewInProjectGroup: vi.fn(),
      onOpenProjectGroupSettings: vi.fn(),
      onArchiveProjectGroupChats: vi.fn(),
      onMoveProjectGroup: vi.fn(),
    };
    act(() => {
      root?.render(
        <SessionList
          sessions={[
            row('shop-1', { id: 'shop', name: 'Shop' }),
            // A deleted group still lists its conversations under the old name.
            row('old-1', { id: 'gone', name: 'Old group' }),
          ]}
          repos={[]}
          projectGroups={[
            { projectId: 'shop', name: 'Shop', collapsed: false },
            { projectId: 'docs', name: 'Docs', collapsed: false },
          ]}
          onToggleProjectGroupCollapsed={() => undefined}
          {...handlers}
        />
      );
    });
    const groupRow = (id: string) =>
      container?.querySelector<HTMLElement>(`[data-id="group:projectGroup:${id}"]`);
    return { handlers, groupRow };
  }

  it('offers the project row controls and starts a conversation from the row', () => {
    const { handlers, groupRow } = render();
    const shop = groupRow('shop');
    expect(shop?.querySelector('button[aria-label="More actions"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(shop?.querySelector('button[aria-label="Reorder project"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    const newChat = shop?.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat in this project"]'
    );
    act(() => newChat?.click());
    expect(handlers.onNewInProjectGroup).toHaveBeenLastCalledWith('shop');
    act(() => shop?.click());
    expect(handlers.onNewInProjectGroup).toHaveBeenCalledTimes(2);
    // No second, GitHub-style "+" beside the row.
    expect(container?.querySelector('button[aria-label="New session"]')).toBeNull();
  });

  it('leaves a deleted group nothing to start, edit or move', () => {
    const { handlers, groupRow } = render();
    const old = groupRow('gone');
    expect(old).toBeInstanceOf(HTMLElement);
    expect(old?.querySelector('button[aria-label="New chat in this project"]')).toBeNull();
    expect(old?.querySelector('button[aria-label="Reorder project"]')).toBeNull();
    act(() => old?.click());
    expect(handlers.onNewInProjectGroup).not.toHaveBeenCalled();
  });

  it('gives a GitHub repository row the project menu, seeded with that repository', () => {
    const onEditRepoProject = vi.fn();
    const onArchiveRepoChats = vi.fn();
    act(() => {
      root?.render(
        <SessionList
          sessions={[{ ...row('web-1', { id: 'x', name: 'x' }), projectGroup: undefined }]}
          repos={[{ repoFullName: 'acme/web', collapsed: false }]}
          onToggleRepoCollapsed={() => undefined}
          onEditRepoProject={onEditRepoProject}
          onArchiveRepoChats={onArchiveRepoChats}
        />
      );
    });
    const repoRow = container?.querySelector<HTMLElement>('[data-id="group:acme/web"]');
    expect(repoRow?.querySelector('button[aria-label="More actions"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    act(() => {
      repoRow?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      );
    });
    const item = (text: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((node) =>
        node.textContent?.includes(text)
      );
    act(() => item('Edit project')?.click());
    expect(onEditRepoProject).toHaveBeenCalledWith('acme/web');
  });
});
