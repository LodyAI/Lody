import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  createFileSessionForkOperationStore,
  type SessionForkOperationMarker,
} from './session-fork-operation-store';

const marker: SessionForkOperationMarker = {
  version: 1,
  workspaceId: 'workspace-1',
  machineId: 'machine-1',
  targetSessionId: 'target-session',
  operationId: 'session-fork:target-session',
  createdAt: '2026-08-16T00:00:00.000Z',
  title: '(fork) Original',
  cleanup: {
    project: { kind: 'local', localProjectId: 'local-project-1' as never },
    branch: 'main',
    workdir: '/source/project-root',
    requesterUserId: 'user-1',
    agentConfigId: 'agent-config-1',
    cliType: 'builtin',
    agentType: 'codex',
  },
};

describe('file session fork operation store', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-fork-operation-store-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('records and lists markers', async () => {
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    expect(await store.list()).toEqual([marker]);
  });

  it('isolates same-worktree markers by installation while preserving legacy worktree discovery', async () => {
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    const firstRoot = path.join(tempHome, 'first-installation');
    vi.stubEnv('LODY_DATA_DIR', firstRoot);
    const same = {
      kind: 'same-worktree' as const,
      version: 1 as const,
      workspaceId: marker.workspaceId,
      machineId: marker.machineId,
      targetSessionId: 'same-target',
      operationId: 'unique-attempt',
      createdAt: marker.createdAt,
      title: marker.title,
      accountProfileId: 'system-default',
    };
    await store.record(same);
    expect(await store.read('same-target' as SessionId, 'same-worktree')).toEqual(same);
    vi.stubEnv('LODY_DATA_DIR', path.join(tempHome, 'second-installation'));
    expect(await store.list()).toEqual([marker]);
    expect(await store.read('same-target' as SessionId, 'same-worktree')).toBeNull();
    await store.clear('same-target' as SessionId, 'same-worktree');
    vi.stubEnv('LODY_DATA_DIR', firstRoot);
    expect(await store.read('same-target' as SessionId, 'same-worktree')).toEqual(same);
  });

  it('does not read or clear a different marker kind when roots coincide', async () => {
    vi.stubEnv('LODY_DATA_DIR', path.join(tempHome, '.lody'));
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    expect(await store.read(marker.targetSessionId as SessionId, 'same-worktree')).toBeNull();
    await store.clear(marker.targetSessionId as SessionId, 'same-worktree');
    expect(await store.read(marker.targetSessionId as SessionId)).toEqual(marker);
  });

  it('overwrites the marker for the same target session', async () => {
    const store = createFileSessionForkOperationStore();
    const retried = { ...marker, operationId: 'session-fork:target-session-retry' };
    await store.record(marker);
    await store.record(retried);
    expect(await store.list()).toEqual([retried]);
  });

  it('skips corrupt entries instead of failing the listing', async () => {
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    const root = path.join(tempHome, '.lody', 'session-fork-operations');
    await writeFile(path.join(root, 'corrupt.json'), 'not json', 'utf8');
    await writeFile(path.join(root, 'wrong-shape.json'), JSON.stringify({ version: 2 }), 'utf8');
    expect(await store.list()).toEqual([marker]);
  });

  it('clears markers and tolerates missing files', async () => {
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    await store.clear('target-session' as SessionId);
    expect(await store.list()).toEqual([]);
    await store.clear('target-session' as SessionId);
  });

  it('reads a single marker back and returns null for unknown targets', async () => {
    const store = createFileSessionForkOperationStore();
    await store.record(marker);
    expect(await store.read('target-session' as SessionId)).toEqual(marker);
    expect(await store.read('unknown-session' as SessionId)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'creates the store root with owner-only POSIX permissions',
    async () => {
      const store = createFileSessionForkOperationStore();
      await store.record(marker);
      const root = path.join(tempHome, '.lody', 'session-fork-operations');
      const { stat } = await import('node:fs/promises');
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
  );

  it('lists nothing when the store directory does not exist', async () => {
    expect(await createFileSessionForkOperationStore().list()).toEqual([]);
  });
});
