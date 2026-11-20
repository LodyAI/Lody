import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import { getSessionRoomId, getWorkspaceFlockDocId, type WorkspaceId } from '@lody/shared';
import { connectNativeRepo, nativeRepoDataDir } from '@lody/shared/node/native-repo';
import { bindTestPresenceApplication } from './presence-application-fixture';
import {
  applyLocalPlatformEnv,
  ensureImplicitLocalWorkspace,
  loadOrCreateLocalIdentity,
} from '../src/lib/cli-platform';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { listAliveRoomIds } from '../src/lib/loro/repo-existence';
import { makeLocalWorkspaceCatalog } from '../src/lib/local-workspace-catalog';
import type { Logger } from '../src/utils/logger';

const logger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => logger(),
  close: async () => {},
});

// The test pre-opens the process-wide connection with the shared host fixture;
// the daemon composition then reuses it exactly as it reuses its own.
const hostScript = fileURLToPath(
  new URL('../../../packages/shared/tests/fixtures/native-repo-host.mjs', import.meta.url)
);

describe('native Workspace Meta in the CLI daemon', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let presence: ReturnType<typeof bindTestPresenceApplication>;
  beforeEach(async () => {
    presence = bindTestPresenceApplication(logger());
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-native-meta-daemon-'));
    process.env.LODY_PLATFORM = 'local';
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody-oss');
    applyLocalPlatformEnv();
  });
  afterEach(async () => {
    await presence.closeLegacy();
    const engine = path.join(nativeRepoDataDir(), 'engine.json');
    const pid = await fs
      .readFile(engine, 'utf8')
      .then((raw) => (JSON.parse(raw) as { pid: number }).pid)
      .catch(() => undefined);
    if (pid) {
      process.kill(pid, 'SIGTERM');
      while (
        (() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })()
      )
        await new Promise((resolve) => setImmediate(resolve));
    }
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const open = async (workspace: { id: string }, userId: string) => {
    const workspaceId = workspace.id as WorkspaceId;
    const cloudPort = createLocalCloudPort({
      identity: { userId },
      workspaces: [workspace as never],
    });
    const manager = await LoroDocumentManager.create(workspaceId, userId, logger(), {
      streamsTokens: cloudPort.streamsTokens,
      cloudBilling: cloudPort.billing,
    });
    return {
      manager,
      close: async () => {
        await manager.cleanUp({ fast: false, preserveSessionStatus: true });
        await cloudPort.dispose();
      },
    };
  };

  it('migrates legacy Meta, keeps native state across restarts and writes it back when disabled', async () => {
    const identity = await loadOrCreateLocalIdentity(logger());
    const workspace = await ensureImplicitLocalWorkspace({
      catalog: makeLocalWorkspaceCatalog({
        filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
        lockName: `native-meta-${process.pid}`,
        cacheTtlMs: Number.POSITIVE_INFINITY,
      }),
      identity,
      machineId: 'local-machine',
      machineName: 'local-host',
      logger: logger(),
    });

    // Before enabling: an ordinary legacy daemon writes Meta to SQLite.
    const legacy = await open(workspace, identity.userId);
    const kept = await legacy.manager.createSession('local-machine', 'builtin', 'claude');
    const removed = await legacy.manager.createSession('local-machine', 'builtin', 'claude');
    await legacy.manager.repo.upsertDocMeta(getSessionRoomId(kept), { title: 'kept' });
    const catalogId = getWorkspaceFlockDocId(workspace.id as WorkspaceId);
    const catalog = async (manager: LoroDocumentManager) =>
      (await manager.repo.openFlockDoc(catalogId)).flock;
    const putRow = async (manager: LoroDocumentManager, key: string[], value: unknown) => {
      const flock = await catalog(manager);
      flock.put(key, value as never);
      await manager.repo.persistFlockDocNow(catalogId, flock);
    };
    await putRow(legacy.manager, ['mcpServer', 'legacy'], { name: 'legacy' });
    await legacy.manager.repo.deleteDoc(getSessionRoomId(removed));
    await legacy.close();

    process.env.LODY_NATIVE_WORKSPACE_META = '1';
    const connection = await connectNativeRepo({
      launcher: () => ({ command: process.execPath, args: [hostScript] }),
    });
    const daemon = await open(workspace, identity.userId);
    try {
      expect(daemon.manager.repo.metadataMode).toBe('external');
      expect((await daemon.manager.repo.getDocMeta(getSessionRoomId(kept)))?.meta).toMatchObject({
        title: 'kept',
      });
      expect((await daemon.manager.repo.getDocMeta(getSessionRoomId(removed)))?.deleted).toBe(true);
      expect(await listAliveRoomIds(daemon.manager, (id) => id.startsWith('session-'))).toEqual([
        getSessionRoomId(kept),
      ]);

      await daemon.manager.repo.upsertDocMeta(getSessionRoomId(kept), { title: 'renamed' });
      // The workspace catalog is migrated and owned natively too.
      expect((await catalog(daemon.manager)).get(['mcpServer', 'legacy'])).toEqual({
        name: 'legacy',
      });
      await putRow(daemon.manager, ['mcpServer', 'native'], { name: 'native' });
    } finally {
      await daemon.close();
    }
    // A restart reads native state; the published legacy source is not re-imported.
    const restarted = await open(workspace, identity.userId);
    let nativeOnly: string;
    try {
      expect((await restarted.manager.repo.getDocMeta(getSessionRoomId(kept)))?.meta.title).toBe(
        'renamed'
      );
      nativeOnly = await restarted.manager.createSession('local-machine', 'builtin', 'claude');
    } finally {
      await restarted.close();
    }

    // Flag off: native edits are written back into the legacy replica.
    delete process.env.LODY_NATIVE_WORKSPACE_META;
    const legacyAgain = await open(workspace, identity.userId);
    try {
      expect(legacyAgain.manager.repo.metadataMode).toBe('legacy');
      expect((await legacyAgain.manager.repo.getDocMeta(getSessionRoomId(kept)))?.meta.title).toBe(
        'renamed'
      );
      expect(
        (await legacyAgain.manager.repo.getDocMeta(getSessionRoomId(nativeOnly)))?.deleted
      ).toBe(false);
      expect((await catalog(legacyAgain.manager)).get(['mcpServer', 'native'])).toEqual({
        name: 'native',
      });
      await legacyAgain.manager.repo.upsertDocMeta(getSessionRoomId(kept), { title: 'offline' });
      await putRow(legacyAgain.manager, ['mcpServer', 'offline'], { name: 'offline' });
    } finally {
      await legacyAgain.close();
    }

    // Flag on again: the replica's newer edits merge back into native.
    process.env.LODY_NATIVE_WORKSPACE_META = '1';
    const nativeAgain = await open(workspace, identity.userId);
    try {
      expect((await nativeAgain.manager.repo.getDocMeta(getSessionRoomId(kept)))?.meta.title).toBe(
        'offline'
      );
      expect((await catalog(nativeAgain.manager)).get(['mcpServer', 'offline'])).toEqual({
        name: 'offline',
      });
    } finally {
      await nativeAgain.close();
      await connection.close();
    }
  });
});
