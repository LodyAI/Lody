import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  manager: {} as Record<string, unknown>,
  validate: vi.fn(),
  send: vi.fn(),
  invocation: vi.fn(),
  sync: vi.fn(),
  stores: [] as { close(): void }[],
}));

vi.mock('@/orchestration/operation-store', async (original) => {
  const actual = await original<typeof import('@/orchestration/operation-store')>();
  return {
    ...actual,
    LodyOperationStore: class extends actual.LodyOperationStore {
      constructor(...args: ConstructorParameters<typeof actual.LodyOperationStore>) {
        super(...args);
        boundary.stores.push(this);
      }
    },
  };
});

vi.mock('@/lib/command-runtime', async (original) => ({
  ...(await original<typeof import('@/lib/command-runtime')>()),
  getAuthContextOrThrow: () => ({ token: 'synthetic-token', userId: 'user', machineId: 'machine' }),
  syncWorkspaceMetaForRead: () => boundary.sync(),
}));
vi.mock('@/commands/session', async (original) => ({
  ...(await original<typeof import('@/commands/session')>()),
  validateSessionChatTarget: (...args: unknown[]) => boundary.validate(...args),
  sendSessionChatResult: (...args: unknown[]) => boundary.send(...args),
}));
vi.mock('@lody/shared/node/local-ipc', async (original) => {
  const { Effect } = await import('effect');
  return {
    ...(await original<typeof import('@lody/shared/node/local-ipc')>()),
    makeLocalControlClientAuto: () => ({
      machineRpc: () => Effect.sync(() => ({ ok: true, result: boundary.invocation() })),
    }),
  };
});

import { __lodyMcpServerInternals, runWithMcpSessionContext } from './lody-mcp-server';
import { LodyOperationStore, getLodyOperationStorePath } from '@/orchestration/operation-store';
import { loadEnv } from '@/utils/const';
import { readSessionMachineAccess, confirmDispatchSyncedBestEffort } from '@/commands/session';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';
import { LoroDocumentManager } from '@/lib/loro/doc';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';

const { startSessionChatOperation, startSessionChatManyOperation, mcpErrorResult } =
  __lodyMcpServerInternals;
const networkFailure = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }),
  });
const requester = {
  id: 'requester',
  machineId: 'machine',
  userId: 'user',
  cliType: 'codex',
  agentType: 'codex',
};
const command = {
  operationId: 'synthetic-review',
  sessionId: 'target',
  prompt: 'synthetic review',
};
const gate = () => {
  let resolve: () => void = () => {
    throw new Error('gate is not initialized');
  };
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let root: string;
let targetMachine: string;
let store: LodyOperationStore;
let sink: Database.Database;
let sourceTurn: string;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing expected boundary state');
  return value;
};
const envelope = (value: ReturnType<typeof mcpErrorResult>) =>
  JSON.parse(required(value.content[0]).text);
const invoke = async (options?: { signal?: AbortSignal }) =>
  runWithMcpSessionContext(
    {
      machineId: 'machine',
      workspaceId: 'workspace',
      sessionId: 'requester',
      workdir: root,
      taskToolsEnabled: false,
    },
    async () => {
      try {
        return await startSessionChatOperation(command, options);
      } catch (error) {
        return envelope(mcpErrorResult(error));
      }
    }
  );
const rows = () => sink.prepare('SELECT turn_id, prompt FROM target_inputs').all();
const active = () => store.listActive('workspace' as WorkspaceId, 'machine' as MachineId);
const fetchResponse = (value: unknown) =>
  new Response(JSON.stringify({ status: 'success', value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const workspaceAllow = () =>
  fetchResponse({
    valid: true,
    userId: 'user',
    workspaces: [{ id: 'workspace', name: 'Synthetic', slug: null, role: 'owner' }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T08:00:00Z'));
  root = mkdtempSync(path.join(os.tmpdir(), 'lody-chat-boundary-'));
  vi.stubEnv('LODY_DATA_DIR', root);
  vi.stubEnv('LODY_AUTH_URL', 'https://synthetic.convex.cloud');
  loadEnv();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => workspaceAllow())
  );
  store = new LodyOperationStore(getLodyOperationStorePath('machine'));
  sink = new Database(path.join(root, 'synthetic-target.sqlite3'));
  sink.exec('CREATE TABLE target_inputs (turn_id TEXT, prompt TEXT)');
  targetMachine = 'machine';
  sourceTurn = 'source-turn';
  boundary.invocation.mockImplementation(() => ({
    type: 'session/active-invocation-context',
    sessionId: 'requester',
    active: true,
    requesterUserId: 'user',
    sourceTurnId: sourceTurn,
    inputConfig: {},
  }));
  boundary.manager = {
    cleanUp: async () => undefined,
    repo: {
      getDocMeta: async (id: string) => ({
        meta: id.endsWith('requester')
          ? requester
          : { ...requester, id: 'target', machineId: targetMachine },
      }),
    },
    getOnlineMachineIds: async () => new Set(['machine', 'remote']),
  };
  vi.spyOn(LoroDocumentManager, 'create').mockImplementation(
    async () => boundary.manager as unknown as LoroDocumentManager
  );
  boundary.sync.mockResolvedValue(undefined);
  boundary.validate.mockResolvedValue(undefined);
  // A stateful fault-injection sink at the materializer port, not a target daemon simulation.
  // No UNIQUE constraint: a repeated append would remain visible in the row assertions.
  boundary.send.mockImplementation(async (...args: unknown[]) => {
    const input = args[8] as { userTurnId: string };
    sink.prepare('INSERT INTO target_inputs VALUES (?, ?)').run(input.userTurnId, args[4]);
    return { userTurnId: input.userTurnId };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  sink.close();
  for (const opened of boundary.stores.splice(0)) opened.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  loadEnv();
});

describe('real MCP acceptance + Convex fetch + SQLite boundary', () => {
  it('keeps concurrent MCP contexts in their own machine Operation stores', async () => {
    const entered = gate();
    const release = gate();
    let waiting = 0;
    boundary.validate.mockImplementation(async () => {
      waiting += 1;
      if (waiting === 2) entered.resolve();
      await release.promise;
    });
    const first = invoke();
    const second = runWithMcpSessionContext(
      {
        machineId: 'remote',
        workspaceId: 'workspace',
        sessionId: 'requester',
        workdir: root,
        taskToolsEnabled: false,
      },
      () => startSessionChatOperation({ ...command, prompt: 'second synthetic request' })
    );
    await entered.promise;
    release.resolve();
    expect(await first).toMatchObject({ id: command.operationId });
    expect(await second).toMatchObject({ id: command.operationId });
    const remoteStore = new LodyOperationStore(getLodyOperationStorePath('remote'));
    expect(required(active()[0]).canonicalCommand).toMatchObject({ prompt: command.prompt });
    expect(
      remoteStore.get('requester' as SessionId, command.operationId).canonicalCommand
    ).toMatchObject({ prompt: 'second synthetic request' });
    expect(rows()).toHaveLength(2);
  });
  it('cancellation during manager acquisition still releases the eventual resource without accepting', async () => {
    const entered = gate();
    const release = gate();
    let cleaned = false;
    boundary.manager.cleanUp = async () => {
      cleaned = true;
    };
    vi.mocked(LoroDocumentManager.create).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return boundary.manager as unknown as LoroDocumentManager;
    });
    const controller = new AbortController();
    const result = invoke({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect(cleaned).toBe(false);
    release.resolve();
    await result;
    expect(cleaned).toBe(true);
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('cancels a pending workspace fetch without accepting an operation', async () => {
    const entered = gate();
    const aborted = gate();
    vi.stubGlobal(
      'fetch',
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(new Error('synthetic abort'));
            },
            { once: true }
          );
          entered.resolve();
        })
    );
    const controller = new AbortController();
    const result = invoke({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    await aborted.promise;
    await result;
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it.each([false, true])(
    'joins materialization on cancellation and preserves the first response (receipt unavailable=%s)',
    async (receiptUnavailable) => {
      const entered = gate();
      const release = gate();
      let cleaned = false;
      boundary.manager.cleanUp = async () => {
        cleaned = true;
      };
      boundary.send.mockImplementation(async (...args: unknown[]) => {
        const input = args[8] as { userTurnId: string };
        entered.resolve();
        await release.promise;
        expect(cleaned).toBe(false);
        sink.prepare('INSERT INTO target_inputs VALUES (?, ?)').run(input.userTurnId, args[4]);
        return { userTurnId: input.userTurnId };
      });
      const controller = new AbortController();
      const result = invoke({ signal: controller.signal });
      await entered.promise;
      controller.abort();
      expect(cleaned).toBe(false);
      expect(rows()).toEqual([]);
      const snapshot = receiptUnavailable
        ? vi.spyOn(LodyOperationStore.prototype, 'snapshot').mockImplementation(() => {
            throw new Error('synthetic receipt unavailable');
          })
        : undefined;
      release.resolve();
      if (receiptUnavailable) {
        expect(await result).toMatchObject({
          ok: false,
          error: { code: 'OPERATION_RESULT_UNAVAILABLE', retryable: true },
        });
        snapshot?.mockRestore();
      } else {
        expect(await result).toEqual(
          store.snapshot(store.get('requester' as SessionId, command.operationId))
        );
      }
      expect(cleaned).toBe(true);
      expect(required(active()[0]).items[0]).toMatchObject({ inputDurable: true });
      expect(await invoke()).toMatchObject({ id: command.operationId });
      expect(rows()).toHaveLength(1);
    }
  );
  it.each([false, true])(
    'cancellation after SQLite accept but before materialization preserves the first response (receipt unavailable=%s)',
    async (receiptUnavailable) => {
      const controller = new AbortController();
      let cleaned = false;
      boundary.manager.cleanUp = async () => {
        cleaned = true;
      };
      const accept = LodyOperationStore.prototype.accept;
      vi.spyOn(LodyOperationStore.prototype, 'accept').mockImplementation(function (
        this: LodyOperationStore,
        ...args
      ) {
        const persisted = accept.apply(this, args);
        // Explicit synchronous handoff: the real transaction has returned, but the
        // Effect continuation and materializer have not started. No scheduler race.
        controller.abort();
        return persisted;
      });
      const snapshot = receiptUnavailable
        ? vi.spyOn(LodyOperationStore.prototype, 'snapshot').mockImplementation(() => {
            throw new Error('synthetic receipt unavailable');
          })
        : undefined;
      const first = await invoke({ signal: controller.signal });
      if (receiptUnavailable) {
        expect(first).toMatchObject({
          ok: false,
          error: { code: 'OPERATION_RESULT_UNAVAILABLE', retryable: true },
        });
        snapshot?.mockRestore();
      } else {
        expect(first).toEqual(
          store.snapshot(store.get('requester' as SessionId, command.operationId))
        );
      }
      expect(cleaned).toBe(true);
      expect(required(active()[0]).items[0]).toMatchObject({ inputDurable: false });
      expect(rows()).toEqual([]);
      expect(await invoke()).toMatchObject({ id: command.operationId, state: 'active' });
      expect(rows()).toEqual([]);
    }
  );
  it('receipt read failure reports uncertainty and same-ID recovery returns the persisted input', async () => {
    const snapshot = vi.spyOn(LodyOperationStore.prototype, 'snapshot').mockImplementation(() => {
      throw new Error('synthetic disk read failure');
    });
    expect(await invoke()).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_RESULT_UNAVAILABLE', retryable: true },
    });
    expect(rows()).toHaveLength(1);
    snapshot.mockRestore();
    expect(await invoke()).toMatchObject({ id: command.operationId });
    expect(required(active()[0]).items[0]).toMatchObject({ inputDurable: true });
    expect(rows()).toHaveLength(1);
  });
  it('inactive invoking turn fails closed without persistence', async () => {
    boundary.invocation.mockReturnValue({
      type: 'session/active-invocation-context',
      sessionId: 'requester',
      active: false,
    });
    expect(await invoke()).toMatchObject({
      ok: false,
      error: { code: 'INVOKING_TURN_NOT_FOUND', retryable: false },
    });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('batch prevalidation sync failure leaves no durable operation or input', async () => {
    boundary.validate.mockRejectedValue(
      new WorkspaceSyncUnavailableError({ message: 'synthetic sync failure' })
    );
    const result = await runWithMcpSessionContext(
      {
        machineId: 'machine',
        workspaceId: 'workspace',
        sessionId: 'requester',
        workdir: root,
        taskToolsEnabled: false,
      },
      async () => {
        try {
          return await startSessionChatManyOperation({
            operationId: 'synthetic-batch',
            items: [{ sessionId: 'target', prompt: 'synthetic' }],
          });
        } catch (error) {
          return envelope(mcpErrorResult(error));
        }
      }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SYNC_UNAVAILABLE', retryable: true },
    });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it.each(['machine', 'remote'])(
    'workspace fetch failure blocks %s target before persistence',
    async (machine) => {
      targetMachine = machine;
      vi.stubGlobal('fetch', async () => {
        throw networkFailure();
      });
      const result = invoke();
      await vi.advanceTimersByTimeAsync(3250);
      expect(await result).toMatchObject({
        ok: false,
        error: { code: 'WORKSPACE_ACCESS_UNAVAILABLE', retryable: true },
      });
      expect(active()).toEqual([]);
      expect(rows()).toEqual([]);
    }
  );
  it('an unresolved workspace read cannot accept while a local runtime is available', async () => {
    const entered = gate();
    const release = gate();
    vi.stubGlobal('fetch', async () => {
      entered.resolve();
      await release.promise;
      throw networkFailure();
    });
    const result = invoke();
    await entered.promise;
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
    release.resolve();
    await vi.advanceTimersByTimeAsync(3250);
    expect(await result).toMatchObject({ ok: false });
  });
  it('expired credentials fail closed without target persistence', async () => {
    vi.stubGlobal('fetch', async () =>
      fetchResponse({ valid: false, userId: null, workspaces: [] })
    );
    expect(await invoke()).toMatchObject({ ok: false, error: { retryable: false } });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('a different workspace cannot be selected from the authorized list', async () => {
    vi.stubGlobal('fetch', async () =>
      fetchResponse({
        valid: true,
        userId: 'user',
        workspaces: [{ id: 'other', name: 'Other', slug: null, role: 'owner' }],
      })
    );
    expect(await invoke()).toMatchObject({ ok: false });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('explicit machine denial remains non-retryable with no accepted operation', async () => {
    boundary.validate.mockImplementation(async () => {
      const result = await readSessionMachineAccess({
        auth: { token: 'synthetic-token', userId: 'user', machineId: 'machine' } as Parameters<
          typeof readSessionMachineAccess
        >[0]['auth'],
        workspaceId: 'workspace' as WorkspaceId,
        machineId: 'machine' as MachineId,
        delegatedRequester: { userId: 'user' },
      });
      if (!result.allowed) throw new Error(`Machine access denied: ${result.reason}`);
    });
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) =>
      JSON.parse(String(init.body)).path.includes('listMyWorkspaces')
        ? workspaceAllow()
        : fetchResponse({ allowed: false, reason: 'requester_not_member' })
    );
    expect(await invoke()).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_REJECTED', retryable: false },
    });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('prevalidation synchronization uncertainty preserves its typed error', async () => {
    boundary.validate.mockRejectedValue(
      new WorkspaceSyncUnavailableError({ message: 'synthetic sync failure' })
    );
    expect(await invoke()).toMatchObject({
      ok: false,
      error: { code: 'SYNC_UNAVAILABLE', retryable: true },
    });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('post-accept materializer response loss preserves fixed ID and same-ID retry does not append twice', async () => {
    const entered = gate();
    const release = gate();
    boundary.send.mockImplementation(async (...args: unknown[]) => {
      const input = args[8] as { userTurnId: string };
      sink.prepare('INSERT INTO target_inputs VALUES (?, ?)').run(input.userTurnId, args[4]);
      entered.resolve();
      await release.promise;
      throw networkFailure();
    });
    const first = invoke();
    await entered.promise;
    const accepted = required(active()[0]);
    expect(accepted.items[0]).toMatchObject({ status: 'active', inputDurable: false });
    expect(rows()).toEqual([
      { turn_id: required(required(accepted.items[0]).target).userTurnId, prompt: command.prompt },
    ]);
    release.resolve();
    expect(await first).toEqual(
      store.snapshot(store.get('requester' as SessionId, command.operationId))
    );
    expect(await invoke()).toEqual(
      store.snapshot(store.get('requester' as SessionId, command.operationId))
    );
    expect(rows()).toHaveLength(1);
    vi.stubGlobal('fetch', async () => {
      throw networkFailure();
    });
    const unavailable = invoke();
    await vi.advanceTimersByTimeAsync(3250);
    expect(await unavailable).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_ACCESS_UNAVAILABLE' },
    });
    expect(store.snapshot(store.get('requester' as SessionId, command.operationId))).toMatchObject({
      id: command.operationId,
    });
    expect(rows()).toHaveLength(1);
  });
  it('retry from a different driving turn is ID reuse, not a resend', async () => {
    await invoke();
    sourceTurn = 'different-turn';
    expect(await invoke()).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ID_REUSED', retryable: false },
    });
    expect(rows()).toHaveLength(1);
  });
  it('bounded machine-access transport retries exhaust under a fake clock before acceptance', async () => {
    const entered = gate();
    boundary.validate.mockImplementation(async () =>
      readSessionMachineAccess({
        auth: { token: 'synthetic-token', userId: 'user', machineId: 'machine' } as Parameters<
          typeof readSessionMachineAccess
        >[0]['auth'],
        workspaceId: 'workspace' as WorkspaceId,
        machineId: 'machine' as MachineId,
        delegatedRequester: { userId: 'user' },
      })
    );
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      if (JSON.parse(String(init.body)).path.includes('listMyWorkspaces')) return workspaceAllow();
      entered.resolve();
      throw networkFailure();
    });
    const result = invoke();
    await entered.promise;
    expect(active()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3250);
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'MACHINE_ACCESS_UNAVAILABLE', retryable: true },
    });
    expect(active()).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it('failure after acceptance but before append leaves a recoverable item and zero input rows', async () => {
    boundary.send.mockRejectedValue(networkFailure());
    expect(await invoke()).toMatchObject({ id: command.operationId, state: 'active' });
    expect(required(active()[0]).items[0]).toMatchObject({ status: 'active', inputDurable: false });
    expect(rows()).toEqual([]);
    expect(await invoke()).toEqual(store.snapshot(required(active()[0])));
    expect(rows()).toEqual([]);
  });
  it('best-effort post-dispatch sync failure does not invert successful acceptance', async () => {
    await invoke();
    await expect(
      confirmDispatchSyncedBestEffort({
        manager: { waitUntilMetaSynced: async () => false },
        sessionDoc: {
          waitUntilSynced: async () => {
            throw networkFailure();
          },
        },
        reason: 'synthetic',
        logger: { warn: () => {} },
      })
    ).resolves.toBeUndefined();
    expect(required(active()[0]).items[0]).toMatchObject({ inputDurable: true });
    expect(rows()).toHaveLength(1);
  });
});
