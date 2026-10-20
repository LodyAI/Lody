import { buildAgentMessageAuthor } from '@lody/shared';
import { Effect, Layer } from 'effect';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InboxRepository } from './inbox/service';
import { OperationRepository } from './operation-repository';
import { OrchestrationDatabase } from './platform/database';
import { orchestrationRepositoriesLayer } from './platform/operations';

import {
  resolveEffectiveSessionCreateDispatchConfig,
  type ResolvedTurnDispatchConfig,
} from '@/commands/session';
import { FlockSyncTimeoutError } from '@/lib/loro/timeout-utils';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LODY_OPERATION_COMPLETION_MAX_BYTES,
  type AcpCapabilityCacheEntry,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import {
  canonicalizeLodyCommand,
  isOperationStoreBusyError,
  LodyOperationStore,
  LodyOperationStoreError,
  runWithOperationStoreBusyRetry,
} from './operation-store';

const queuedResults = (store: LodyOperationStore, workspaceId: WorkspaceId) =>
  (store as unknown as { db: Database.Database }).db
    .prepare(
      'SELECT session_id AS requesterSessionId,operation_id AS operationId,consumed FROM inbox_results WHERE workspace_id=? AND consumed=0 ORDER BY sequence'
    )
    .all(workspaceId);

const roots = new Set<string>();

const makeStore = async (now: () => number = () => Date.parse('2026-07-20T00:00:00Z')) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-'));
  roots.add(root);
  return new LodyOperationStore(path.join(root, 'operations.sqlite3'), now);
};

const baseInput = () => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  ownerMachineId: 'machine-1' as MachineId,
  requesterSessionId: 'requester-1' as SessionId,
  requesterUserId: 'user-1',
  operationId: 'review-round-1',
  kind: 'session_chat' as const,
  canonicalCommand: { prompt: 'review', target: 'target-1' },
  frozenContinuationConfig: {
    agentConfigId: 'agent-1',
    inputConfig: { cliType: 'builtin' as const, agentType: 'codex', chainDepth: 0 },
    sourceTurnId: 'source-turn-1',
  },
  initiatorChainDepth: 0,
  createdAt: '2026-07-20T00:00:00.000Z',
  deadlineAt: '2026-07-21T00:00:00.000Z',
  items: [
    {
      status: 'active' as const,
      target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
      inputDurable: false,
    },
  ],
});

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('LodyOperationStore', () => {
  it('memory repositories share the completion transaction and reject asynchronous transaction callbacks', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* OrchestrationDatabase;
          const operations = yield* OperationRepository;
          const inbox = yield* InboxRepository;
          const input = baseInput();
          yield* operations.accept(input);
          connection.raw.exec(
            "CREATE TRIGGER fail_result BEFORE INSERT ON inbox_results BEGIN SELECT RAISE(ABORT,'outage'); END"
          );
          const failed = yield* Effect.exit(
            operations.finish(input.requesterSessionId, input.operationId, {
              type: 'result',
              value: { items: [] },
            })
          );
          expect(failed._tag).toBe('Failure');
          expect((yield* operations.get(input.requesterSessionId, input.operationId)).state).toBe(
            'active'
          );
          expect(
            connection.raw
              .prepare("SELECT value FROM orchestration_meta WHERE key='inbox_sequence'")
              .get()
          ).toEqual({ value: '0' });
          connection.raw.exec('DROP TRIGGER fail_result');
          yield* operations.finish(input.requesterSessionId, input.operationId, {
            type: 'result',
            value: { items: [] },
          });
          expect(connection.raw.prepare('SELECT sequence FROM inbox_results').all()).toEqual([
            { sequence: 1 },
          ]);
          expect(yield* inbox.pending(input.workspaceId)).toHaveLength(1);
          expect(() =>
            connection.withImmediate((() => {
              connection.raw.exec("UPDATE operations SET state='active'");
              return Promise.resolve();
            }) as never)
          ).toThrow('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
          expect((yield* operations.get(input.requesterSessionId, input.operationId)).state).toBe(
            'finished'
          );
          expect(() =>
            connection.withImmediate((() => {
              connection.raw.exec("UPDATE operations SET state='active'");
              return Effect.void;
            }) as never)
          ).toThrow('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
          expect((yield* operations.get(input.requesterSessionId, input.operationId)).state).toBe(
            'finished'
          );
        }).pipe(
          Effect.provide(
            orchestrationRepositoriesLayer.pipe(
              // Both consumers receive the same scoped service, not separate memory databases.
              Layer.provideMerge(OrchestrationDatabase.layer({ kind: 'memory' }))
            )
          )
        )
      )
    );
  });

  it('does not infer an Agent source from the requester Session alone', async () => {
    const store = await makeStore();
    try {
      const input = baseInput();
      const { sourceTurnId: _, ...config } = input.frozenContinuationConfig;
      const { operation } = store.accept({ ...input, frozenContinuationConfig: config });
      expect(operation.author).toBeUndefined();
      expect(store.get(operation.requesterSessionId, operation.operationId).author).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('upgrades released Operation tables without losing active work or duplicate guards', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-upgrade-store-'));
    roots.add(root);
    const filename = path.join(root, 'operations.sqlite3');
    const now = () => Date.parse('2026-10-12T00:00:00Z');
    const input = baseInput();
    const active = { ...input, operationId: 'old-active' };
    const finished = { ...input, operationId: 'old-finished' };
    const author = buildAgentMessageAuthor({
      sessionId: input.requesterSessionId,
      turnId: 'source-turn-1',
      name: 'Agent',
    });
    const seed = new LodyOperationStore(filename, now);
    seed.accept({ ...active, author });
    seed.accept(finished);
    seed.finish(input.requesterSessionId, finished.operationId, {
      type: 'result',
      value: { items: [] },
    });
    seed.close();
    const old = new Database(filename);
    for (const { name } of old
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'inbox_%'")
      .all() as { name: string }[])
      old.exec(`DROP TABLE ${name}`);
    old.exec(`UPDATE orchestration_meta SET value='1' WHERE key='schema_version';
      INSERT INTO operation_retired_ids VALUES('requester-session','old-retired');
      CREATE TABLE deliveries(operation_id TEXT,state TEXT);
      INSERT INTO deliveries VALUES('old-finished','pending');
      CREATE TABLE delivery_execution_state(operation_id TEXT,execution_phase TEXT);
      INSERT INTO delivery_execution_state VALUES('old-finished','started');`);
    old.close();
    const store = new LodyOperationStore(filename, now);
    try {
      const db = (store as unknown as { db: Database.Database }).db;
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('deliveries','delivery_execution_state')"
          )
          .all()
      ).toEqual([]);
      expect(store.get(input.requesterSessionId, active.operationId)).toMatchObject({
        state: 'active',
        author,
      });
      expect(store.get(input.requesterSessionId, finished.operationId).state).toBe('finished');
      expect(store.accept(finished).created).toBe(false);
      expect(() =>
        store.accept({
          ...input,
          operationId: 'old-retired',
          requesterSessionId: 'requester-session' as SessionId,
        })
      ).toThrow();
      expect(db.prepare('SELECT * FROM inbox_results').all()).toEqual([]);
      store.finish(input.requesterSessionId, active.operationId, {
        type: 'result',
        value: { items: [] },
      });
      expect(db.prepare('SELECT operation_id FROM inbox_results').all()).toEqual([
        { operation_id: active.operationId },
      ]);
      expect(store.inbox.pending('workspace-1')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('inherits complete scoped batch provenance and waits for every result or descendant', async () => {
    const store = await makeStore();
    const base = baseInput();
    const input = {
      workspaceId: base.workspaceId,
      sessionId: base.requesterSessionId,
      userId: base.requesterUserId,
      inputId: 'summary',
      kind: 'human' as const,
      config: {},
    };
    const accept = (id: string, origins: string[], userId = input.userId) =>
      store.accept({
        ...base,
        operationId: id,
        requesterUserId: userId,
        frozenContinuationConfig: {
          ...base.frozenContinuationConfig,
          notificationOriginTurnIds: origins,
        },
      });
    const finish = (id: string) =>
      store.finish(input.sessionId, id, { type: 'result', value: { items: [] } });
    try {
      store.inbox.activate(input.workspaceId, 'owner');
      // The second request occurs beyond the 50-member inline preview.
      for (let i = 0; i < 52; i++) {
        accept(`child-${i}`, [i < 51 ? 'request-a' : 'request-b']);
        finish(`child-${i}`);
      }
      accept('delegated', []);
      finish('delegated');
      accept('another-user', ['foreign-request'], 'user-2');
      finish('another-user');
      store.inbox.accept(input);
      store.inbox.begin(input, 'exec');
      const batch = store.inbox.prepare(input, 'owner')!;
      expect(batch.memberCount).toBe(53);
      expect(store.notificationOriginsForBatch(batch).sort()).toEqual(['request-a', 'request-b']);
      expect(store.notificationOriginsForBatch({ ...batch, userId: 'user-3' })).toEqual([]);
      expect(
        store.pendingNotificationOrigins(input, ['request-a', 'request-b', 'foreign-request'])
      ).toEqual(new Set(['request-a', 'request-b']));
      expect(store.inbox.fence(batch, 'exec')).toBe(true);
      store.inbox.settle(batch, 'settled');
      expect(store.pendingNotificationOrigins(input, ['request-a', 'request-b'])).toEqual(
        new Set()
      );
      accept('follow-up', ['request-a']);
      expect(store.pendingNotificationOrigins(input, ['request-a', 'request-b'])).toEqual(
        new Set(['request-a'])
      );
      expect(
        store.get(input.sessionId, 'follow-up').frozenContinuationConfig.notificationOriginTurnIds
      ).toEqual(['request-a']);
      finish('follow-up');
      // A finished child still has work outstanding until its result is consumed.
      expect(store.pendingNotificationOrigins(input, ['request-a'])).toEqual(
        new Set(['request-a'])
      );
    } finally {
      store.close();
    }
  });

  it('counts wakeable queued receipts and retained execution as work; pause makes receipts passive', async () => {
    const store = await makeStore();
    const op = baseInput();
    const input = {
      workspaceId: op.workspaceId,
      sessionId: op.requesterSessionId,
      userId: op.requesterUserId,
      inputId: 'human',
      kind: 'human' as const,
      config: {},
    };
    try {
      store.inbox.activate(op.workspaceId, 'owner');
      store.accept(op);
      expect(store.hasPendingWorkForRequester(op.workspaceId, op.requesterSessionId)).toBe(true);
      store.finish(op.requesterSessionId, op.operationId, { type: 'cancelled' });
      expect(queuedResults(store, op.workspaceId)).toHaveLength(1);
      expect(store.hasPendingWorkForRequester(op.workspaceId, op.requesterSessionId)).toBe(true);
      store.inbox.accept(input);
      store.inbox.begin(input, 'execution');
      expect(store.hasPendingWorkForRequester(op.workspaceId, op.requesterSessionId)).toBe(true);
      store.inbox.release({ ...input, executionId: 'execution', outcome: 'normal' });
      expect(store.inbox.pending(op.workspaceId)).toHaveLength(1);
      expect(store.hasPendingWorkForRequester(op.workspaceId, op.requesterSessionId)).toBe(true);
      store.inbox.pause(input, 'execution');
      expect(store.hasPendingWorkForRequester(op.workspaceId, op.requesterSessionId)).toBe(false);
      expect(queuedResults(store, op.workspaceId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it.each(['session_chat', 'session_create'] as const)(
    'retains unconsumed $0 results and retires consumed IDs without reusing their sequence',
    async (kind) => {
      let now = Date.parse('2026-07-20T00:00:00Z');
      const root = await mkdtemp(path.join(os.tmpdir(), 'lody-native-result-retention-'));
      roots.add(root);
      const filename = path.join(root, 'operations.sqlite3');
      const op = { ...baseInput(), kind };
      const input = {
        workspaceId: op.workspaceId,
        sessionId: op.requesterSessionId,
        userId: op.requesterUserId,
        inputId: 'human',
        kind: 'human' as const,
        config: {},
      };
      let store = new LodyOperationStore(filename, () => now);
      store.accept(op);
      store.finish(op.requesterSessionId, op.operationId, { type: 'cancelled' });
      store.close();
      now += 10 * 24 * 60 * 60 * 1000;
      store = new LodyOperationStore(filename, () => now);
      expect(queuedResults(store, op.workspaceId)).toHaveLength(1);
      store.inbox.activate(op.workspaceId, 'owner');
      store.inbox.accept(input);
      store.inbox.begin(input, 'exec');
      const batch = store.inbox.prepare(input, 'owner')!;
      expect(store.inbox.fence(batch, 'exec')).toBe(true);
      store.inbox.settle(batch, 'settled');
      store.inbox.release({ ...input, executionId: 'exec', outcome: 'normal' });
      store.close();
      now += 10 * 24 * 60 * 60 * 1000;
      store = new LodyOperationStore(filename, () => now);
      if (kind === 'session_create') {
        expect(store.listPendingProgress(op.workspaceId, op.ownerMachineId)).toMatchObject([
          { operationId: op.operationId },
        ]);
        expect(store.get(op.requesterSessionId, op.operationId).state).toBe('finished');
        store.settleProgress(op.requesterSessionId, op.operationId);
        store.close();
        now += 2 * 24 * 60 * 60 * 1000;
        store = new LodyOperationStore(filename, () => now);
      }
      try {
        expect(() => store.get(op.requesterSessionId, op.operationId)).toThrow(
          'Operation not found'
        );
        expect(() => store.accept(op)).toThrow(
          expect.objectContaining({ code: 'OPERATION_ID_REUSED' })
        );
        expect(queuedResults(store, op.workspaceId)).toEqual([]);
        expect(store.inbox.members(batch)).toEqual([]);
        store.accept({ ...op, operationId: 'new-result' });
        store.finish(op.requesterSessionId, 'new-result', { type: 'cancelled' });
        expect(
          (store as unknown as { db: Database.Database }).db
            .prepare("SELECT sequence FROM inbox_results WHERE operation_id='new-result'")
            .get()
        ).toEqual({ sequence: 2 });
      } finally {
        store.close();
      }
    }
  );

  it('retains current Inbox evidence through atomic removal of old tables and failed migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-remove-delivery-tables-'));
    roots.add(root);
    const filename = path.join(root, 'operations.sqlite3');
    const op = baseInput();
    const input = {
      workspaceId: op.workspaceId,
      sessionId: op.requesterSessionId,
      userId: op.requesterUserId,
      inputId: 'human',
      kind: 'human' as const,
      config: {},
    };
    let store = new LodyOperationStore(filename);
    store.inbox.activate(op.workspaceId, 'owner');
    store.accept(op);
    store.finish(op.requesterSessionId, op.operationId, { type: 'cancelled' });
    store.inbox.accept(input);
    store.inbox.begin(input, 'execution');
    const batch = store.inbox.prepare(input, 'owner')!;
    expect(store.inbox.fence(batch, 'execution')).toBe(true);
    store.inbox.release({ ...input, executionId: 'execution', outcome: 'unreleased' });
    store.inbox.pause(input, 'execution', [], 'stop');
    store.close();
    let db = new Database(filename);
    db.exec(`DELETE FROM orchestration_meta WHERE key='schema_version';
      CREATE TABLE deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO deliveries(sequence) VALUES(100);
      CREATE TABLE delivery_execution_state(operation_id TEXT);
      CREATE TRIGGER fail_cleanup BEFORE INSERT ON orchestration_meta WHEN NEW.key='schema_version' BEGIN SELECT RAISE(ABORT,'cleanup outage'); END;`);
    db.close();
    expect(() => new LodyOperationStore(filename)).toThrow('cleanup outage');
    db = new Database(filename);
    expect(db.prepare('SELECT sequence FROM deliveries').all()).toEqual([{ sequence: 100 }]);
    expect(db.prepare('SELECT state FROM inbox_batches').get()).toEqual({ state: 'submitting' });
    db.exec('DROP TRIGGER fail_cleanup');
    db.close();
    store = new LodyOperationStore(filename);
    try {
      expect(store.inbox.getBatch(batch.batchId, batch)?.state).toBe('submitting');
      expect(store.inbox.begin({ ...input, inputId: 'next' }, 'successor')).toBe(false);
      store.inbox.activate(op.workspaceId, 'replacement');
      expect(store.inbox.getBatch(batch.batchId, batch)?.state).toBe('unknown');
      expect(store.inbox.pending(op.workspaceId)).toEqual([]);
      expect(store.inbox.begin({ ...input, inputId: 'next' }, 'successor')).toBe(false);
      store.accept({ ...op, operationId: 'after-cleanup' });
      store.finish(op.requesterSessionId, 'after-cleanup', { type: 'cancelled' });
      const last = queuedResults(store, op.workspaceId);
      expect(last).toHaveLength(1);
      expect(
        (store as unknown as { db: Database.Database }).db
          .prepare("SELECT sequence FROM inbox_results WHERE operation_id='after-cleanup'")
          .get()
      ).toEqual({ sequence: 101 });
      expect(
        (store as unknown as { db: Database.Database }).db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('deliveries','delivery_execution_state')"
          )
          .all()
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
  it('freezes complete attachment inputs atomically across retries and database reopen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-inputs-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const input = baseInput();
    const attachment = {
      type: 'file' as const,
      fileId: 'file-1',
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 8,
      sha256: 'a'.repeat(64),
      textPreview: true,
      transport: 'r2' as const,
      uploadedAt: 1,
    };
    let store = new LodyOperationStore(dbPath);
    try {
      store.accept({ ...input, targetInputAttachments: [[attachment]] });
      const retry = store.accept({
        ...input,
        targetInputAttachments: [[{ ...attachment, fileId: 'ignored-retry-upload' }]],
      });
      expect(retry.created).toBe(false);
      expect(retry.operation.targetInputAttachments).toEqual([[attachment]]);
      store.close();
      store = new LodyOperationStore(dbPath);
      expect(store.get(input.requesterSessionId, input.operationId).targetInputAttachments).toEqual(
        [[attachment]]
      );
      expect(() =>
        store.accept({ ...input, operationId: 'bad', targetInputAttachments: [] })
      ).toThrow('match');
      expect(() => store.get(input.requesterSessionId, 'bad')).toThrow();
    } finally {
      store.close();
    }
  });

  it('freezes source authors across retries and reopening without changing legacy operation rows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-author-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const input = baseInput();
    const author = buildAgentMessageAuthor({
      sessionId: input.requesterSessionId,
      turnId: 'source-turn-1',
      name: 'Agent A',
      inputConfig: { modelId: 'model-a' },
      role: { id: 'role-a' as never, revision: 1, name: 'Reviewer', emoji: '🔎' },
    });
    let store = new LodyOperationStore(dbPath);
    try {
      store.accept({ ...input, author, targetRoleSnapshots: [author.role ?? null] });
      const retry = store.accept({
        ...input,
        author: { ...author, name: 'Renamed', role: undefined },
      });
      expect(retry.operation.author).toEqual(author);
      store.close();
      store = new LodyOperationStore(dbPath);
      expect(store.get(input.requesterSessionId, input.operationId)).toMatchObject({
        requesterUserId: 'user-1',
        author,
        targetRoleSnapshots: [author.role],
      });
      const db = new Database(dbPath);
      try {
        const row = db.prepare('SELECT * FROM operations').get() as Record<string, unknown>;
        expect(row).not.toHaveProperty('author_json');
        expect(JSON.parse(row.frozen_config_json as string)).not.toHaveProperty('author');
      } finally {
        db.close();
      }
      expect(() =>
        store.accept({
          ...input,
          operationId: 'bad-author',
          author: { ...author, sessionId: 'other' },
        })
      ).toThrow('source turn');
      expect(() => store.get(input.requesterSessionId, 'bad-author')).toThrow();
    } finally {
      store.close();
    }
  });

  it('pages requester-owned summaries without prompts and rejects foreign cursor scopes', async () => {
    const store = await makeStore();
    const scope = {
      workspaceId: 'workspace-1' as WorkspaceId,
      requesterSessionId: 'requester-1' as SessionId,
      requesterUserId: 'user-1',
    };
    try {
      for (const operationId of ['a', 'b', 'c']) store.accept({ ...baseInput(), operationId });
      store.accept({
        ...baseInput(),
        operationId: 'foreign-session',
        requesterSessionId: 'other' as SessionId,
      });
      store.accept({ ...baseInput(), operationId: 'foreign-user', requesterUserId: 'other' });
      store.accept({
        ...baseInput(),
        operationId: 'foreign-workspace',
        workspaceId: 'other' as WorkspaceId,
      });
      const first = store.listForRequester(scope, { limit: 2, state: 'active' });
      expect(first.items.map((row) => row.operationId)).toEqual(['a', 'b']);
      const second = store.listForRequester(scope, {
        limit: 2,
        state: 'active',
        cursor: first.nextCursor,
      });
      expect(second.items.map((row) => row.operationId)).toEqual(['c']);
      expect(second.hasMore).toBe(false);
      expect(first.items[0]).not.toHaveProperty('canonicalCommand');
      expect(() =>
        store.listForRequester(
          { ...scope, requesterUserId: 'other' },
          { cursor: first.nextCursor, state: 'active' }
        )
      ).toThrow('CURSOR_INVALID');
      expect(() =>
        store.listForRequester(scope, { cursor: first.nextCursor, state: 'finished' })
      ).toThrow('CURSOR_INVALID');
      expect(store.listForRequester(scope, { state: 'finished' }).items).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('restricts the store directory and database to the local account', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-permissions-'));
    roots.add(root);
    await chmod(root, 0o755);
    const dbPath = path.join(root, 'operations.sqlite3');
    const store = new LodyOperationStore(dbPath);
    try {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it('accepts once and returns the same Operation for canonical-equivalent retries', async () => {
    const store = await makeStore();
    try {
      const first = store.accept(baseInput());
      const retry = store.accept({
        ...baseInput(),
        canonicalCommand: { target: 'target-1', prompt: 'review' },
      });

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.operation.operationId).toBe('review-round-1');
      expect(retry.operation.frozenContinuationConfig.sourceTurnId).toBe('source-turn-1');
      expect(store.snapshot(retry.operation)).toMatchObject({ state: 'active' });
    } finally {
      store.close();
    }
  });

  it('round-trips a frozen create dispatch config', async () => {
    const store = await makeStore();
    try {
      const accepted = store.accept({
        ...baseInput(),
        kind: 'session_create',
        frozenContinuationConfig: {
          agentConfigId: 'agent-1',
          inputConfig: { cliType: 'builtin' as const, agentType: 'codex', chainDepth: 0 },
          targetDispatchConfigs: [
            {
              modeId: 'default',
              builtinDefaultModeId: 'default',
              modelId: 'gpt-5',
              configOptionValues: { fast: true },
              inheritedDispatchConfig: { modelId: 'gpt-5', configOptionValues: { fast: true } },
              memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
              inheritSessionDefaults: false as const,
            },
          ],
        },
      });

      expect(accepted.created).toBe(true);
      expect(accepted.operation.frozenContinuationConfig.targetDispatchConfigs).toEqual([
        {
          modeId: 'default',
          builtinDefaultModeId: 'default',
          modelId: 'gpt-5',
          configOptionValues: { fast: true },
          inheritedDispatchConfig: { modelId: 'gpt-5', configOptionValues: { fast: true } },
          memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
          inheritSessionDefaults: false,
        },
      ]);
    } finally {
      store.close();
    }
  });

  describe.each([
    ['codex', 'agent-auto-review'],
    ['claude', 'auto'],
  ] as const)('%s frozen mode recovery', (agentType, modeId) => {
    const makeResolver = (initialCapability?: AcpCapabilityCacheEntry) => {
      let capability = initialCapability;
      let freshnessConfirmed = false;
      const args = {
        workspaceId: 'workspace-1' as WorkspaceId,
        agentConfig: {
          id: 'agent-1',
          machineId: 'machine-1' as MachineId,
          name: 'Synthetic',
          cliType: 'builtin' as const,
          agentType,
        },
        manager: {
          syncFlockDocOrThrow: async () => {
            if (!freshnessConfirmed) throw new FlockSyncTimeoutError('Synthetic deadline');
          },
          repo: {
            openFlockDoc: async () => ({
              flock: {
                scan: () =>
                  capability ? [{ key: ['acpCapability', 'agent-1'], value: capability }] : [],
              },
            }),
          },
        } as unknown as Parameters<
          typeof resolveEffectiveSessionCreateDispatchConfig
        >[0]['manager'],
      };
      return {
        resolve: (dispatchConfig: ResolvedTurnDispatchConfig) =>
          resolveEffectiveSessionCreateDispatchConfig({ ...args, dispatchConfig }),
        setCapability: (next: AcpCapabilityCacheEntry | undefined, confirmed: boolean) => {
          capability = next;
          freshnessConfirmed = confirmed;
        },
      };
    };
    const makeCapability = (modeIds: string[]): AcpCapabilityCacheEntry => ({
      cliType: 'builtin',
      agentType,
      modes: modeIds.map((id) => ({ id, name: id })),
      models: [],
      fetchedAt: 1,
    });
    const roundTrip = async (frozen: ResolvedTurnDispatchConfig) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lody-default-mode-recovery-'));
      roots.add(root);
      const storePath = path.join(root, 'operations.sqlite3');
      const acceptingStore = new LodyOperationStore(storePath);
      try {
        acceptingStore.accept({
          ...baseInput(),
          kind: 'session_create',
          frozenContinuationConfig: {
            ...baseInput().frozenContinuationConfig,
            targetDispatchConfigs: [frozen],
          },
        });
      } finally {
        acceptingStore.close();
      }
      const recoveredStore = new LodyOperationStore(storePath);
      try {
        const recovered = recoveredStore.get(
          baseInput().requesterSessionId,
          baseInput().operationId
        ).frozenContinuationConfig.targetDispatchConfigs?.[0];
        expect(recovered).toEqual(frozen);
        if (!recovered) throw new Error('Expected persisted create configuration');
        return recovered;
      } finally {
        recoveredStore.close();
      }
    };

    it('reopens and revalidates a derived default when ACP cache is still absent', async () => {
      const resolver = makeResolver();
      const frozen = await resolver.resolve({});
      expect(frozen).toMatchObject({ modeId, builtinDefaultModeId: modeId });
      const recovered = await roundTrip(frozen);

      await expect(resolver.resolve(recovered)).resolves.toEqual(frozen);
    });

    it('reads a legacy inherited-mode marker as inherited after SQLite recovery', async () => {
      const resolver = makeResolver(makeCapability(['plan']));
      const recovered = await roundTrip({
        modeId,
        inheritedBuiltinDefaultModeId: modeId,
        inheritSessionDefaults: false,
      });

      const revalidated = await resolver.resolve(recovered);
      expect(revalidated.modeId).toBeUndefined();
      expect(revalidated.inheritedBuiltinDefaultModeId).toBeUndefined();
      expect(revalidated.inheritedDispatchConfig).toBeUndefined();
    });

    it.each(['absent', 'supported'] as const)(
      'reopens an inherited default from an initially %s cache when cache is now absent',
      async (initialCache) => {
        const resolver = makeResolver(
          initialCache === 'supported' ? makeCapability([modeId]) : undefined
        );
        const frozen = await resolver.resolve({
          frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId },
        });
        expect(frozen).toMatchObject({ modeId, inheritedDispatchConfig: { modeId } });
        expect(frozen.builtinDefaultModeId).toBeUndefined();
        const recovered = await roundTrip(frozen);
        resolver.setCapability(undefined, false);

        await expect(resolver.resolve(recovered)).resolves.toEqual(frozen);
      }
    );

    describe.each([
      ['confirmed freshness', true],
      ['failed freshness with readable cache', false],
    ] as const)('after capability arrival with %s', (_freshness, confirmed) => {
      it.each([
        ['offered', true],
        ['unoffered', false],
      ] as const)('rederives an %s builtin default after reopening', async (_catalog, offered) => {
        const resolver = makeResolver();
        const frozen = await resolver.resolve({});
        expect(frozen).toMatchObject({ modeId, builtinDefaultModeId: modeId });
        const recovered = await roundTrip(frozen);
        resolver.setCapability(makeCapability(offered ? [modeId] : ['plan']), confirmed);

        const revalidated = await resolver.resolve(recovered);

        expect(revalidated.inheritSessionDefaults).toBe(false);
        expect(revalidated.modeId).toBe(offered ? modeId : undefined);
        expect(revalidated.builtinDefaultModeId).toBe(offered ? modeId : undefined);
        expect(recovered).toEqual(frozen);
      });

      it.each(['explicit', 'inherited'] as const)(
        'preserves the persisted %s mode origin when it is no longer advertised',
        async (source) => {
          const resolver = makeResolver(makeCapability([modeId]));
          const frozen = await resolver.resolve(
            source === 'explicit'
              ? { modeId }
              : { frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId } }
          );
          expect(frozen.modeId).toBe(modeId);
          expect(frozen.builtinDefaultModeId).toBeUndefined();
          expect(frozen.inheritedDispatchConfig).toEqual(
            source === 'inherited' ? { modeId } : undefined
          );
          const recovered = await roundTrip(frozen);
          resolver.setCapability(makeCapability(['plan']), confirmed);

          if (source === 'explicit') {
            await expect(resolver.resolve(recovered)).rejects.toThrow(
              confirmed
                ? `Unsupported ACP mode for the selected agent: ${modeId}`
                : `ACP mode is absent from the local replica: ${modeId}`
            );
          } else {
            const revalidated = await resolver.resolve(recovered);
            expect(revalidated.modeId).toBeUndefined();
            expect(revalidated.inheritedDispatchConfig).toBeUndefined();
          }
          expect(recovered).toEqual(frozen);
        }
      );

      it('drops an unsupported inherited no-cache selection once a capability catalog arrives', async () => {
        const resolver = makeResolver();
        const frozen = await resolver.resolve({
          frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId },
        });
        expect(frozen).toMatchObject({ modeId, inheritedDispatchConfig: { modeId } });
        expect(frozen.builtinDefaultModeId).toBeUndefined();
        const recovered = await roundTrip(frozen);
        resolver.setCapability(makeCapability(['plan']), confirmed);

        const revalidated = await resolver.resolve(recovered);
        expect(revalidated.modeId).toBeUndefined();
        expect(revalidated.inheritedDispatchConfig).toBeUndefined();
        expect(recovered).toEqual(frozen);
      });
    });
  });

  it('rejects operation id reuse with different semantic input', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      expect(() =>
        store.accept({ ...baseInput(), canonicalCommand: { prompt: 'implement' } })
      ).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_ID_REUSED' })
      );
    } finally {
      store.close();
    }
  });

  it('binds accept and retry lookup to requester and source Turn identity', async () => {
    const store = await makeStore();
    try {
      const input = baseInput();
      store.accept(input);

      expect(
        store.findMatchingRetry(
          input.requesterSessionId,
          input.operationId,
          input.kind,
          input.canonicalCommand,
          input.requesterUserId,
          input.frozenContinuationConfig.sourceTurnId
        )
      ).toMatchObject({ operationId: input.operationId });
      expect(() =>
        store.findMatchingRetry(
          input.requesterSessionId,
          input.operationId,
          input.kind,
          input.canonicalCommand,
          'user-2',
          input.frozenContinuationConfig.sourceTurnId
        )
      ).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_ID_REUSED' })
      );
      expect(() =>
        store.accept({
          ...input,
          frozenContinuationConfig: {
            ...input.frozenContinuationConfig,
            sourceTurnId: 'source-turn-2',
          },
        })
      ).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_ID_REUSED' })
      );
    } finally {
      store.close();
    }
  });

  it('scopes lookup to the requester Session', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      expect(() => store.get('another-session' as SessionId, 'review-round-1')).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_NOT_FOUND' })
      );
    } finally {
      store.close();
    }
  });

  it('atomically indexes one Inbox result when finishing', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const completion = {
        type: 'result' as const,
        value: {
          items: [
            {
              status: 'succeeded' as const,
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              assistantTurnId: 'assistant:turn-1',
            },
          ],
        },
      };
      store.finish('requester-1' as SessionId, 'review-round-1', completion);
      store.finish('requester-1' as SessionId, 'review-round-1', completion);

      expect(store.get('requester-1' as SessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion,
      });
      expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toEqual([
        expect.objectContaining({
          consumed: 0,
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it('indexes the same operation id independently for two Sessions', async () => {
    const store = await makeStore();
    try {
      const completion = { type: 'cancelled' as const };
      store.accept(baseInput());
      store.accept({
        ...baseInput(),
        requesterSessionId: 'requester-2' as SessionId,
      });

      store.finish('requester-1' as SessionId, 'review-round-1', completion);
      store.finish('requester-2' as SessionId, 'review-round-1', completion);

      expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toEqual([
        expect.objectContaining({
          requesterSessionId: 'requester-1',
        }),
        expect.objectContaining({
          requesterSessionId: 'requester-2',
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it('serializes item materialization across local processes and permits stale adoption', async () => {
    let nowMs = 1_000;
    const store = await makeStore(() => nowMs);
    try {
      const accepted = store.accept(baseInput(), { materializationClaimToken: 'acceptor' });
      expect(accepted.claimedItemIndexes).toEqual([0]);
      expect(
        store.claimItemMaterialization(
          'requester-1' as SessionId,
          'review-round-1',
          0,
          'lease-owner'
        )
      ).toEqual({ claimed: false, retryAtMs: 61_000 });

      nowMs = 61_000;
      expect(
        store.claimItemMaterialization(
          'requester-1' as SessionId,
          'review-round-1',
          0,
          'lease-owner'
        )
      ).toEqual({ claimed: true });
      expect(
        store.markItemInputDurable('requester-1' as SessionId, 'review-round-1', 0, 'acceptor')
          .items[0]
      ).toMatchObject({ inputDurable: false });
      expect(
        store.markItemInputDurable('requester-1' as SessionId, 'review-round-1', 0, 'lease-owner')
          .items[0]
      ).toMatchObject({ inputDurable: true });
    } finally {
      store.close();
    }
  });

  it('wins cancellation once and preserves the first terminal completion', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const first = store.cancel('requester-1' as SessionId, 'review-round-1');
      const retry = store.cancel('requester-1' as SessionId, 'review-round-1');

      expect(first.didCancel).toBe(true);
      expect(retry.didCancel).toBe(false);
      expect(retry.operation.completion?.type).toBe('cancelled');
      expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('shares accepted intent across local processes and adopts it after reopen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-shared-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const acceptingProcess = new LodyOperationStore(dbPath);
    const leaseOwnerProcess = new LodyOperationStore(dbPath);
    try {
      acceptingProcess.accept(baseInput());

      expect(
        leaseOwnerProcess.accept({
          ...baseInput(),
          canonicalCommand: { target: 'target-1', prompt: 'review' },
        })
      ).toMatchObject({ created: false, operation: { operationId: 'review-round-1' } });

      expect(
        leaseOwnerProcess.listActive('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toEqual([
        expect.objectContaining({
          operationId: 'review-round-1',
          items: [expect.objectContaining({ inputDurable: false })],
        }),
      ]);
    } finally {
      acceptingProcess.close();
      leaseOwnerProcess.close();
    }

    const replacementLeaseOwner = new LodyOperationStore(dbPath);
    try {
      expect(replacementLeaseOwner.get('requester-1' as SessionId, 'review-round-1')).toMatchObject(
        { state: 'active', operationId: 'review-round-1' }
      );
    } finally {
      replacementLeaseOwner.close();
    }
  });

  it('bounds completion text while preserving structure and exact omission bytes', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const originalMessage = 'failure '.repeat(20_000);
      const finished = store.finish('requester-1' as SessionId, 'review-round-1', {
        type: 'result',
        value: {
          items: [
            {
              status: 'failed',
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              error: { code: 'TARGET_FAILED', message: originalMessage, retryable: false },
            },
          ],
        },
      });
      expect(Buffer.byteLength(JSON.stringify(finished.completion), 'utf8')).toBeLessThanOrEqual(
        LODY_OPERATION_COMPLETION_MAX_BYTES
      );
      expect(finished.completion).toMatchObject({
        type: 'result',
        value: { items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' } }] },
        truncation: { truncated: true },
      });
      if (finished.completion?.type !== 'result') throw new Error('expected result');
      const item = finished.completion.value.items[0];
      if (item?.status !== 'failed') throw new Error('expected failed item');
      const keptOriginalBytes = Buffer.byteLength(item.error.message.replace('\n…\n', ''), 'utf8');
      expect(finished.completion.truncation?.omittedBytes).toBe(
        Buffer.byteLength(originalMessage, 'utf8') - keptOriginalBytes
      );
    } finally {
      store.close();
    }
  });

  it('persists bounded assistant output previews on successful items', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const originalOutput = 'result 🚀'.repeat(20_000);
      const finished = store.finish('requester-1' as SessionId, 'review-round-1', {
        type: 'result',
        value: {
          items: [
            {
              status: 'succeeded',
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              assistantTurnId: 'assistant:turn-1',
              output: { text: originalOutput },
            },
          ],
        },
      });
      if (finished.completion?.type !== 'result') throw new Error('expected result');
      const item = finished.completion.value.items[0];
      if (item?.status !== 'succeeded' || !item.output) {
        throw new Error('expected succeeded output');
      }
      expect(Buffer.byteLength(JSON.stringify(finished.completion), 'utf8')).toBeLessThanOrEqual(
        LODY_OPERATION_COMPLETION_MAX_BYTES
      );
      expect(item.output).toMatchObject({ truncated: true });
      expect(item.output.text).not.toContain('�');
    } finally {
      store.close();
    }
  });
});

describe('canonicalizeLodyCommand', () => {
  it('sorts object keys but preserves array order', () => {
    expect(canonicalizeLodyCommand({ b: 2, a: [{ z: 1, y: 2 }, 3] })).toBe(
      '{"a":[{"y":2,"z":1},3],"b":2}'
    );
  });
});

const readLastCleanupAtMs = (dbPath: string): string | undefined => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT value FROM orchestration_meta WHERE key = 'last_cleanup_at_ms'`)
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
};

describe('maintenance-free open', () => {
  it.each(['operation_progress_settlements', 'operation_retired_ids'])(
    'migrates a current delivery schema that lacks %s',
    async (table) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'lody-operation-store-progress-migration-')
      );
      roots.add(root);
      const dbPath = path.join(root, 'operations.sqlite3');
      const initial = new LodyOperationStore(dbPath);
      initial.close();

      const legacy = new Database(dbPath);
      legacy.exec(`DROP TABLE ${table}`);
      legacy.close();

      const migrated = new LodyOperationStore(dbPath, undefined, { maintenance: false });
      try {
        expect(migrated.accept(baseInput())).toMatchObject({ created: true });
        expect(
          migrated.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
        ).toEqual([]);
      } finally {
        migrated.close();
      }
    }
  );

  it('does not acquire the SQLite writer lock when the schema is current', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-readonly-open-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const owner = new LodyOperationStore(dbPath);
    owner.close();

    const writer = new Database(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    try {
      const nonOwner = new LodyOperationStore(dbPath, undefined, { maintenance: false });
      try {
        expect(queuedResults(nonOwner, 'workspace-1' as WorkspaceId)).toEqual([]);
      } finally {
        nonOwner.close();
      }
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('skips open-time repair/cleanup writes but still serves reads and writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-maint-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const now = () => Date.parse('2026-07-20T00:00:00Z');

    const nonOwner = new LodyOperationStore(dbPath, now, { maintenance: false });
    try {
      // No open-time cleanup ran, so the cleanup watermark was never written.
      expect(readLastCleanupAtMs(dbPath)).toBeUndefined();
      // The store is still fully usable for regular operations.
      expect(nonOwner.accept(baseInput()).created).toBe(true);
    } finally {
      nonOwner.close();
    }

    const owner = new LodyOperationStore(dbPath, now);
    try {
      // A default (owner) open performs maintenance and writes the watermark.
      expect(readLastCleanupAtMs(dbPath)).toBe(String(now()));
    } finally {
      owner.close();
    }
  });
});

describe('runWithOperationStoreBusyRetry', () => {
  const busyError = (code: string) => Object.assign(new Error('database is locked'), { code });

  it('retries SQLITE_BUSY with backoff and returns the eventual result', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await runWithOperationStoreBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError('SQLITE_BUSY');
        return 'ok';
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 300]);
  });

  it('surfaces exhausted busy retries as a retryable STORE_BUSY error', async () => {
    let attempts = 0;
    await expect(
      runWithOperationStoreBusyRetry(
        () => {
          attempts += 1;
          throw busyError('SQLITE_BUSY_SNAPSHOT');
        },
        { sleep: async () => undefined }
      )
    ).rejects.toMatchObject({
      name: 'LodyOperationStoreError',
      code: 'STORE_BUSY',
      retryable: true,
    });
    expect(attempts).toBe(4);
  });

  it('rethrows non-busy errors immediately without sleeping', async () => {
    const sleeps: number[] = [];
    await expect(
      runWithOperationStoreBusyRetry(
        () => {
          throw new LodyOperationStoreError('OPERATION_NOT_FOUND', 'missing', false);
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }
      )
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(sleeps).toEqual([]);
  });

  it('classifies only SQLITE_BUSY-family errors as busy', () => {
    expect(isOperationStoreBusyError(busyError('SQLITE_BUSY'))).toBe(true);
    expect(isOperationStoreBusyError(busyError('SQLITE_BUSY_SNAPSHOT'))).toBe(true);
    expect(isOperationStoreBusyError(busyError('SQLITE_CONSTRAINT'))).toBe(false);
    expect(isOperationStoreBusyError(new Error('database is locked'))).toBe(false);
    expect(isOperationStoreBusyError('database is locked')).toBe(false);
  });
});
