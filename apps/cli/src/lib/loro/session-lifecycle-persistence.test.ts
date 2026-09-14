import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { createSqliteSessionLifecycleAdmissionStore } from './session-lifecycle-persistence';

const dirs: string[] = [];
const id = (value: string): SessionId => value as SessionId;

async function createStore(faults?: { beforeWrite?: () => void; afterCommit?: () => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-session-lifecycle-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'lifecycle.sqlite3');
  return {
    dbPath,
    store: await createSqliteSessionLifecycleAdmissionStore({
      workspaceId: 'workspace' as WorkspaceId,
      dbPath,
      faults,
    }),
  };
}

const draft = (operationId: string) => ({
  operationId,
  subjectId: id('root'),
  targetIds: [id('root'), id('child')],
  state: 'archived' as const,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('SQLite Session lifecycle admission store', () => {
  it('persists one immutable admission and recovers it after close/reopen', async () => {
    const { dbPath, store } = await createStore();
    const admitted = await store.admit(draft('op-1'), 'actor', '7');
    await store.close?.();
    const reopened = await createSqliteSessionLifecycleAdmissionStore({
      workspaceId: 'workspace' as WorkspaceId,
      dbPath,
    });
    expect(await reopened.get('op-1')).toEqual(admitted);
    await reopened.close?.();
  });

  it('serializes allocation across connections and advances above unpublished high-water', async () => {
    const { dbPath, store } = await createStore();
    const secondStore = await createSqliteSessionLifecycleAdmissionStore({
      workspaceId: 'workspace' as WorkspaceId,
      dbPath,
    });
    await store.observeCounter('20');
    const [first, second] = await Promise.all([
      store.admit(draft('first'), 'actor', '0'),
      secondStore.admit(draft('second'), 'actor', '0'),
    ]);
    expect(new Set([first.operation.order.counter, second.operation.order.counter])).toEqual(
      new Set(['21', '22'])
    );
    await secondStore.close?.();
    await store.close?.();

    const reopened = await createSqliteSessionLifecycleAdmissionStore({
      workspaceId: 'workspace' as WorkspaceId,
      dbPath,
    });
    const third = await reopened.admit(draft('third'), 'actor', '0');
    expect(third.operation.order.counter).toBe('23');
    await reopened.close?.();
  });

  it('distinguishes failure before a write from failure after durable commit', async () => {
    const before = await createStore({ beforeWrite: () => { throw new Error('before'); } });
    await expect(before.store.admit(draft('before'), 'actor', '0')).rejects.toThrow('before');
    expect(await before.store.get('before')).toBeUndefined();
    await before.store.close?.();

    const after = await createStore({ afterCommit: () => { throw new Error('after'); } });
    await expect(after.store.admit(draft('after'), 'actor', '0')).rejects.toThrow('after');
    expect((await after.store.get('after'))?.operation.operationId).toBe('after');
    await after.store.close?.();
  });

  it('marks publication without changing operation identity or order', async () => {
    const { store } = await createStore();
    const admitted = await store.admit(draft('op-1'), 'actor', '0');
    await store.markPublished('op-1');
    expect(await store.get('op-1')).toEqual({ ...admitted, published: true });
    await store.close?.();
  });
});
