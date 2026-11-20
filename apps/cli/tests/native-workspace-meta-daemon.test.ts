import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import {
  createHistoryWriter,
  type SessionHistory,
  getMachineFlockDocId,
  getScheduleRegistryFlockDocId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { connectNativeRepo, nativeRepoDataDir } from '@lody/shared/node/native-repo';
import { createNativeRemoteHistoryPort } from '@lody/shared/node/native-docs';
import { createRemoteHistoryCommands } from '@lody/shared/session-data';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
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
    // Every owned named Flock document: workspace catalog, a machine Flock, schedule registry.
    const wsId = workspace.id as WorkspaceId;
    const ownedIds = [
      getWorkspaceFlockDocId(wsId),
      getMachineFlockDocId(wsId, 'local-machine' as MachineId),
      getScheduleRegistryFlockDocId(wsId),
    ];
    const rows = async (manager: LoroDocumentManager, key: string[]) =>
      Promise.all(ownedIds.map(async (id) => (await manager.repo.openFlockDoc(id)).flock.get(key)));
    const putRow = async (manager: LoroDocumentManager, key: string[], value: unknown) => {
      for (const id of ownedIds) {
        const flock = (await manager.repo.openFlockDoc(id)).flock;
        flock.put(key, value as never);
        await manager.repo.persistFlockDocNow(id, flock);
      }
    };
    const everywhere = (value: unknown) => ownedIds.map(() => value);
    const newMachineId = getMachineFlockDocId(wsId, 'native-machine' as MachineId);
    await putRow(legacy.manager, ['mcpServer', 'legacy'], { name: 'legacy' });
    // Session bodies: turns appended through the one HistoryWriter.
    const sessionDoc = getSessionRoomId(kept);
    const turns = async (manager: LoroDocumentManager) =>
      (await manager.repo.openPersistedDoc(sessionDoc)).doc
        .getList('history')
        .toJSON()
        .map((turn: { id: string }) => turn.id);
    const appendTurn = async (manager: LoroDocumentManager, id: string) => {
      const { doc } = await manager.repo.openPersistedDoc(sessionDoc);
      createHistoryWriter(doc).append({
        id,
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        items: [{ type: 'text', text: id }],
        fileDiff: [],
      } as SessionHistory);
      await manager.repo.persistDocNow(sessionDoc, doc);
    };
    await appendTurn(legacy.manager, 'legacy-turn');
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
      expect(await rows(daemon.manager, ['mcpServer', 'legacy'])).toEqual(
        everywhere({ name: 'legacy' })
      );
      await putRow(daemon.manager, ['mcpServer', 'native'], { name: 'native' });
      // The session body migrates on first open and accepts native turns.
      expect(await turns(daemon.manager)).toEqual(['legacy-turn']);
      await appendTurn(daemon.manager, 'native-turn');
      // A machine first seen in native mode exists only in the native room.
      const created = (await daemon.manager.repo.openFlockDoc(newMachineId)).flock;
      created.put(['machine'], 'new');
      await daemon.manager.repo.persistFlockDocNow(newMachineId, created);
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
      expect(await rows(legacyAgain.manager, ['mcpServer', 'native'])).toEqual(
        everywhere({ name: 'native' })
      );
      expect(
        (await legacyAgain.manager.repo.openFlockDoc(newMachineId)).flock.get(['machine'])
      ).toBe('new');
      await legacyAgain.manager.repo.upsertDocMeta(getSessionRoomId(kept), { title: 'offline' });
      await putRow(legacyAgain.manager, ['mcpServer', 'offline'], { name: 'offline' });
      expect(await turns(legacyAgain.manager)).toEqual(['legacy-turn', 'native-turn']);
      await appendTurn(legacyAgain.manager, 'offline-turn');
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
      expect(await turns(nativeAgain.manager)).toEqual([
        'legacy-turn',
        'native-turn',
        'offline-turn',
      ]);
      expect(await rows(nativeAgain.manager, ['mcpServer', 'offline'])).toEqual(
        everywhere({ name: 'offline' })
      );
    } finally {
      await nativeAgain.close();
      await connection.close();
    }
  });

  it("commits the daemon's reply after a renderer's follow-up turn it reacts to", async () => {
    const identity = await loadOrCreateLocalIdentity(logger());
    const workspace = await ensureImplicitLocalWorkspace({
      catalog: makeLocalWorkspaceCatalog({
        filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
        lockName: `native-meta-reply-${process.pid}`,
        cacheTtlMs: Number.POSITIVE_INFINITY,
      }),
      identity,
      machineId: 'local-machine',
      machineName: 'local-host',
      logger: logger(),
    });
    process.env.LODY_NATIVE_WORKSPACE_META = '1';
    const connection = await connectNativeRepo({
      launcher: () => ({ command: process.execPath, args: [hostScript] }),
    });
    const renderer = await connectEngine(nativeRepoDataDir(), { queueWhileReconnecting: false });
    const daemon = await open(workspace, identity.userId);
    try {
      const sessionId = await daemon.manager.createSession('local-machine', 'builtin', 'claude');
      const roomId = getSessionRoomId(sessionId);
      // The execution replica: auto-seen reacts to each arriving user turn.
      const sessionDoc = await daemon.manager.getOrCreateSessionDoc(sessionId);
      const port = createNativeRemoteHistoryPort(renderer, workspace.id, roomId);
      const userTurn = (id: string) =>
        ({
          id,
          role: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          status: 'pending',
          userId: identity.userId,
          items: [{ type: 'text', text: id }],
          fileDiff: [],
        }) as never;
      const reply = async (userTurnId: string) => {
        while (sessionDoc.sessionData.history.readDirectory(0, 99).at(-1)?.turnId !== userTurnId)
          await new Promise((resolve) => setImmediate(resolve));
        await sessionDoc.sessionData.commands.appendTurn({
          id: `assistant:${userTurnId}`,
          role: 'assistant',
          userTurnId,
          timestamp: '2026-01-01T00:00:01Z',
          finished: true,
          items: [{ type: 'text', text: `reply to ${userTurnId}` }],
          fileDiff: [],
        } as never);
        await daemon.manager.repo.flush();
      };
      for (const id of ['first', 'follow-up']) {
        await createRemoteHistoryCommands(port).appendTurn(userTurn(id));
        await reply(id);
      }
      // The engine holds every reply, not only the first one.
      const stored = (await port.readPath(['history'])) as { id: string }[];
      expect(stored.map((turn) => turn.id)).toEqual([
        'first',
        'assistant:first',
        'follow-up',
        'assistant:follow-up',
      ]);
    } finally {
      await daemon.close();
      await renderer.close();
      await connection.close();
    }
  });
});
