import { openMemoryDocument } from '@lody/memory/loro';
import { Effect, Layer } from 'effect';
import type { TransportAdapter, StorageAdapter } from 'loro-repo';
import { LocalLoroTransportAdapter } from '../../../packages/shared/src/local-loro-transport';
import { LocalLoroDataPlaneServerLegacy } from '../../../packages/shared/src/local-loro-data-plane-server';
import type {
  LocalLoroDataPlaneServerMessage,
  LocalLoroDataPlaneClientMessage,
} from '../../../packages/shared/src/local-loro-data-plane';
import { LocalLoroWriterTurn } from '../../../packages/shared/src/local-loro-writer';
import { makeLocalLoroWriterLegacy } from '../../../packages/shared/src/local-loro-writer/legacy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { McpServer } from '@modelcontextprotocol/server';
import { createPersonalMemoryRepository } from '@lody/memory/repo';
import {
  authorizePersonalMemoryRole,
  BUILTIN_MEMORY_BINDING,
  personalMemoryRoleFromRoom,
  personalMemoryRoomId,
} from '@lody/memory';
import {
  createSessionToolRegistrar,
  type SessionToolHandlers,
} from '../src/mcp/session-tool-router';
import { registerMemoryTools } from '../src/mcp/memory-tools';

const context = { changeId: 'initial', recordedAt: 1, source: { actor: 'user' as const } };
const cleanups: (() => Promise<unknown>)[] = [];
const networkRequests: unknown[] = [];
beforeEach(() => {
  networkRequests.length = 0;
  vi.stubGlobal('fetch', (input: unknown) => {
    networkRequests.push(input);
    throw new Error('network_unavailable');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(networkRequests).toEqual([]);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-memory-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const open = async (
    ownerId = 'alice',
    workspace = 'local',
    options: {
      localTransport?: TransportAdapter;
      storage?: (storage: StorageAdapter) => StorageAdapter;
    } = {}
  ) => {
    const store = new SqliteRepoStore({
      path: path.join(directory, `${workspace}-${ownerId}.sqlite3`),
    });
    const repo = await createPersonalMemoryRepository({
      ownerId,
      storage: options.storage?.(store.storage) ?? store.storage,
      localTransport: options.localTransport,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      await repo.close();
      store.close();
      closed = true;
    };
    cleanups.push(close);
    return { repo, close, storage: store.storage };
  };
  return { open };
}

describe('personal memory host', () => {
  it('saves offline, restores after closing SQLite, and isolates people, Roles and workspaces', async () => {
    const { open } = await fixture();
    const first = await open();
    const a = await first.repo.open('role-a', context);
    const saved = await a.save(
      a.memory.create(
        { path: 'preferences.md', body: 'Prefer quiet rooms', description: 'Travel' },
        { ...context, changeId: 'write' }
      )
    );
    expect(saved).toMatchObject({
      ok: true,
      value: { local: 'saved', sync: { state: 'unavailable' } },
    });
    // Check the SQLite copy before shutdown can perform its own final flush.
    const disk = await first.storage.loadDoc(personalMemoryRoomId('alice', 'role-a'));
    expect(disk).toBeTruthy();
    const persisted = openMemoryDocument(disk!, {
      ownership: 'personal',
      ownerId: 'alice',
      roleId: 'role-a',
      memoryId: 'role-a',
    });
    expect(persisted.ok && persisted.value.read({ path: 'preferences.md' })).toMatchObject({
      ok: true,
      value: { body: 'Prefer quiet rooms' },
    });
    disk!.free();
    await a.release();
    await first.close();
    const restarted = await open();
    const restored = await restarted.repo.open('role-a', context);
    expect(restored.memory.read({ path: 'preferences.md' })).toMatchObject({
      ok: true,
      value: { body: 'Prefer quiet rooms' },
    });
    expect(restored.memory.provenance('preferences.md', {})).toMatchObject({
      ok: true,
      value: { items: [{ changeId: 'write', source: { actor: 'user' } }] },
    });
    const otherRole = await restarted.repo.open('role-b', context);
    const otherPerson = await (await open('bob')).repo.open('role-a', context);
    const otherWorkspace = await (await open('alice', 'other')).repo.open('role-a', context);
    for (const memory of [otherRole, otherPerson, otherWorkspace]) {
      expect(memory.memory.search({ query: 'quiet' })).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      expect(memory.memory.read({ path: 'preferences.md' })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      await memory.release();
    }
    await restored.release();
  });

  it('uses active invocation scope, refuses forged arguments, and applies live revocation', async () => {
    const { open } = await fixture();
    const { repo } = await open();
    let roleId: string | null = 'role-a';
    let requesterUserId = 'alice';
    let liveBinding: typeof BUILTIN_MEMORY_BINDING | undefined = BUILTIN_MEMORY_BINDING;
    const handlers: SessionToolHandlers = new Map();
    const server = new McpServer({ name: 'memory-test', version: '1' });
    cleanups.push(() => server.close());
    registerMemoryTools(
      createSessionToolRegistrar(server, (_name, _args, execute) => execute(), handlers),
      async () => ({
        sessionId: 'session-one',
        turnId: 'turn-one',
        open: () =>
          repo.open(
            authorizePersonalMemoryRole({
              ownerId: 'alice',
              requesterUserId,
              roleId,
              binding: BUILTIN_MEMORY_BINDING,
              liveBinding,
            }),
            context
          ),
      })
    );
    const call = async (name: string, input: unknown) => {
      const result = await handlers.get(`lody_memory_${name}`)!(input);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    expect(await call('create', { path: 'facts.md', body: 'private fact' })).toMatchObject({
      ok: true,
      value: { local: 'saved' },
    });
    for (const forged of [{ roleId: 'role-a' }, { userId: 'alice' }, { memoryId: 'role-a' }])
      await expect(call('search', { query: 'private', ...forged })).rejects.toThrow();
    roleId = 'role-b';
    expect(await call('search', { query: 'private' })).toMatchObject({
      ok: true,
      value: { items: [] },
    });
    expect(await call('read', { path: 'facts.md' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    roleId = 'role-a';
    requesterUserId = 'bob';
    expect(await call('read', { path: 'facts.md' })).toMatchObject({
      ok: false,
      error: { code: 'memory_access_denied' },
    });
    requesterUserId = 'alice';
    liveBinding = undefined;
    expect(await call('update', { path: 'facts.md', body: 'revoked' })).toMatchObject({
      ok: false,
      error: { code: 'memory_access_revoked' },
    });
    liveBinding = BUILTIN_MEMORY_BINDING;
    expect(await call('read', { path: 'facts.md' })).toMatchObject({
      ok: true,
      value: { body: 'private fact' },
    });
    expect(await call('sources', { path: 'facts.md' })).toMatchObject({
      ok: true,
      value: {
        items: [
          { source: { actor: 'agent', turn: { sessionId: 'session-one', turnId: 'turn-one' } } },
        ],
      },
    });
    roleId = null;
    expect(await call('search', { query: 'private' })).toMatchObject({
      ok: false,
      error: { code: 'memory_not_bound' },
    });
  });

  it('does not accept another owner through the local room route', () => {
    const room = personalMemoryRoomId('local:alice', 'role-a');
    expect(personalMemoryRoleFromRoom(room, 'local:alice')).toBe('role-a');
    expect(() => personalMemoryRoleFromRoom(room, 'local:bob')).toThrow('memory_access_denied');
  });
  it('never reports an unsuccessful disk flush as saved, and retains the edit for retry', async () => {
    let failWrites = false;
    const { open } = await fixture();
    const { repo } = await open('alice', 'failure', {
      storage: (storage) =>
        new Proxy(storage, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (property === 'save' || property === 'saveMany')
              return (...args: unknown[]) => {
                if (failWrites) return Promise.reject(new Error('synthetic_disk_failure'));
                return value.apply(target, args);
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    });
    const handle = await repo.open('role-a', context);
    const edit = handle.memory.create(
      { path: 'offline.md', body: 'Keep this edit' },
      { ...context, changeId: 'edit' }
    );
    failWrites = true;
    await expect(handle.save(edit)).rejects.toThrow();
    expect(handle.memory.read({ path: 'offline.md' })).toMatchObject({
      ok: true,
      value: { body: 'Keep this edit' },
    });
    failWrites = false;
    expect(await handle.save(edit)).toMatchObject({ ok: true, value: { local: 'saved' } });
    await handle.release();
  });

  it('replicates over the existing local data plane without joining a workspace/cloud room', async () => {
    const { open } = await fixture();
    const cli = await open();
    const cliHandle = await cli.repo.open('role-a', context);
    const writer = makeLocalLoroWriterLegacy(
      Layer.succeed(LocalLoroWriterTurn, { next: Effect.void })
    );
    cleanups.push(() => writer.closeLegacy());
    const server = new LocalLoroDataPlaneServerLegacy({
      workspaceId: 'test-workspace',
      writerLegacy: writer,
      resolveDoc: async (id) => {
        expect(personalMemoryRoleFromRoom(id, 'alice')).toBe('role-a');
        return cliHandle.doc;
      },
      resolveFlockDoc: async () => {
        throw new Error('Personal memory must not join workspace Flock');
      },
    });
    cleanups.push(() => server.disposeLegacy());
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const statusListeners = new Set<(connected: boolean) => void>();
    let connected = true;
    const pending: Promise<void>[] = [];
    const connection = {
      id: 'test-connection',
      send: (message: LocalLoroDataPlaneServerMessage) => {
        for (const listener of listeners) listener(message);
      },
    };
    const transport = new LocalLoroTransportAdapter({
      workspaceId: 'test-workspace',
      peerId: 'renderer-memory',
      connection: {
        send: (message: LocalLoroDataPlaneClientMessage) => {
          if (connected && message.type !== 'ping')
            pending.push(server.handleMessage(connection, message));
        },
        onMessage: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onStatusChange: (listener) => {
          statusListeners.add(listener);
          return () => {
            statusListeners.delete(listener);
          };
        },
        isConnected: () => connected,
      },
    });
    const renderer = await open('alice', 'renderer', { localTransport: transport });
    const rendererHandle = await renderer.repo.open('role-a', context);
    const observed = new Promise<void>((resolve) => {
      const unsubscribe = cliHandle.doc.subscribe(() => {
        const read = cliHandle.memory.read({ path: 'from-ui.md' });
        if (read.ok && read.value.body === 'Authored in Renderer') {
          unsubscribe();
          resolve();
        }
      });
    });
    await rendererHandle.save(
      rendererHandle.memory.create(
        { path: 'from-ui.md', body: 'Authored in Renderer' },
        { ...context, changeId: 'ui' }
      )
    );
    await observed;
    expect(cliHandle.memory.search({ query: 'Renderer' })).toMatchObject({
      ok: true,
      value: { items: [{ document: { path: 'from-ui.md' } }] },
    });
    connected = false;
    for (const listener of statusListeners) listener(false);
    await server.handleDisconnectLegacy(connection.id);
    await rendererHandle.save(
      rendererHandle.memory.update(
        { path: 'from-ui.md', body: 'Offline old edit' },
        { ...context, changeId: 'offline-edit' }
      )
    );
    await cliHandle.save(
      cliHandle.memory.forget({ path: 'from-ui.md' }, { ...context, changeId: 'delete' })
    );
    await rendererHandle.save(
      rendererHandle.memory.create(
        { path: 'offline.md', body: 'Saved while disconnected' },
        { ...context, changeId: 'offline-new' }
      )
    );
    const reconverged = new Promise<void>((resolve) => {
      const check = () => {
        if (
          cliHandle.memory.read({ path: 'offline.md' }).ok &&
          !rendererHandle.memory.read({ path: 'from-ui.md' }).ok
        ) {
          stopCli();
          stopRenderer();
          resolve();
        }
      };
      const stopCli = cliHandle.doc.subscribe(check);
      const stopRenderer = rendererHandle.doc.subscribe(check);
    });
    connection.id = 'reconnected';
    connected = true;
    for (const listener of statusListeners) listener(true);
    await reconverged;
    expect(cliHandle.memory.read({ path: 'from-ui.md' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await Promise.all(pending);
    await rendererHandle.release();
    await cliHandle.release();
  });
});
