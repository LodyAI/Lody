import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  getProjectMcpKey,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  acquireWorkspaceCatalog,
  retryWorkspaceCatalog,
  type WorkspaceCatalogSnapshot,
} from '../src/lib/workspace-catalog-room';

const entry = (id: string, name: string): WorkspaceMcpServerMeta => ({
  id: id as WorkspaceMcpServerMeta['id'],
  name,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'mcp-files' },
  createdAt: 1,
  updatedAt: 1,
});

const roleRow = (id: string, name: string): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: id as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name,
  mentionSlug: name.toLowerCase(),
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});

// The room's startup is a chain of awaits on already-resolved promises, so
// draining microtasks settles it deterministically — no timers, no wall clock.
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
};

/**
 * Minimal stand-in for the workspace runtime: one Flock document whose rows,
 * events, and first remote sync are driven by the test rather than a transport.
 */
function createRuntime(
  workspaceId: string,
  rows: WorkspaceMcpServerMeta[],
  roles: AgentRole[] = [],
  projectDefaults: Record<string, { ids: string[] }> = {}
) {
  const listeners: Array<(batch: unknown) => void> = [];
  let completeFirstSync!: () => void;
  const firstSyncedWithRemote = new Promise<void>((resolve) => {
    completeFirstSync = resolve;
  });
  const unsubscribeRoom = vi.fn();
  const current = [...rows];

  const flock = {
    scan: (options?: { prefix?: readonly unknown[] }) =>
      options?.prefix?.[0] === 'agentRole'
        ? roles.map((value) => ({ key: workspaceFlockKeys.agentRole(value.id), value }))
        : options?.prefix?.[0] === 'projectMcpDefault'
          ? Object.entries(projectDefaults).map(([projectKey, value]) => ({
              key: workspaceFlockKeys.projectMcpDefault(projectKey),
              value,
            }))
          : current.map((value) => ({ key: workspaceFlockKeys.mcpServer(value.id), value })),
    subscribe: (listener: (batch: unknown) => void) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  };
  const joinRoom = vi.fn(async () => ({ unsubscribe: unsubscribeRoom, firstSyncedWithRemote }));
  const openFlockDoc = vi.fn(async () => ({ flock, joinRoom }));

  return {
    runtime: { workspaceId, repo: { openFlockDoc } } as unknown as WorkspaceRuntime,
    openFlockDoc,
    joinRoom,
    unsubscribeRoom,
    subscriberCount: () => listeners.length,
    emit: (value: WorkspaceMcpServerMeta) => {
      current.push(value);
      for (const listener of listeners) {
        listener({ events: [{ key: workspaceFlockKeys.mcpServer(value.id), value }] });
      }
    },
    completeFirstSync: () => completeFirstSync(),
  };
}

describe('workspace MCP catalog room', () => {
  it('opens one document, subscription, and room for every consumer of a workspace', async () => {
    const harness = createRuntime('workspace-shared', [entry('server-1', 'Files')]);
    const first: WorkspaceCatalogSnapshot[] = [];
    const second: WorkspaceCatalogSnapshot[] = [];

    const leaseA = acquireWorkspaceCatalog(harness.runtime, (snapshot) => first.push(snapshot));
    const leaseB = acquireWorkspaceCatalog(harness.runtime, (snapshot) => second.push(snapshot));
    await settle();

    expect(harness.openFlockDoc).toHaveBeenCalledTimes(1);
    expect(harness.joinRoom).toHaveBeenCalledTimes(1);
    expect(harness.subscriberCount()).toBe(1);

    // Both consumers get the same snapshot object, so a memo keyed on it holds
    // across every surface that mounted the catalog.
    expect(first.at(-1)?.servers.map(({ name }) => name)).toEqual(['Files']);
    expect(second.at(-1)).toBe(first.at(-1));

    leaseA.release();
    leaseB.release();
  });

  it('keeps the room alive until the last consumer releases', async () => {
    const harness = createRuntime('workspace-refcount', [entry('server-1', 'Files')]);
    const leaseA = acquireWorkspaceCatalog(harness.runtime, vi.fn());
    const leaseB = acquireWorkspaceCatalog(harness.runtime, vi.fn());
    await settle();

    leaseA.release();
    expect(harness.unsubscribeRoom).not.toHaveBeenCalled();
    expect(harness.subscriberCount()).toBe(1);

    leaseB.release();
    expect(harness.unsubscribeRoom).toHaveBeenCalledTimes(1);
    expect(harness.subscriberCount()).toBe(0);
  });

  it('publishes flock events and the authoritative post-sync read to every consumer', async () => {
    const harness = createRuntime('workspace-events', [entry('server-1', 'Files')]);
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();
    expect(seen.at(-1)?.synced).toBe(false);

    harness.emit(entry('server-2', 'Ada'));
    expect(seen.at(-1)?.servers.map(({ name }) => name)).toEqual(['Ada', 'Files']);

    harness.completeFirstSync();
    await settle();
    expect(seen.at(-1)?.synced).toBe(true);
    expect(seen.at(-1)?.servers.map(({ name }) => name)).toEqual(['Ada', 'Files']);

    lease.release();
  });

  it('publishes both row families of the one workspace document', async () => {
    const harness = createRuntime(
      'workspace-families',
      [entry('server-1', 'Files')],
      [roleRow('role-1', 'Reviewer')]
    );
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();

    // One document, one room: a second room for Roles would open the same doc.
    expect(harness.openFlockDoc).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.servers.map(({ name }) => name)).toEqual(['Files']);
    expect(seen.at(-1)?.roles.map(({ name }) => name)).toEqual(['Reviewer']);

    lease.release();
  });

  it('publishes project defaults once the local document is read', async () => {
    const projectKey = getProjectMcpKey(
      { kind: 'local', localProjectId: 'project-1' as LocalProjectId },
      'machine-1'
    )!;
    const harness = createRuntime('workspace-project-defaults', [entry('server-1', 'Files')], [], {
      [projectKey]: { ids: [] },
    });
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    // Nothing read yet: defaults are unknown, not empty.
    expect(lease.snapshot.loaded).toBe(false);
    await settle();

    expect(seen.at(-1)).toMatchObject({ loaded: true, failed: false, synced: false });
    expect(seen.at(-1)?.projectMcpDefaults).toEqual({ [projectKey]: { ids: [] } });

    // An MCP-only change keeps the defaults record's identity.
    const defaults = seen.at(-1)?.projectMcpDefaults;
    harness.emit(entry('server-2', 'Ada'));
    expect(seen.at(-1)?.projectMcpDefaults).toBe(defaults);

    lease.release();
  });

  it('reports a document that could not be read as failed, never as an empty catalog', async () => {
    const harness = createRuntime('workspace-unreadable', [entry('server-1', 'Files')]);
    harness.openFlockDoc.mockRejectedValueOnce(new Error('storage unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();

    expect(seen.at(-1)).toMatchObject({ loaded: false, failed: true });
    lease.release();
    error.mockRestore();
  });
});

it('shares capped retries, recovers every consumer and keeps another workspace usable', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failed = createRuntime('failed', [entry('files', 'Files')]);
  const healthy = createRuntime('healthy', [entry('other', 'Other')]);
  const open = failed.openFlockDoc.getMockImplementation()!;
  failed.openFlockDoc.mockRejectedValue(new Error('storage unavailable'));
  const seen: WorkspaceCatalogSnapshot[] = [];
  const other: WorkspaceCatalogSnapshot[] = [];
  const a = acquireWorkspaceCatalog(failed.runtime, (snapshot) => seen.push(snapshot));
  const b = acquireWorkspaceCatalog(failed.runtime, (snapshot) => other.push(snapshot));
  const independent = acquireWorkspaceCatalog(healthy.runtime, (snapshot) => {
    expect(snapshot.loaded).toBe(true);
  });
  try {
    await settle();
    expect(seen.at(-1)).toMatchObject({ loaded: false, failed: true });
    expect(healthy.subscriberCount()).toBe(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = failed.openFlockDoc.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(failed.openFlockDoc.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(failed.openFlockDoc.mock.calls.length).toBe(before + 1);
    }
    failed.openFlockDoc.mockImplementation(open);
    await vi.advanceTimersByTimeAsync(30000);
    expect(seen.at(-1)).toMatchObject({ loaded: true, failed: false });
    expect(seen.at(-1)?.servers.map(({ id }) => id)).toEqual(['files']);
    expect(other.at(-1)).toBe(seen.at(-1));
    expect(failed.subscriberCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    a.release();
    b.release();
    independent.release();
    log.mockRestore();
    vi.useRealTimers();
  }
});

it('shares an explicit retry and cancels retries when the last consumer leaves', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const harness = createRuntime('manual', [entry('files', 'Files')]);
  const open = harness.openFlockDoc.getMockImplementation()!;
  harness.openFlockDoc.mockRejectedValue(new Error('storage unavailable'));
  const seen: WorkspaceCatalogSnapshot[] = [];
  const a = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
  try {
    await settle();
    retryWorkspaceCatalog(harness.runtime);
    retryWorkspaceCatalog(harness.runtime);
    await settle();
    expect(seen.at(-1)).toMatchObject({ failed: true, loaded: false });
    expect(harness.openFlockDoc.mock.calls.length).toBe(2);
    a.release();
    expect(vi.getTimerCount()).toBe(0);
    harness.openFlockDoc.mockImplementation(open);
    const b = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();
    expect(seen.at(-1)).toMatchObject({ loaded: true, failed: false });
    b.release();
  } finally {
    a.release();
    log.mockRestore();
    vi.useRealTimers();
  }
});
