// @vitest-environment jsdom
import { act } from 'react';
import { PlatformContext } from '@lody/platform/react';
import { createLocalPlatformProvider, type PlatformSyncMode } from '@lody/platform';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';
import {
  getProjectMcpKey,
  workspaceFlockKeys,
  type LocalProjectId,
  type McpServerId,
  type ProjectRef,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { ProjectDefaultMcpTab } from '../src/components/settings/project-default-mcp-tab';
import { putProjectMcpDefault } from '../src/lib/workspace-catalog-write';
import {
  useSessionMcpSelection,
  type SessionMcpDefaultsTarget,
  type SessionMcpSelection,
} from '../src/hooks/use-session-mcp-selection';
import { initI18n } from '../src/i18n';
import type {
  ProjectMcpDefaultAccess,
  ProjectMcpDefaultTarget,
} from '../src/lib/workspace-catalog-write';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const server = (id: string, name: string, extra: Partial<WorkspaceMcpServerMeta> = {}) =>
  ({
    id: id as McpServerId,
    name,
    transport: 'stdio',
    connection: { transport: 'stdio', command: `mcp-${id}` },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) satisfies WorkspaceMcpServerMeta;

const projectA: ProjectRef = { kind: 'local', localProjectId: 'project-a' as LocalProjectId };
const projectB: ProjectRef = { kind: 'local', localProjectId: 'project-b' as LocalProjectId };
const keyOf = (project: ProjectRef) => getProjectMcpKey(project, 'machine-1')!;

/**
 * A workspace document whose rows live in memory. A put commits the row and
 * emits the Flock event synchronously, as a local durable write does, so the
 * shared catalog room — not a mock of it — carries the change to every hook.
 * Opening the document waits on `open()`, so tests decide when it is readable.
 */
function createWorkspace(workspaceId: string, rows: Array<[readonly string[], unknown]>) {
  const store = new Map(rows.map(([key, value]) => [JSON.stringify(key), { key, value }]));
  const listeners = new Set<(batch: unknown) => void>();
  let open!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  let sync!: () => void;
  const firstSyncedWithRemote = new Promise<void>((resolve) => {
    sync = resolve;
  });
  const flock = {
    scan: (options?: { prefix?: readonly unknown[] }) =>
      [...store.values()].filter(({ key }) => key[0] === options?.prefix?.[0]),
    subscribe: (listener: (batch: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const put = (key: readonly string[], value: unknown) => {
    store.set(JSON.stringify(key), { key, value });
    for (const listener of listeners) listener({ events: [{ key, value }] });
  };
  const runtime = {
    workspaceId: workspaceId as WorkspaceId,
    repo: {
      openFlockDoc: async () => {
        await opened;
        return {
          flock,
          joinRoom: async () => ({
            unsubscribe: () => {},
            firstSyncedWithRemote,
          }),
          syncOnce: async () => {},
        };
      },
    },
    writer: {
      flockRowPut: async (_docId: string, key: readonly string[], value: unknown) =>
        put(key, value),
      flockRowDelete: async () => {},
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    open,
    fail,
    sync,
    put,
    rowOf: (key: readonly string[]) => store.get(JSON.stringify(key))?.value,
  };
}

const settle = async () => {
  await act(async () => {
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  });
};

let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
beforeEach(async () => {
  await initI18n('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  store = createStore();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const catalogRows = (): Array<[readonly string[], unknown]> => [
  [
    workspaceFlockKeys.mcpServer('files' as McpServerId),
    server('files', 'Files', { enabledByDefault: true }),
  ],
  [workspaceFlockKeys.mcpServer('search' as McpServerId), server('search', 'Search')],
  [
    workspaceFlockKeys.mcpServer('db' as McpServerId),
    server('db', 'Database', { enabledByDefault: true }),
  ],
];

/** Renders the composer hook and records the selection of EVERY render. */
function renderSelection(props: {
  persistedIds?: readonly McpServerId[];
  existingSession?: boolean;
  scopeKey?: string;
  defaultsTarget?: SessionMcpDefaultsTarget;
  syncMode?: PlatformSyncMode;
}) {
  const renders: SessionMcpSelection[] = [];
  let latest!: SessionMcpSelection;
  function Probe(current: typeof props) {
    latest = useSessionMcpSelection(current.persistedIds, {
      existingSession: current.existingSession,
      scopeKey: current.scopeKey,
      defaultsTarget: current.defaultsTarget,
    });
    renders.push(latest);
    return null;
  }
  const render = (next: typeof props) =>
    act(() =>
      root.render(
        <Provider store={store}>
          <PlatformContext.Provider
            value={
              next.syncMode && next.syncMode !== 'local'
                ? { ...TEST_CLOUD_PLATFORM, sync: { mode: next.syncMode } }
                : createLocalPlatformProvider({
                    session: TEST_CLOUD_PLATFORM.identity.session,
                    workspaces: TEST_CLOUD_PLATFORM.workspaces.state,
                  })
            }
          >
            <Probe {...next} />
          </PlatformContext.Provider>
        </Provider>
      )
    );
  render(props);
  return { renders, render, current: () => latest };
}

describe('composer MCP selection', () => {
  it.each([false, true])('local mode waits only for its document (empty=%s)', async (empty) => {
    const workspace = createWorkspace('workspace-1', empty ? [] : catalogRows());
    store.set(runtimeAtom, workspace.runtime);
    const view = renderSelection({ defaultsTarget: { project: projectA, machineId: 'machine-1' } });
    await settle();
    expect(view.current().ready).toBe(false);

    workspace.open();
    await settle();
    expect(view.current()).toMatchObject({
      ready: true,
      selectedIds: empty ? [] : ['db', 'files'],
    });
  });

  it.each(['cloud', 'dual'] as const)(
    'waits for %s catch-up even with a partial local catalog',
    async (syncMode) => {
      const workspace = createWorkspace('workspace-1', []);
      store.set(runtimeAtom, workspace.runtime);
      const view = renderSelection({
        syncMode,
        defaultsTarget: { project: projectA, machineId: 'machine-1' },
      });
      workspace.open();
      await settle();
      expect(view.current()).toMatchObject({ ready: false, selectedIds: [] });
      // Catalog entries may arrive before the project row; nonempty is not ready.
      act(() => {
        for (const [key, value] of catalogRows()) workspace.put(key, value);
      });
      await settle();
      expect(view.current()).toMatchObject({ ready: false, selectedIds: ['db', 'files'] });
      act(() =>
        workspace.put(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)), { ids: ['search'] })
      );
      workspace.sync();
      await settle();
      expect(view.current()).toMatchObject({ ready: true, selectedIds: ['search'] });
    }
  );

  it('accepts a confirmed empty cloud catalog and does not gate explicit selections', async () => {
    const workspace = createWorkspace('workspace-1', []);
    store.set(runtimeAtom, workspace.runtime);
    const view = renderSelection({ syncMode: 'cloud' });
    workspace.open();
    await settle();
    view.render({ syncMode: 'cloud', existingSession: true, persistedIds: [] });
    expect(view.current()).toMatchObject({ ready: true, selectedIds: [] });
    view.render({ syncMode: 'cloud', persistedIds: [] });
    expect(view.current()).toMatchObject({ ready: true, selectedIds: [] });
    view.render({ syncMode: 'cloud' });
    expect(view.current().ready).toBe(false);
    workspace.sync();
    await settle();
    expect(view.current()).toMatchObject({ ready: true, selectedIds: [] });
  });

  it('reports unreadable defaults as a failure, never as an empty selection', async () => {
    const workspace = createWorkspace('workspace-1', catalogRows());
    store.set(runtimeAtom, workspace.runtime);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderSelection({ defaultsTarget: { project: projectA, machineId: 'machine-1' } });
    workspace.fail(new Error('storage unavailable'));
    await settle();
    expect(view.current()).toMatchObject({ ready: false, defaultsFailed: true });
    error.mockRestore();
  });

  it('replaces the workspace defaults with a project row, including [] for none', async () => {
    const workspace = createWorkspace('workspace-1', [
      ...catalogRows(),
      [workspaceFlockKeys.projectMcpDefault(keyOf(projectA)), { ids: ['search', 'deleted'] }],
      [workspaceFlockKeys.projectMcpDefault(keyOf(projectB)), { ids: [] }],
    ]);
    store.set(runtimeAtom, workspace.runtime);
    workspace.open();
    const view = renderSelection({ defaultsTarget: { project: projectA, machineId: 'machine-1' } });
    await settle();
    // A deleted id is filtered out of derived defaults rather than sent.
    expect(view.current().selectedIds).toEqual(['search']);

    view.render({ defaultsTarget: { project: projectB, machineId: 'machine-1' } });
    expect(view.current().selectedIds).toEqual([]);

    // Same local project id on another machine is another project.
    view.render({ defaultsTarget: { project: projectB, machineId: 'machine-2' } });
    expect(view.current().selectedIds).toEqual(['db', 'files']);

    view.render({ defaultsTarget: { project: null } });
    expect(view.current().selectedIds).toEqual(['db', 'files']);
  });

  it('keeps an existing conversation’s selection and never enrolls an unrecorded one', async () => {
    const workspace = createWorkspace('workspace-1', [
      ...catalogRows(),
      [workspaceFlockKeys.projectMcpDefault(keyOf(projectA)), { ids: ['search'] }],
    ]);
    store.set(runtimeAtom, workspace.runtime);
    const target = { project: projectA, machineId: 'machine-1' };
    const view = renderSelection({ existingSession: true, scopeKey: 's1', defaultsTarget: target });
    // Recorded or not, an existing conversation never waits on defaults.
    expect(view.current()).toMatchObject({ ready: true, selectedIds: [] });

    workspace.open();
    await settle();
    expect(view.current().selectedIds).toEqual([]);

    view.render({
      existingSession: true,
      scopeKey: 's2',
      persistedIds: [],
      defaultsTarget: target,
    });
    expect(view.current().selectedIds).toEqual([]);
    view.render({
      existingSession: true,
      scopeKey: 's3',
      persistedIds: ['db' as McpServerId],
      defaultsTarget: target,
    });
    expect(view.current().selectedIds).toEqual(['db']);
  });

  it('drops a project’s edits in the very render the project changes', async () => {
    const workspace = createWorkspace('workspace-1', [
      ...catalogRows(),
      [workspaceFlockKeys.projectMcpDefault(keyOf(projectB)), { ids: ['search'] }],
    ]);
    store.set(runtimeAtom, workspace.runtime);
    workspace.open();
    const view = renderSelection({ defaultsTarget: { project: projectA, machineId: 'machine-1' } });
    await settle();
    act(() => view.current().setSelectedIds(['db' as McpServerId]));
    expect(view.current().selectedIds).toEqual(['db']);

    const before = view.renders.length;
    view.render({ defaultsTarget: { project: projectB, machineId: 'machine-1' } });
    // Every render after the switch — including the first — shows B's defaults.
    expect(view.renders.slice(before).map((render) => render.selectedIds)).toEqual(
      view.renders.slice(before).map(() => ['search'])
    );

    // Coming back does not resurrect the abandoned edit either.
    view.render({ defaultsTarget: { project: projectA, machineId: 'machine-1' } });
    expect(view.current().selectedIds).toEqual(['db', 'files']);
  });

  it('shows nothing of the previous workspace while the next one opens', async () => {
    const first = createWorkspace('workspace-1', catalogRows());
    store.set(runtimeAtom, first.runtime);
    first.open();
    const view = renderSelection({ defaultsTarget: { project: null } });
    await settle();
    expect(view.current().selectedIds).toEqual(['db', 'files']);

    const second = createWorkspace('workspace-2', [
      [
        workspaceFlockKeys.mcpServer('other' as McpServerId),
        server('other', 'Other', { enabledByDefault: true }),
      ],
    ]);
    const before = view.renders.length;
    act(() => store.set(runtimeAtom, second.runtime));
    const afterSwitch = view.renders.slice(before);
    expect(afterSwitch.length).toBeGreaterThan(0);
    for (const render of afterSwitch) {
      expect(render.servers.map(({ id }) => id)).not.toContain('files');
      expect(render.ready).toBe(false);
    }

    second.open();
    await settle();
    expect(view.current()).toMatchObject({ ready: true, selectedIds: ['other'] });
  });
});

describe('project Default MCP tab', () => {
  const target: ProjectMcpDefaultTarget = {
    workspaceId: 'workspace-1' as WorkspaceId,
    project: { ...projectA, branch: 'feature', useWorktree: true } as ProjectRef,
    machineId: 'machine-1',
  };
  const owner: ProjectMcpDefaultAccess = {
    kind: 'local',
    currentUserId: 'user-1',
    machineOwnerUserId: 'user-1',
  };

  const renderTab = (access: ProjectMcpDefaultAccess) =>
    act(() =>
      root.render(
        <Provider store={store}>
          <ProjectDefaultMcpTab target={target} access={access} />
        </Provider>
      )
    );
  const switches = () =>
    [...container.querySelectorAll<HTMLElement>('[role="switch"]')].map((element) => ({
      element,
      label: element.getAttribute('aria-label'),
      checked: element.getAttribute('aria-checked') === 'true',
      disabled:
        element.hasAttribute('data-disabled') || element.getAttribute('aria-disabled') === 'true',
    }));

  it('saves the whole effective list on the first edit, shared by every branch', async () => {
    const workspace = createWorkspace('workspace-1', [
      ...catalogRows(),
      [
        workspaceFlockKeys.mcpServer('bare' as McpServerId),
        { ...server('bare', 'Bare'), connection: undefined },
      ],
    ]);
    store.set(runtimeAtom, workspace.runtime);
    renderTab(owner);
    expect(container.textContent).toContain('Loading the workspace MCP catalog');

    workspace.open();
    await settle();
    // Sorted by name: Bare, Database, Files, Search.
    expect(switches().map(({ checked }) => checked)).toEqual([false, true, true, false]);
    expect(container.textContent).toContain('Following the workspace defaults');
    expect(container.textContent).toContain('No connection is configured');

    const search = switches().find(({ label }) => label?.includes('Search'))!;
    await act(async () => search.element.click());
    await settle();

    // Stored under the project, not the branch/worktree the target came from.
    expect(workspace.rowOf(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)))).toEqual({
      ids: ['db', 'files', 'search'],
    });
    expect(container.textContent).toContain('This project has its own list');

    // Turning everything off is a list of its own, not a return to inheritance.
    for (const label of ['Files', 'Database', 'Search']) {
      const toggle = switches().find((entry) => entry.label?.includes(label))!;
      await act(async () => toggle.element.click());
      await settle();
    }
    expect(workspace.rowOf(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)))).toEqual({
      ids: [],
    });
  });

  it('is read-only for someone who does not own the project, at the write as well', async () => {
    const workspace = createWorkspace('workspace-1', catalogRows());
    store.set(runtimeAtom, workspace.runtime);
    workspace.open();
    const teammate: ProjectMcpDefaultAccess = { ...owner, currentUserId: 'user-2' };
    renderTab(teammate);
    await settle();
    expect(switches().every(({ disabled }) => disabled)).toBe(true);
    expect(container.textContent).toContain('Only the owner');

    // A caller that bypasses the disabled switch is refused by the write itself.
    await expect(
      putProjectMcpDefault(workspace.runtime, target, teammate, ['search' as McpServerId])
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(workspace.rowOf(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)))).toBeUndefined();
  });

  it('keeps the saved selection after a failed write and lets the next edit succeed', async () => {
    const workspace = createWorkspace('workspace-1', catalogRows());
    const put = workspace.runtime.writer.flockRowPut;
    let failWrite = true;
    workspace.runtime.writer.flockRowPut = async (...args) => {
      if (failWrite) throw new Error('Synthetic storage failure');
      return put(...args);
    };
    store.set(runtimeAtom, workspace.runtime);
    workspace.open();
    renderTab(owner);
    await settle();
    const search = () => switches().find(({ label }) => label?.includes('Search'))!;
    await act(async () => search().element.click());
    await settle();
    expect(search().checked).toBe(false);
    expect(search().disabled).toBe(false);
    expect(container.textContent).toContain('The change wasn’t saved');
    expect(workspace.rowOf(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)))).toBeUndefined();

    failWrite = false;
    await act(async () => search().element.click());
    await settle();
    expect(search().checked).toBe(true);
    expect(container.textContent).not.toContain('The change wasn’t saved');
    expect(workspace.rowOf(workspaceFlockKeys.projectMcpDefault(keyOf(projectA)))).toEqual({
      ids: ['db', 'files', 'search'],
    });
  });

  it('points an empty catalog at MCP management', async () => {
    const workspace = createWorkspace('workspace-1', []);
    store.set(runtimeAtom, workspace.runtime);
    workspace.open();
    const onManageMcp = vi.fn();
    act(() =>
      root.render(
        <Provider store={store}>
          <ProjectDefaultMcpTab target={target} access={owner} onManageMcp={onManageMcp} />
        </Provider>
      )
    );
    await settle();
    expect(container.textContent).toContain('No MCP servers are configured');
    const manage = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Manage MCP servers')
    )!;
    act(() => manage.click());
    expect(onManageMcp).toHaveBeenCalledTimes(1);
  });
});

it('uses loaded encrypted defaults offline while ordinary cloud composers still await remote catch-up', async () => {
  const workspace = createWorkspace('workspace-offline', catalogRows());
  Object.assign(workspace.runtime, {contentMode:'e2ee', accountId:'offline-owner'});
  store.set(runtimeAtom, workspace.runtime);
  const view = renderSelection({syncMode:'cloud', defaultsTarget:{project:projectA,machineId:'machine-1'}});
  expect(view.current().ready).toBe(false);
  workspace.open();
  await settle();
  expect(view.current()).toMatchObject({ready:true,selectedIds:['db','files']});
  Object.assign(workspace.runtime, {contentMode:'plaintext'});
  view.render({syncMode:'cloud', defaultsTarget:{project:projectA,machineId:'machine-1'}});
  expect(view.current().ready).toBe(false);
});
