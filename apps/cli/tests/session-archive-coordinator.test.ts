import { describe, expect, it } from 'vitest';
import type { MachineId, SessionId, SessionMeta, SessionArchiveRequest } from '@lody/shared';
import {
  SessionArchiveCoordinator,
  isSessionArchiveBusy,
} from '../src/session/session-archive-coordinator';

const machine = 'machine:archive-test' as MachineId;
const rootId = 'session:archive-root' as SessionId;
const childId = 'session:archive-child' as SessionId;
function fixture(requestPatch: Partial<SessionArchiveRequest> = {}) {
  const request: SessionArchiveRequest = {
    id: 'request-1',
    roots: [rootId],
    targets: [rootId, childId],
    source: 'manual',
    phase: 'waiting',
    generation: 1,
    heldSendIds: [],
    ...requestPatch,
  };
  const rows = new Map<SessionId, SessionMeta>([
    [
      rootId,
      {
        id: rootId,
        machineId: machine,
        archiveRequest: request,
        archivePending: { rootId, requestId: request.id },
      } as SessionMeta,
    ],
    [childId, { id: childId, machineId: machine, parentSessionId: rootId } as SessionMeta],
  ]);
  const busy = new Set<SessionId>();
  const fenced = new Set<SessionId>();
  const errors: unknown[] = [];
  let beforeWrite: ((id: SessionId, patch: Partial<SessionMeta>) => void) | undefined;
  const deps = {
    machineId: machine,
    list: async () => structuredClone([...rows.values()]),
    read: async (id: SessionId) => structuredClone(rows.get(id)),
    write: async (id: SessionId, patch: Partial<SessionMeta>) => {
      beforeWrite?.(id, patch);
      rows.set(id, { ...rows.get(id)!, ...structuredClone(patch) });
    },
    isBusy: async (session: SessionMeta) => busy.has(session.id),
    acquireFence: (id: SessionId) => {
      if (fenced.has(id)) return null;
      fenced.add(id);
      return () => {
        fenced.delete(id);
      };
    },
    watch: async () => () => {},
    wake: () => {},
    onError: (error: unknown) => errors.push(error),
  };
  return {
    rows,
    busy,
    fenced,
    errors,
    deps,
    coordinator: new SessionArchiveCoordinator(deps),
    beforeWrite: (fn: typeof beforeWrite) => {
      beforeWrite = fn;
    },
  };
}

describe('deferred group archive', () => {
  it('never interrupts late work during committed-request recovery', async () => {
    const f = fixture({ phase: 'committed' });
    f.rows.get(childId)!.archivePending = { rootId, requestId: 'request-1' };
    f.busy.add(childId);
    await f.coordinator.schedule();
    expect(f.rows.get(childId)?.isArchived).toBeUndefined();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('committed');
    f.busy.delete(childId);
    await f.coordinator.schedule();
    expect(f.rows.get(childId)?.isArchived).toBe(true);
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('completed');
    await f.coordinator.stop();
  });
  it('holds every nonempty queue, including entries not ready for promotion', async () => {
    for (const queue of [
      [{ ready: false }],
      [{ error: 'attachment pending' }],
      [{ scheduledAt: 1000 }],
    ]) {
      expect(
        await isSessionArchiveBusy({
          hasRuntimeWork: () => false,
          readQueue: async () => queue,
          hasActiveGoal: async () => false,
          readMeta: async () => ({ id: rootId }) as SessionMeta,
        })
      ).toBe(true);
    }
  });

  it('holds the promotion gap and idle-status finalization until runtime release', async () => {
    let active = false;
    const ports = {
      hasRuntimeWork: () => active,
      readQueue: async () => {
        active = true;
        return [];
      },
      hasActiveGoal: async () => false,
      readMeta: async () => ({ id: rootId, status: { type: 'idle' } }) as SessionMeta,
    };
    expect(await isSessionArchiveBusy(ports)).toBe(true);
    active = false;
    ports.readQueue = async () => [];
    expect(await isSessionArchiveBusy(ports)).toBe(false);
    ports.readMeta = async () => ({ id: rootId, latestUserMsgId: 'queued-turn' }) as SessionMeta;
    expect(await isSessionArchiveBusy(ports)).toBe(true);
  });

  it('holds resumable active Goals and unknown metadata', async () => {
    const ports = {
      hasRuntimeWork: () => false,
      readQueue: async () => [],
      hasActiveGoal: async () => true,
      readMeta: async () => undefined,
    };
    expect(await isSessionArchiveBusy(ports)).toBe(true);
    ports.hasActiveGoal = async () => false;
    expect(await isSessionArchiveBusy(ports)).toBe(true);
  });
  it('keeps the whole group visible until every owner settles', async () => {
    const f = fixture();
    f.busy.add(childId);
    await f.coordinator.schedule();
    expect([...f.rows.values()].every((row) => !row.isArchived)).toBe(true);
    expect(f.rows.get(childId)?.archiveReadiness?.state).toBe('busy');
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('waiting');
    f.busy.delete(childId);
    await f.coordinator.schedule();
    expect([...f.rows.values()].every((row) => row.isArchived)).toBe(true);
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('completed');
    expect(f.fenced.size).toBe(0);
    expect(f.errors).toEqual([]);
    await f.coordinator.stop();
  });

  it('holds attachment sends across restart until their explicit release', async () => {
    const f = fixture({ heldSendIds: ['upload-1'] });
    await f.coordinator.schedule();
    await f.coordinator.stop();
    const restarted = new SessionArchiveCoordinator(f.deps);
    await restarted.schedule();
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    f.rows.get(rootId)!.archiveRequest!.heldSendIds = [];
    await restarted.schedule();
    expect(f.rows.get(childId)?.isArchived).toBe(true);
    await restarted.stop();
  });

  it('does not infer an offline owner is idle', async () => {
    const f = fixture();
    f.rows.get(childId)!.machineId = 'machine:offline' as MachineId;
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('waiting');
    expect(f.rows.get(rootId)?.isArchived).toBeUndefined();
    await f.coordinator.stop();
  });

  it('rechecks work after acquiring the execution fence', async () => {
    const f = fixture();
    const acquire = f.deps.acquireFence;
    f.deps.acquireFence = (id) => {
      const release = acquire(id);
      if (id === childId) f.busy.add(childId);
      return release;
    };
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('waiting');
    expect(f.rows.get(rootId)?.archiveRequest?.generation).toBe(2);
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    expect(f.fenced.size).toBe(0);
    await f.coordinator.stop();
  });

  it('cancellation survives stale request-object writes', async () => {
    const f = fixture();
    f.busy.add(childId);
    await f.coordinator.schedule();
    const stale = structuredClone(f.rows.get(rootId)!.archiveRequest!);
    f.rows.get(rootId)!.archiveCancelledRequestId = stale.id;
    f.rows.get(rootId)!.archiveRequest = stale;
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('cancelled');
    expect(f.rows.get(childId)?.archivePending).toBeNull();
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    await f.coordinator.stop();
  });

  it('includes descendants created while waiting', async () => {
    const f = fixture();
    f.busy.add(childId);
    await f.coordinator.schedule();
    const newId = 'session:new-descendant' as SessionId;
    f.rows.set(newId, { id: newId, machineId: machine, openedBySessionId: childId } as SessionMeta);
    f.busy.add(newId);
    f.busy.delete(childId);
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.targets).toContain(newId);
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    f.busy.delete(newId);
    await f.coordinator.schedule();
    expect([...f.rows.values()].every((row) => row.isArchived)).toBe(true);
    await f.coordinator.stop();
  });

  it('cancels automatic archive when PR evidence changes', async () => {
    const f = fixture({
      source: 'pr',
      pr: { url: 'https://example.test/pull/1', status: 'merged' },
    });
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('cancelled');
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    await f.coordinator.stop();
  });

  it('cancels when a newer PR replaces the still-merged triggering PR', async () => {
    const f = fixture({
      source: 'pr',
      pr: { url: 'https://example.test/pull/1', status: 'merged' },
    });
    f.rows.get(rootId)!.pullRequests = [
      { url: 'https://example.test/pull/1', status: 'merged' },
      { url: 'https://example.test/pull/2', status: 'open' },
    ] as SessionMeta['pullRequests'];
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('cancelled');
    expect([...f.rows.values()].some((row) => row.isArchived)).toBe(false);
    await f.coordinator.stop();
  });

  it('recovers a durable commit after partial metadata write failure', async () => {
    const f = fixture();
    f.beforeWrite((id, patch) => {
      if (id === childId && patch.isArchived) throw new Error('disk interrupted');
    });
    await f.coordinator.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('committed');
    expect(f.rows.get(childId)?.isArchived).toBeUndefined();
    await f.coordinator.stop();
    f.beforeWrite(undefined);
    const restarted = new SessionArchiveCoordinator(f.deps);
    await restarted.schedule();
    expect(f.rows.get(rootId)?.archiveRequest?.phase).toBe('completed');
    expect(f.rows.get(childId)?.isArchived).toBe(true);
    await restarted.stop();
  });
});
