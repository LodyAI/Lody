import { mkdtempSync, rmSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';
import {
  createFileQueueSteerOperationStore,
  type QueueSteerOperationMarker,
} from './session-queue-steer-operation-store';

const marker: QueueSteerOperationMarker = {
  version: 1,
  workspaceId: 'workspace-1',
  machineId: 'machine-1',
  sessionId: 'session-1',
  operationKey: '["session-1","assistant-1","C"]',
  queueItemId: 'C',
  expectedTurnId: 'assistant-1',
  userTurnId: 'user:C',
  phase: 'reserved',
  updatedAt: 1,
};

describe('file queue Steer operation store', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-queue-steer-operation-store-'));
    vi.stubEnv('HOME', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('atomically records, overwrites, reads, lists, and clears a session marker', async () => {
    const store = createFileQueueSteerOperationStore({
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
    });
    await store.record(marker);
    await expect(store.read('session-1' as SessionId)).resolves.toEqual(marker);

    const completed = {
      ...marker,
      phase: 'applied' as const,
      response: { disposition: 'accepted' as const, userTurnId: 'user:C' },
      completedAt: 2,
      updatedAt: 2,
    };
    await store.record(completed);
    await expect(store.list()).resolves.toEqual([completed]);

    const root = path.join(tempHome, '.lody', 'session-queue-steer-operations');
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await store.clear('session-1' as SessionId);
    await expect(store.read('session-1' as SessionId)).resolves.toBeNull();
  });

  it('ignores corrupt or unknown-version marker files', async () => {
    const store = createFileQueueSteerOperationStore({
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
    });
    await store.record(marker);
    const root = path.join(tempHome, '.lody', 'session-queue-steer-operations');
    await writeFile(path.join(root, 'corrupt.json'), 'not json', 'utf8');
    await writeFile(path.join(root, 'future.json'), JSON.stringify({ ...marker, version: 2 }));
    await expect(store.list()).resolves.toEqual([marker]);
  });
});
