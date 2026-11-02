import type { LodyOperationItemResult, MachineId, SessionId, WorkspaceId } from '@lody/shared';
import Database from 'better-sqlite3';
import { Context, Deferred, Effect, Fiber, Layer, Scheduler } from 'effect';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LodyOperationStore } from '../operation-store';
import { inboxRepositoryLayer } from '../platform/inbox-repository';
import { ExecutionMembers, makeExecutionOwner } from './execution-owner';
import {
  batchDepth,
  batchPreview,
  INBOX_PREVIEW_BYTES,
  type InboxInput,
  type InboxRelease,
} from './model';
import { InboxExecution, InboxRepository, OperationInbox } from './service';

const roots: string[] = [];
const stores: LodyOperationStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture(now?: () => number) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-inbox-'));
  roots.push(root);
  const filename = path.join(root, 'operations.sqlite3');
  const store = new LodyOperationStore(filename, now);
  stores.push(store);
  const input: InboxInput = {
    workspaceId: 'workspace',
    sessionId: 'A',
    userId: 'human',
    inputId: 'user-1',
    kind: 'human',
    config: { prompt: 'current human request', chainDepth: 0 },
  };
  const sql = store.inbox;
  sql.activate(input.workspaceId, 'owner');
  const add = (id: string, depth = 0, items: LodyOperationItemResult[] = []) => {
    store.accept({
      workspaceId: input.workspaceId as WorkspaceId,
      ownerMachineId: 'machine' as MachineId,
      requesterSessionId: input.sessionId as SessionId,
      requesterUserId: input.userId,
      operationId: id,
      kind: 'session_chat',
      canonicalCommand: { operationId: id },
      frozenContinuationConfig: {
        sourceTurnId: 'source',
        inputConfig: { prompt: 'obsolete prompt' },
      },
      initiatorChainDepth: depth,
      createdAt: '2026-10-12T00:00:00.000Z',
      deadlineAt: '2026-10-13T00:00:00.000Z',
      items,
    });
    store.finish(input.sessionId as SessionId, id, { type: 'result', value: { items } });
  };
  const release = (outcome: InboxRelease['outcome'] = 'normal', executionId = 'execution-1') =>
    sql.release({ ...input, executionId, outcome });
  const start = () => {
    expect(sql.accept(input)).toBe(true);
    expect(sql.begin(input, 'execution-1')).toBe(true);
  };
  return { root, filename, store, sql, input, add, release, start };
}

async function runInboxChild(root: string, source: string): Promise<string> {
  const child = path.join(root, 'recover.mts');
  writeFileSync(child, source);
  const cliRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', path.join(cliRoot, 'node_modules/tsx/dist/loader.mjs'), child],
    {
      cwd: cliRoot,
      timeout: 20000,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(cliRoot, 'tsconfig.json') },
    }
  );
  return stdout.trim().split('\n').at(-1)!;
}

describe('durable Operation inbox', () => {
  it('automation cannot clear Stop or outrun a newly accepted human input', () => {
    const f = fixture();
    f.start();
    expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
    const automated: InboxInput = { ...f.input, inputId: 'event-1', kind: 'automation' };
    expect(f.sql.accept(automated)).toBe(false);
    f.release('user_stop');
    const human = { ...f.input, inputId: 'user-2' };
    expect(f.sql.accept(human)).toBe(true);
    expect(f.sql.accept(automated)).toBe(true);
    expect(f.sql.begin(automated, 'event-execution')).toBe(false);
    expect(f.sql.begin(human, 'human-execution')).toBe(true);
    f.sql.release({ ...human, executionId: 'human-execution', outcome: 'normal' });
    expect(f.sql.begin(automated, 'event-execution')).toBe(true);
  });
  it('an idle wakeable receipt survives reopen and duplicate release creates no second intent', () => {
    const f = fixture();
    f.start();
    f.release();
    expect(f.sql.pending('workspace')).toEqual([]);
    f.add('late');
    f.release();
    expect(f.sql.pending('workspace')).toHaveLength(1);
    const second = new LodyOperationStore(f.filename);
    stores.push(second);
    second.inbox.activate('workspace', 'replacement');
    const [intent] = second.inbox.pending('workspace');
    const batch = second.inbox.prepare(intent.input, 'replacement', intent.intentId)!;
    expect(second.inbox.members(batch).map((m) => m.operationId)).toEqual(['late']);
  });
  it('idle wake-intent failure rolls back completion and duplicate completion cannot create another batch', () => {
    const f = fixture();
    const db = new Database(f.filename);
    db.exec(
      "CREATE TRIGGER fail_idle_intent BEFORE INSERT ON inbox_intents BEGIN SELECT RAISE(ABORT,'intent outage'); END;"
    );
    expect(() => f.add('wake')).toThrow('intent outage');
    expect(f.store.get('A' as SessionId, 'wake').state).toBe('active');
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_results').get()).toEqual({ n: 0 });
    expect(f.sql.pending('workspace')).toEqual([]);
    db.exec('DROP TRIGGER fail_idle_intent');
    f.add('wake');
    f.add('wake');
    expect(f.sql.pending('workspace')).toHaveLength(1);
    const [intent] = f.sql.pending('workspace');
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    expect(batch.memberCount).toBe(1);
    f.sql.begin(batch, 'auto');
    f.sql.fence(batch, 'auto');
    f.sql.settle(batch, 'unknown');
    f.sql.release({ ...batch, executionId: 'auto', outcome: 'failed' });
    f.add('wake');
    expect(f.sql.pending('workspace')).toEqual([]);
    db.close();
  });
  it('one wakeable receipt carries passive results and claim fixes membership across workers', () => {
    const f = fixture();
    f.start();
    f.add('passive');
    const db = new Database(f.filename);
    db.exec('UPDATE inbox_results SET automatic_eligible=0');
    f.release();
    expect(f.sql.pending('workspace')).toEqual([]);
    f.add('wake');
    f.add('coalesced');
    const [intent] = f.sql.pending('workspace');
    expect(f.sql.pending('workspace')).toHaveLength(1);
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    f.add('after-claim');
    const other = new LodyOperationStore(f.filename);
    stores.push(other);
    expect(other.inbox.prepare(intent.input, 'owner', intent.intentId)?.batchId).toBe(
      batch.batchId
    );
    expect(f.sql.members(batch).map((m) => m.operationId)).toEqual([
      'passive',
      'wake',
      'coalesced',
    ]);
    expect(f.sql.begin(batch, 'auto')).toBe(true);
    expect(f.sql.fence(batch, 'auto')).toBe(true);
    f.sql.settle(batch, 'settled');
    f.sql.release({ ...batch, executionId: 'auto', outcome: 'normal' });
    const [next] = f.sql.pending('workspace');
    expect(
      f.sql.members(f.sql.prepare(next.input, 'owner', next.intentId)!).map((m) => m.operationId)
    ).toEqual(['after-claim']);
    db.close();
  });
  it.each(['user_stop', 'failed'] as const)(
    'late wakeable receipts respect Stop and continue after a failed release (%s)',
    (outcome) => {
      const f = fixture();
      f.start();
      if (outcome === 'user_stop') expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
      f.release(outcome);
      f.add('late');
      const other = new LodyOperationStore(f.filename);
      stores.push(other);
      other.inbox.activate('workspace', 'replacement');
      expect(other.inbox.pending('workspace')).toHaveLength(outcome === 'user_stop' ? 0 : 1);
    }
  );
  it('withdraws only an unsubmitted execution and keeps its input admissible', () => {
    const f = fixture();
    f.add('result');
    f.start();
    const batch = f.sql.prepare(f.input, 'owner')!;
    expect(f.sql.withdraw(f.input, 'execution-1')).toBe(true);
    expect(f.sql.inputEnded('workspace', 'A', 'user-1')).toBe(false);
    // The same execution id begins again and keeps the prepared claim.
    expect(f.sql.begin(f.input, 'execution-1')).toBe(true);
    expect(f.sql.prepare(f.input, 'owner')?.batchId).toBe(batch.batchId);
    // A fenced submission makes withdrawal impossible.
    expect(f.sql.fence(batch, 'execution-1')).toBe(true);
    expect(f.sql.withdraw(f.input, 'execution-1')).toBe(false);
    f.sql.settle(batch, 'settled');
    f.release('normal');
    expect(f.sql.inputEnded('workspace', 'A', 'user-1')).toBe(true);
    expect(f.sql.withdraw(f.input, 'execution-1')).toBe(false);
    expect(f.sql.begin(f.input, 'execution-1')).toBe(false);
  });
  it('keeps eight arrivals passive until one normal release and one fixed batch', () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`result-${n}`);
    expect(f.sql.pending('workspace')).toEqual([]);
    f.release();
    const [intent] = f.sql.pending('workspace');
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    f.add('late-nine');
    f.release();
    expect(batch.memberCount).toBe(8);
    expect(f.sql.members(batch).map((x) => x.operationId)).toEqual(
      Array.from({ length: 8 }, (_, n) => `result-${n}`)
    );
    expect(f.sql.begin(batch, 'automatic')).toBe(true);
    expect(f.sql.fence(batch, 'automatic')).toBe(true);
    f.sql.settle(batch, 'settled');
    f.sql.release({ ...batch, executionId: 'automatic', outcome: 'normal' });
    expect(f.sql.pending('workspace').map((x) => x.input.inputId)).toEqual(['inbox:automatic']);
  });
  it('does not launch an empty successor after all eight results are consumed', () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`result-${n}`);
    f.release();
    const [intent] = f.sql.pending('workspace');
    const b = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    f.sql.begin(b, 'auto');
    expect(f.sql.fence(b, 'auto')).toBe(true);
    f.sql.settle(b, 'settled');
    f.sql.release({ ...b, executionId: 'auto', outcome: 'normal' });
    expect(f.sql.pending('workspace')).toEqual([]);
  });
  it('reopens a pending intent and includes arrivals before claim', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    f.add('late');
    const other = new LodyOperationStore(f.filename);
    stores.push(other);
    other.inbox.activate('workspace', 'new-owner');
    const [intent] = other.inbox.pending('workspace');
    const b = other.inbox.prepare(intent.input, 'new-owner', intent.intentId)!;
    expect(other.inbox.members(b).map((x) => x.operationId)).toEqual(['one', 'late']);
  });
  it('atomically settles an intent that lost its eligible members without creating an empty batch', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const db = new Database(f.filename);
    db.prepare('UPDATE inbox_results SET consumed=1').run();
    db.close();
    expect(f.sql.prepare(intent.input, 'owner', intent.intentId)).toBeUndefined();
    expect(f.sql.pending('workspace')).toEqual([]);
  });
  it.each(['human', 'task'] as const)(
    'Stop keeps old queued input canceled and fresh %s input clears pause',
    (kind) => {
      const f = fixture();
      f.start();
      const queued = { ...f.input, inputId: 'queued-before-stop' };
      f.sql.accept(queued);
      f.add('one');
      expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
      f.release('user_stop');
      expect(f.sql.accept(queued)).toBe(false);
      expect(f.sql.pending('workspace')).toEqual([]);
      const fresh = { ...f.input, kind, inputId: `fresh-${kind}` };
      expect(f.sql.accept(fresh)).toBe(true);
      expect(f.sql.prepare(fresh, 'owner')?.memberCount).toBe(1);
    }
  );
  it('Stop still targets running execution after newer input is accepted', () => {
    const f = fixture();
    f.start();
    f.sql.accept({ ...f.input, inputId: 'queued-new' });
    expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
    expect(f.sql.pause(f.input, 'stale')).toBe(false);
  });
  it('fresh human identity and depth are independent of attached old results', () => {
    const f = fixture();
    f.add('old-deep', 15);
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    expect(b.chainDepth).toBe(0);
    expect(b.config.prompt).toBe('current human request');
    expect(f.sql.members(b)[0].chainDepth).toBe(15);
    expect(batchDepth({ ...f.input, kind: 'automatic' }, [15])).toBe(16);
  });
  it('a newer human acceptance invalidates automatic preparation before submission', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const auto = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    const human = { ...f.input, inputId: 'new-user' };
    f.sql.accept(human);
    const merged = f.sql.prepare(human, 'owner')!;
    expect(f.sql.getBatch(auto.batchId, auto)?.state).toBe('superseded');
    expect(f.sql.begin(merged, 'new-exec')).toBe(true);
    expect(f.sql.fence(auto, 'new-exec')).toBe(false);
    expect(f.sql.fence(merged, 'new-exec')).toBe(true);
    expect(f.sql.members(merged)).toHaveLength(1);
  });
  it('two SQLite connections preserve one claim, and unknown never becomes resubmittable after reopen', () => {
    const f = fixture();
    f.add('one');
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    const other = new LodyOperationStore(f.filename);
    stores.push(other);
    expect(other.inbox.prepare({ ...f.input, inputId: 'racing' }, 'owner')).toBeUndefined();
    f.sql.begin(f.input, 'exec');
    expect(f.sql.fence(b, 'exec')).toBe(true);
    f.sql.settle(b, 'unknown', 'disconnect');
    other.inbox.activate('workspace', 'new-owner');
    expect(other.inbox.getBatch(b.batchId, b)?.state).toBe('unknown');
    expect(other.inbox.prepare(f.input, 'new-owner')).toBeUndefined();
    expect(other.inbox.fence(b, 'exec')).toBe(false);
    expect(
      (other as unknown as { db: Database.Database }).db
        .prepare("SELECT consumed FROM inbox_results WHERE session_id='A' AND operation_id='one'")
        .get()
    ).toEqual({ consumed: 1 });
  });
  it('a failed release grants no automatic continuation', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release('failed');
    expect(f.sql.pending('workspace')).toEqual([]);
  });
  it('denies foreign batch lookup and has no per-result execution tables', () => {
    const f = fixture();
    f.add('one');
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    expect(f.sql.getBatch(b.batchId, { ...f.input, userId: 'foreign' })).toBeUndefined();
    const db = new Database(f.filename);
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('deliveries','delivery_execution_state')"
          )
          .all()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('index insertion rolls back with the real completion transaction', () => {
    const f = fixture();
    const db = new Database(f.filename);
    db.exec(
      "CREATE TRIGGER reject_index BEFORE INSERT ON inbox_results BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;"
    );
    expect(() => f.add('atomic')).toThrow('injected completion failure');
    expect(f.store.get('A' as SessionId, 'atomic').state).toBe('active');
    expect(db.prepare('SELECT * FROM inbox_results').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='deliveries'").all()).toEqual([]);
    db.close();
  });
  it('native service submits user-plus-results under the same admission as Stop', async () => {
    const f = fixture();
    f.add('one');
    const received: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* OperationInbox;
          yield* inbox.accept(f.input);
          yield* inbox.begin(f.input, 'exec');
          const b = yield* inbox.prepare(f.input);
          yield* inbox.pause(f.input, 'exec');
          const denied = yield* Effect.exit(
            inbox.submit(b, f.input, 'exec', () => received.push('user+result'))
          );
          expect(denied._tag).toBe('Failure');
          expect(received).toEqual([]);
          expect(f.sql.getBatch(b!.batchId, f.input)?.state).toBe('superseded');
        }).pipe(
          Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
        )
      )
    );
  });
  it('uses one execution slot across requester identities and Stop cancels their queued input', () => {
    const f = fixture();
    f.start();
    const other = { ...f.input, userId: 'other', inputId: 'other-task', kind: 'task' as const };
    expect(f.sql.accept(other)).toBe(true);
    expect(f.sql.begin(other, 'overlap')).toBe(false);
    f.sql.pause(f.input, 'execution-1', [other.inputId]);
    f.release('user_stop');
    expect(f.sql.accept(other)).toBe(false);
    expect(f.sql.begin(other, 'stale-owner')).toBe(false);
    const fresh = { ...other, inputId: 'after-stop' };
    expect(f.sql.accept(fresh)).toBe(true);
    expect(f.sql.begin(fresh, 'new-owner')).toBe(true);
  });
  it('rolls back the entire automatic-to-human transfer when a member write fails', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const automatic = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    const db = new Database(f.filename);
    db.exec(
      `CREATE TRIGGER fail_transfer BEFORE INSERT ON inbox_members WHEN NEW.batch_id <> '${automatic.batchId}' BEGIN SELECT RAISE(ABORT,'transfer failed'); END;`
    );
    const human = { ...f.input, inputId: 'new-human' };
    expect(() => f.sql.accept(human)).toThrow('transfer failed');
    expect(f.sql.getBatch(automatic.batchId, automatic)?.state).toBe('prepared');
    expect(db.prepare('SELECT claim FROM inbox_results').get()).toEqual({
      claim: automatic.batchId,
    });
    expect(f.sql.inputKind(human, human.inputId)).toBeUndefined();
    db.exec('DROP TRIGGER fail_transfer');
    db.close();
    f.sql.accept(human);
    const replacement = f.sql.prepare(human, 'owner')!;
    expect(replacement.memberCount).toBe(1);
    expect(f.sql.getBatch(automatic.batchId, automatic)?.state).toBe('superseded');
  });
  it('startup native worker coalesces pending arrivals without injecting any new event', async () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`saved-${n}`);
    f.release();
    f.add('late-nine');
    const received: Array<{ batchId: string; ids: string[] }> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const execution = Layer.succeed(InboxExecution, {
            ready: () => true,
            admit: () => true,
            report: () => Effect.void,
            launch: (batch) =>
              Effect.gen(function* () {
                const repo = yield* InboxRepository;
                expect(yield* repo.begin(batch, 'recovered')).toBe(true);
                expect(yield* repo.fence(batch, 'recovered')).toBe(true);
                received.push({
                  batchId: batch.batchId,
                  ids: f.sql.members(batch).map((m) => m.operationId),
                });
                yield* repo.settle(batch, 'settled');
                yield* Deferred.succeed(done, undefined);
              }).pipe(Effect.provide(inboxRepositoryLayer(f.sql))),
          });
          const layer = OperationInbox.layer('workspace', 'owner').pipe(
            Layer.provide(Layer.merge(inboxRepositoryLayer(f.sql), execution))
          );
          yield* Effect.gen(function* () {
            yield* OperationInbox;
            yield* Deferred.await(done);
          }).pipe(Effect.provide(layer));
          expect(received).toHaveLength(1);
          expect(received[0].ids).toEqual([
            ...Array.from({ length: 8 }, (_, n) => `saved-${n}`),
            'late-nine',
          ]);
        })
      )
    );
  });
  it('a failed pause write vetoes even batch-free transport admission', async () => {
    const f = fixture();
    const db = new Database(f.filename);
    const received: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            yield* inbox.accept(f.input);
            yield* inbox.begin(f.input, 'exec');
            db.exec(
              "CREATE TRIGGER fail_pause BEFORE UPDATE OF paused ON inbox_sessions WHEN NEW.paused=1 BEGIN SELECT RAISE(ABORT,'pause write failed'); END;"
            );
            const stopped = yield* Effect.exit(inbox.pause(f.input, 'exec'));
            expect(stopped._tag).toBe('Failure');
            const submission = yield* Effect.exit(
              inbox.submit(undefined, f.input, 'exec', () => received.push('unexpected'))
            );
            expect(submission._tag).toBe('Failure');
            expect(received).toEqual([]);
            db.exec('DROP TRIGGER fail_pause');
            // A later Stop succeeds first; retain the earlier failed request's identity too.
            yield* inbox.pause(f.input, 'exec', [], 'second-stop');
            const fresh = { ...f.input, inputId: 'new-human-after-failed-stop' };
            yield* inbox.accept(fresh);
            expect(f.sql.inputCanceled('workspace', 'A', f.input.inputId)).toBe(true);
            expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
            expect(yield* inbox.pause(f.input, 'exec')).toBe(true);
            expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
            expect(
              (yield* Effect.exit(
                inbox.submit(undefined, f.input, 'exec', () => received.push('old'))
              ))._tag
            ).toBe('Failure');
            yield* inbox.release({ ...f.input, executionId: 'exec', outcome: 'user_stop' });
            expect(yield* inbox.begin(fresh, 'fresh-exec')).toBe(true);
            yield* inbox.submit(undefined, fresh, 'fresh-exec', () => received.push('fresh'));
            expect(received).toEqual(['fresh']);
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          )
        )
      );
    } finally {
      db.close();
    }
  });
});

describe('Inbox recovery and retained settlement', () => {
  it.each(['active', 'orphan', 'receipt-outage'])(
    'retires legacy active input and unlocks restart (%s)',
    (kind) => {
      const orphan = kind === 'orphan';
      const f = fixture(() => 0);
      f.start();
      f.add('submitted');
      const batch = f.sql.prepare(f.input, 'owner')!;
      expect(f.sql.fence(batch, 'execution-1')).toBe(true);
      const queued = { ...f.input, inputId: 'queued-human' };
      f.sql.accept(queued);
      const db = new Database(f.filename);
      db.exec(`UPDATE inbox_sessions SET blocked=1${orphan ? ',active_execution=NULL' : ''}`);
      if (kind === 'receipt-outage')
        db.exec(
          "CREATE TRIGGER fail_diagnostic BEFORE INSERT ON inbox_releases BEGIN SELECT RAISE(ABORT,'diagnostic outage'); END;"
        );
      const reopened = new LodyOperationStore(f.filename, () => 0);
      stores.push(reopened);
      reopened.inbox.activate('workspace', 'replacement');
      expect(reopened.inbox.state(f.input)).toMatchObject({
        active_execution: null,
        active_input: null,
      });
      expect(db.prepare('SELECT blocked FROM inbox_sessions').get()).toEqual({ blocked: 0 });
      // Crossed fences are permanently unknown, including orphan legacy blocks.
      expect(reopened.inbox.getBatch(batch.batchId, f.input)?.state).toBe('unknown');
      expect(reopened.inbox.inputEnded('workspace', 'A', f.input.inputId)).toBe(true);
      expect(reopened.inbox.begin(f.input, 'old-replay', 'replacement')).toBe(false);
      expect(reopened.inbox.inputEnded('workspace', 'A', queued.inputId)).toBe(false);
      expect(reopened.inbox.begin(queued, 'successor', 'replacement')).toBe(true);
      expect(reopened.inbox.prepare(queued, 'replacement')).toBeUndefined();
      db.close();
    }
  );

  it('failed retirement keeps its receipt and admits another requester', () => {
    const f = fixture();
    f.start();
    f.sql.release({
      ...f.input,
      executionId: 'execution-1',
      outcome: 'failed',
      cause: 'termination failed',
    });
    const fresh = { ...f.input, userId: 'other-human', inputId: 'fresh' };
    f.sql.accept(fresh);
    expect(f.sql.begin(fresh, 'successor')).toBe(true);
    const db = new Database(f.filename);
    expect(db.prepare('SELECT outcome FROM inbox_releases').get()).toEqual({ outcome: 'failed' });
    db.close();
  });

  it('applied human steer transfers authority without changing the actual execution identity', () => {
    const f = fixture();
    f.start();
    f.add('one');
    const next = {
      ...f.input,
      inputId: 'steered-user',
      config: { prompt: 'new request', chainDepth: 0 },
    };
    expect(f.sql.adoptExecution(f.input, next, 'execution-1')).toBe(true);
    expect(f.sql.canSubmit(next, 'execution-1', 'owner')).toBe(true);
    expect(f.sql.pause(next, 'display-assistant-2')).toBe(false);
    expect(f.sql.pause(next, 'execution-1')).toBe(true);
    f.sql.release({ ...next, executionId: 'execution-1', outcome: 'user_stop' });
    expect(f.sql.pending('workspace')).toEqual([]);
    expect(f.sql.inputCanceled(next.workspaceId, next.sessionId, next.inputId)).toBe(true);
  });

  it('retains a failed settlement and retries only its SQL receipt after the outage', async () => {
    const f = fixture();
    f.add('one');
    const db = new Database(f.filename);
    const submitted: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            yield* inbox.accept(f.input);
            yield* inbox.begin(f.input, 'exec');
            const b = (yield* inbox.prepare(f.input))!;
            yield* inbox.submit(b, f.input, 'exec', () => submitted.push(b.batchId));
            db.exec(
              "CREATE TRIGGER fail_settle BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement outage'); END;"
            );
            yield* inbox.settle(b, 'settled');
            expect(f.sql.getBatch(b.batchId, b)?.state).toBe('submitting');
            db.exec('DROP TRIGGER fail_settle');
            // Scope finalization flushes the retained receipt without executing transport.
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          )
        )
      );
      const [batch] = db.prepare('SELECT batch_id,state FROM inbox_batches').all() as {
        batch_id: string;
        state: string;
      }[];
      expect(batch.state).toBe('settled');
      expect(submitted).toEqual([batch.batch_id]);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM inbox_results WHERE consumed=0').get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('does not lose the next natural-release signal while the prior launch is still returning', async () => {
    const f = fixture();
    f.start();
    f.add('first');
    f.release();
    const received: string[][] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          let inbox: Context.Service.Shape<typeof OperationInbox>;
          const execution = Layer.succeed(InboxExecution, {
            ready: () => true,
            admit: () => true,
            report: () => Effect.void,
            launch: (batch) =>
              Effect.gen(function* () {
                yield* Deferred.await(ready);
                const id = `auto-${received.length}`;
                expect(yield* inbox.begin(batch, id)).toBe(true);
                yield* inbox.submit(batch, batch, id, () =>
                  received.push(f.sql.members(batch).map((m) => m.operationId))
                );
                yield* inbox.settle(batch, 'settled');
                if (received.length === 1) f.add('second');
                yield* inbox.release({ ...batch, executionId: id, outcome: 'normal' });
                if (received.length === 2) yield* Deferred.succeed(done, undefined);
              }),
          });
          yield* Effect.gen(function* () {
            inbox = yield* OperationInbox;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(done);
          }).pipe(
            Effect.provide(
              OperationInbox.layer('workspace', 'owner').pipe(
                Layer.provide(Layer.merge(inboxRepositoryLayer(f.sql), execution))
              )
            )
          );
        })
      )
    );
    expect(received).toEqual([['first'], ['second']]);
    expect(f.sql.pending('workspace')).toEqual([]);
  });
});

it('reads an oversized member in bounded fragments without dropping any result bytes', async () => {
  const { batchPage, INBOX_READ_BYTES } = await import('./batch-page');
  const member = {
    sequence: 1,
    operationId: 'large',
    operationKind: 'session_chat' as const,
    chainDepth: 0,
    completion: { text: '中文😀'.repeat(40_000) },
  };
  let offset = 0;
  let restored = '';
  let pageCount = 0;
  do {
    const page = batchPage([member], 20, offset);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(INBOX_READ_BYTES);
    const fragment = page.items[0]!;
    expect('jsonChunk' in fragment).toBe(true);
    if (!('jsonChunk' in fragment)) throw new Error('Missing fragment');
    restored += fragment.jsonChunk;
    pageCount++;
    offset = page.next ? Number(page.next.split(':')[1]) : 0;
  } while (offset);
  expect(pageCount).toBeGreaterThan(1);
  expect(JSON.parse(restored)).toEqual(member);
});

it('a later queued human input does not invalidate the human execution already being prepared', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const own = f.sql.prepare(f.input, 'owner')!;
  const next = { ...f.input, inputId: 'later-human' };
  expect(f.sql.accept(next)).toBe(true);
  expect(f.sql.getBatch(own.batchId, own)?.state).toBe('prepared');
  expect(f.sql.fence(own, 'execution-1')).toBe(true);
  expect(f.sql.members(own).map((m) => m.operationId)).toEqual(['one']);
});

it('a fresh human can clear pause without reviving the execution canceled by Stop', () => {
  const f = fixture();
  f.start();
  expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
  expect(f.sql.accept({ ...f.input, inputId: 'post-stop-human' })).toBe(true);
  expect(f.sql.canSubmit(f.input, 'execution-1', 'owner')).toBe(false);
});

it('execution owner retains cleanup handles and serializes recovery without resubmitting the batch', async () => {
  const f = fixture();
  f.add('owned');
  f.sql.accept(f.input);
  const received: string[] = [];
  let alive = true;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const terminating = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const journal = Layer.succeed(ExecutionMembers, {
          members: (batch) => Effect.try(() => f.sql.members(batch)),
        });
        const dependencies = Layer.mergeAll(
          inboxRepositoryLayer(f.sql),
          journal,
          Layer.succeed(InboxExecution, {
            ready: () => false,
            admit: () => true,
            launch: () => Effect.void,
            report: () => Effect.void,
          })
        );
        yield* Effect.gen(function* () {
          const owner = yield* makeExecutionOwner(f.input, 'owned-execution');
          yield* owner.register({
            key: {},
            terminate: Deferred.succeed(terminating, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  alive = false;
                })
              )
            ),
          });
          yield* owner.submit(() => received.push(owner.batch!.batchId));
          yield* owner.finish('user_stop', new Error('resource release failed'));
          expect(owner.phase).toBe('failed');
          const first = yield* owner
            .recover(Effect.void, Effect.void)
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(terminating);
          const second = yield* owner
            .recover(Effect.void, Effect.void)
            .pipe(Effect.forkScoped({ startImmediately: true }));
          expect(second.pollUnsafe()).toBeUndefined();
          expect(alive).toBe(true);
          // A failed release returns the slot; cleanup never gates a successor.
          const successor = { ...f.input, inputId: 'successor' };
          f.sql.accept(successor);
          expect(f.sql.begin(successor, 'successor')).toBe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          yield* owner.awaitReleased;
          expect(alive).toBe(false);
          expect(owner.phase).toBe('released');
          expect(f.sql.getBatch(owner.batch!.batchId, owner.input)?.state).toBe('unknown');
          expect(received).toEqual([owner.batch!.batchId]);
          expect(f.sql.pending('workspace')).toEqual([]);
        }).pipe(
          Effect.provide(
            OperationInbox.layer('workspace', 'owner').pipe(Layer.provideMerge(dependencies))
          )
        );
      })
    )
  );
});

it('keeps the original shared failed shutdown receipt and recovers settlement through a new repository', async () => {
  const { operationInboxLegacy } = await import('./legacy');
  const f = fixture();
  f.add('one');
  const received: string[] = [];
  const bridge = operationInboxLegacy({
    workspaceId: 'workspace',
    owner: 'owner',
    sql: f.sql,
    ready: () => true,
    admit: () => true,
    launch: async () => {},
    report: () => {},
    openRecoveryRepository: () => {
      const store = new LodyOperationStore(f.filename);
      return { sql: store.inbox, close: () => store.close() };
    },
  });
  await bridge.accept(f.input);
  const owner = await bridge.openExecution(f.input, 'exec');
  const batch = owner.batch!;
  await owner.submit(() => received.push(batch.batchId));
  const db = new Database(f.filename);
  db.exec(
    "CREATE TRIGGER fail_close_settlement BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'outage'); END;"
  );
  await owner.finish('normal');
  const first = bridge.close();
  expect(bridge.close()).toBe(first);
  await expect(first).rejects.toHaveProperty('cause');
  expect(db.prepare('SELECT state FROM inbox_batches').get()).toEqual({ state: 'submitted' });
  db.exec('DROP TRIGGER fail_close_settlement');
  await bridge.recoverClose();
  expect(db.prepare('SELECT state FROM inbox_batches').get()).toEqual({ state: 'settled' });
  expect(received).toEqual([batch.batchId]);
  db.close();
});

it('Stop at the normal-release gap supersedes the fixed intent before an extra execution', () => {
  const f = fixture();
  f.start();
  f.add('one');
  f.release();
  expect(f.sql.pending('workspace')).toHaveLength(1);
  expect(f.sql.pauseTarget('workspace', 'A', 'execution-1')).toMatchObject({
    executionId: 'execution-1',
  });
  expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
  expect(f.sql.pending('workspace')).toEqual([]);
  expect(f.sql.accept({ ...f.input, kind: 'task', inputId: 'reply' })).toBe(true);
});

it('retries release recording and snapshots all queued arrivals at claim', async () => {
  const f = fixture();
  const db = new Database(f.filename);
  const deps = Layer.merge(
    inboxRepositoryLayer(f.sql),
    Layer.succeed(InboxExecution, {
      ready: () => false,
      admit: () => true,
      launch: () => Effect.void,
      report: () => Effect.void,
    })
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* OperationInbox;
          yield* inbox.accept(f.input);
          yield* inbox.begin(f.input, 'exec');
          f.add('first');
          db.exec(
            "CREATE TRIGGER fail_release BEFORE INSERT ON inbox_intents BEGIN SELECT RAISE(ABORT,'release outage'); END;"
          );
          const event = Object.freeze({
            ...f.input,
            executionId: 'exec',
            outcome: 'normal' as const,
          });
          expect((yield* Effect.exit(inbox.release(event)))._tag).toBe('Failure');
          expect(event).not.toHaveProperty('releaseWatermark');
          expect(event.outcome).toBe('normal');
          f.add('late');
          db.exec('DROP TRIGGER fail_release');
        }).pipe(
          Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
        )
      )
    );
    const intent = f.sql.pending('workspace')[0]!;
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    expect(f.sql.members(batch).map((m) => m.operationId)).toEqual(['first', 'late']);
  } finally {
    db.close();
  }
});

it('a failed pre-transport human batch releases its claim so fresh human input can carry the results', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const abandoned = f.sql.prepare(f.input, 'owner')!;
  f.release('failed');
  expect(f.sql.getBatch(abandoned.batchId, abandoned)?.state).toBe('superseded');
  const fresh = { ...f.input, inputId: 'fresh-human' };
  f.sql.accept(fresh);
  const batch = f.sql.prepare(fresh, 'owner')!;
  expect(f.sql.members(batch).map((m) => m.operationId)).toEqual(['one']);
  expect(f.sql.members(abandoned).map((m) => m.operationId)).toEqual(['one']);
});

it('a superseded automatic input cannot reserve the execution slot ahead of fresh human input', () => {
  const f = fixture();
  f.start();
  f.add('one');
  f.release();
  const intent = f.sql.pending('workspace')[0]!;
  const old = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
  const fresh = { ...f.input, inputId: 'fresh' };
  f.sql.accept(fresh);
  expect(f.sql.begin(old, 'stale-auto', 'owner')).toBe(false);
  expect(f.sql.begin(fresh, 'fresh-owner', 'owner')).toBe(true);
});

it('duplicate Stop delivery cannot pause a fresh input, but a new Stop can', () => {
  const f = fixture();
  f.start();
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-one')).toBe(true);
  f.release('user_stop');
  const fresh = { ...f.input, inputId: 'fresh-human' };
  expect(f.sql.accept(fresh)).toBe(true);
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-one')).toBe(true);
  expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-two')).toBe(true);
  expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(true);
});

it('internal cancellation vetoes the old input without persisting a message pause', () => {
  const f = fixture();
  f.start();
  expect(f.sql.cancelExecution(f.input, 'execution-1')).toBe(true);
  const fresh = { ...f.input, inputId: 'fresh' };
  f.sql.accept(fresh);
  expect(f.sql.adoptExecution(f.input, fresh, 'execution-1')).toBe(false);
  expect(f.sql.canSubmit(f.input, 'execution-1', 'owner')).toBe(false);
  f.release('failed');
  const task = { ...f.input, inputId: 'new-task', kind: 'task' as const };
  expect(f.sql.accept(task)).toBe(true);
  expect(f.sql.begin(task, 'task-execution')).toBe(true);
});

it('quiescing closes actual transport admission even for a prepared ordinary input', async () => {
  const f = fixture();
  const received: string[] = [];
  const deps = Layer.merge(
    inboxRepositoryLayer(f.sql),
    Layer.succeed(InboxExecution, {
      ready: () => false,
      admit: () => true,
      launch: () => Effect.void,
      report: () => Effect.void,
    })
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inbox = yield* OperationInbox;
        yield* inbox.accept(f.input);
        yield* inbox.begin(f.input, 'exec');
        yield* inbox.quiesce;
        expect(
          (yield* Effect.exit(
            inbox.submit(undefined, f.input, 'exec', () => received.push('received'))
          ))._tag
        ).toBe('Failure');
        expect(received).toEqual([]);
      }).pipe(Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps))))
    )
  );
});

it('owner replacement settles a crossed fence as unknown without making its members eligible again', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const batch = f.sql.prepare(f.input, 'owner')!;
  expect(f.sql.fence(batch, 'execution-1')).toBe(true);
  const other = new LodyOperationStore(f.filename);
  stores.push(other);
  other.inbox.activate('workspace', 'replacement');
  expect(other.inbox.getBatch(batch.batchId, batch)?.state).toBe('unknown');
  expect(
    (other as unknown as { db: Database.Database }).db
      .prepare("SELECT consumed FROM inbox_results WHERE session_id='A' AND operation_id='one'")
      .get()
  ).toEqual({ consumed: 1 });
  const next = { ...f.input, inputId: 'fresh' };
  other.inbox.accept(next);
  expect(other.inbox.prepare(next, 'replacement')).toBeUndefined();
});

it('expires consumed copied payloads with Operations, retaining unconsumed results and Stop identities', () => {
  let time = Date.parse('2026-10-12T00:00:00Z');
  const f = fixture(() => time);
  f.start();
  f.add('consumed');
  const batch = f.sql.prepare(f.input, 'owner')!;
  f.sql.fence(batch, 'execution-1');
  f.sql.settle(batch, 'settled');
  f.release('failed');
  f.add('waiting');
  time += 8 * 24 * 60 * 60 * 1000;
  const other = new LodyOperationStore(f.filename, () => time);
  stores.push(other);
  expect(other.inbox.getBatch(batch.batchId, batch)).toBeUndefined();
  const fresh = { ...f.input, inputId: 'fresh' };
  other.inbox.accept(fresh);
  const waiting = other.inbox.prepare(fresh, 'owner')!;
  expect(other.inbox.members(waiting).map((m) => m.operationId)).toEqual(['waiting']);
  other.deleteRequesterSession('A' as SessionId);
  const db = new Database(f.filename);
  for (const table of [
    'inbox_results',
    'inbox_members',
    'inbox_batches',
    'inbox_inputs',
    'inbox_releases',
    'inbox_resources',
    'inbox_stops',
  ])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  db.close();
});

it('an OS child recovers the wake intent and claims all nine queued receipts', async () => {
  const f = fixture();
  f.start();
  for (let i = 0; i < 8; i++) f.add(`result-${i}`);
  f.release();
  f.add('late-nine');
  f.store.close();
  const storePath = fileURLToPath(new URL('../operation-store.ts', import.meta.url));
  const servicePath = fileURLToPath(new URL('./service.ts', import.meta.url));
  const stdout = await runInboxChild(
    f.root,
    `
    import {LodyOperationStore} from ${JSON.stringify(storePath)};
    import {OperationInbox,InboxExecution} from ${JSON.stringify(servicePath)};
    import {inboxRepositoryLayer} from ${JSON.stringify(fileURLToPath(new URL('../platform/inbox-repository.ts', import.meta.url)))};
    import {Effect,Layer,Deferred} from ${JSON.stringify(fileURLToPath(new URL('../../../node_modules/effect/dist/index.js', import.meta.url)))};
    const store=new LodyOperationStore(${JSON.stringify(f.filename)});
    store.inbox.activate('workspace','child');
    const received=[];
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const done=yield* Deferred.make();
      const execution=Layer.succeed(InboxExecution,{
        ready:()=>true,admit:()=>true,report:()=>Effect.void,
        launch:batch=>Effect.gen(function*(){
          store.inbox.begin(batch,'child-exec','child');
          store.inbox.fence(batch,'child-exec');
          received.push(store.inbox.members(batch).map(m=>m.operationId));
          store.inbox.settle(batch,'settled');
          store.inbox.release({...batch,executionId:'child-exec',outcome:'failed'});
          yield* Deferred.succeed(done,undefined);
        })
      });
      yield* Effect.gen(function*(){yield* OperationInbox;yield* Deferred.await(done);})
        .pipe(Effect.provide(OperationInbox.layer('workspace','child').pipe(Layer.provide(Layer.merge(inboxRepositoryLayer(store.inbox),execution)))));
    })));
    store.close(); process.stdout.write(JSON.stringify(received));
  `
  );
  expect(JSON.parse(stdout)).toEqual([
    [...Array.from({ length: 8 }, (_, i) => `result-${i}`), 'late-nine'],
  ]);
  const reopened = new LodyOperationStore(f.filename);
  stores.push(reopened);
  reopened.inbox.activate('workspace', 'parent');
  expect(reopened.inbox.pending('workspace')).toEqual([]);
  const fresh = { ...f.input, inputId: 'fresh' };
  reopened.inbox.accept(fresh);
  expect(reopened.inbox.prepare(fresh, 'parent')).toBeUndefined();
});

it('keeps the first conflicting receipt and admits the next input', () => {
  const f = fixture();
  f.start();
  f.release();
  expect(() => f.release('failed')).not.toThrow();
  expect(() =>
    f.sql.release({
      ...f.input,
      userId: 'other',
      executionId: 'execution-1',
      outcome: 'user_stop',
    })
  ).not.toThrow();
  const fresh = { ...f.input, inputId: 'fresh' };
  f.sql.accept(fresh);
  expect(f.sql.begin(fresh, 'successor')).toBe(true);
  const db = new Database(f.filename);
  expect(db.prepare('SELECT outcome,user_id FROM inbox_releases').get()).toEqual({
    outcome: 'normal',
    user_id: 'human',
  });
  db.close();
});

it.each(['check', 'fence'] as const)(
  'holds shared admission through %s and actual transport initiation',
  async (position) => {
    const f = fixture();
    f.start();
    f.add('one');
    const received: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const scheduler = new Scheduler.MixedScheduler('sync');
          const dispatcher = scheduler.makeDispatcher();
          const base = yield* Effect.provide(InboxRepository, inboxRepositoryLayer(f.sql));
          const barrier = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(proceed);
          });
          const repo: typeof base = {
            ...base,
            canSubmit: (s, id, owner) =>
              base
                .canSubmit(s, id, owner)
                .pipe(Effect.tap(() => (position === 'check' ? barrier : Effect.void))),
            fence: (batch, id) =>
              base
                .fence(batch, id)
                .pipe(Effect.tap(() => (position === 'fence' ? barrier : Effect.void))),
          };
          const deps = Layer.merge(
            Layer.succeed(InboxRepository, repo),
            Layer.succeed(InboxExecution, {
              ready: () => false,
              admit: () => true,
              launch: () => Effect.void,
              report: () => Effect.void,
            })
          );
          yield* Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            const batch = yield* inbox.prepare(f.input);
            const submitting = yield* inbox
              .submit(batch, f.input, 'execution-1', () => received.push('transport-started'))
              .pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const stopping = yield* Effect.gen(function* () {
              expect(yield* inbox.pause(f.input, 'execution-1')).toBe(true);
              received.push('stop-confirmed');
            }).pipe(
              Effect.provideService(Scheduler.Scheduler, {
                executionMode: 'sync',
                shouldYield: () => false,
                makeDispatcher: () => dispatcher,
              }),
              Effect.forkScoped({ startImmediately: true })
            );
            dispatcher.flush();
            try {
              expect(stopping.pollUnsafe()).toBeUndefined();
              expect(f.sql.inputCanceled('workspace', 'A', f.input.inputId)).toBe(false);
            } finally {
              yield* Deferred.succeed(proceed, undefined);
            }
            yield* Fiber.join(submitting);
            yield* Fiber.join(stopping);
            expect(received).toEqual(['transport-started', 'stop-confirmed']);
            yield* inbox.settle(batch!, 'unknown');
            yield* inbox.release({ ...f.input, executionId: 'execution-1', outcome: 'user_stop' });
            expect(f.sql.pending('workspace')).toEqual([]);
            const replay = yield* Effect.exit(
              inbox.submit(batch, f.input, 'execution-1', () => received.push('replay'))
            );
            expect(replay._tag).toBe('Failure');
            expect(received).toEqual(['transport-started', 'stop-confirmed']);
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          );
        })
      )
    );
  }
);

it.each(['unknown', 'paused'] as const)(
  'an OS child keeps %s work passive without a new event',
  async (mode) => {
    const f = fixture();
    f.start();
    f.add('saved');
    let batchId: string | undefined;
    if (mode === 'unknown') {
      const batch = f.sql.prepare(f.input, 'owner')!;
      batchId = batch.batchId;
      f.sql.fence(batch, 'execution-1'); // Crash with no reliable transport receipt.
    } else {
      f.sql.pause(f.input, 'execution-1');
      f.release('user_stop');
    }
    f.store.close();
    const stdout = await runInboxChild(
      f.root,
      `
    import {LodyOperationStore} from ${JSON.stringify(fileURLToPath(new URL('../operation-store.ts', import.meta.url)))};
    import {OperationInbox,InboxRepository,InboxExecution} from ${JSON.stringify(fileURLToPath(new URL('./service.ts', import.meta.url)))};
    import {inboxRepositoryLayer} from ${JSON.stringify(fileURLToPath(new URL('../platform/inbox-repository.ts', import.meta.url)))};
    import {Effect,Layer,Deferred} from ${JSON.stringify(fileURLToPath(new URL('../../../node_modules/effect/dist/index.js', import.meta.url)))};
    const store=new LodyOperationStore(${JSON.stringify(f.filename)});store.inbox.activate('workspace','child');
    const received=[];
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const scanned=yield* Deferred.make();
      const base=yield* Effect.provide(InboxRepository,inboxRepositoryLayer(store.inbox));
      const repository=Layer.succeed(InboxRepository,{...base,pending:w=>base.pending(w).pipe(Effect.tap(()=>Deferred.succeed(scanned,undefined)))});
      const execution=Layer.succeed(InboxExecution,{ready:()=>true,admit:()=>true,report:()=>Effect.void,launch:batch=>Effect.sync(()=>received.push(batch.batchId))});
      yield* Effect.gen(function*(){yield* OperationInbox;yield* Deferred.await(scanned);})
        .pipe(Effect.provide(OperationInbox.layer('workspace','child').pipe(Layer.provide(Layer.merge(repository,execution)))));
    })));
    const input=${JSON.stringify(f.input)};
    const batch=${JSON.stringify(batchId)}?store.inbox.getBatch(${JSON.stringify(batchId)},input):undefined;
    const taskAccepted=store.inbox.accept({...input,inputId:'agent-task',kind:'task'});
    process.stdout.write(JSON.stringify({received,state:batch?.state,taskAccepted,pending:store.inbox.pending('workspace')}));store.close();
  `
    );
    const observed = JSON.parse(stdout);
    expect(observed.received).toEqual([]);
    expect(observed.pending).toEqual([]);
    if (mode === 'unknown') expect(observed.state).toBe('unknown');
    else expect(observed.taskAccepted).toBe(true);
  }
);

it('includes the header and omission footer in the complete 64 KiB preview budget', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const batch = f.sql.prepare(f.input, 'owner')!;
  const member = { ...f.sql.members(batch)[0]!, completion: { text: '' } };
  const nearLimit =
    INBOX_PREVIEW_BYTES -
    Buffer.byteLength(batchPreview(batch, []), 'utf8') -
    Buffer.byteLength(JSON.stringify(member), 'utf8') +
    8;
  member.completion.text = 'x'.repeat(nearLimit);
  const preview = batchPreview(batch, [member]);
  expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(INBOX_PREVIEW_BYTES);
  expect(preview).toContain('Shown 0/1.');
  expect(f.sql.members(batch)).toHaveLength(1);
});

describe('manual Stop receipts', () => {
  const stopped: LodyOperationItemResult = {
    status: 'cancelled',
    cancellationReason: 'user_stop',
    target: { sessionId: 'B' as SessionId, userTurnId: 'b-input' },
  };
  it('persists exact Stop provenance, keeps cancellation queryable and never dispatches it after restart or a fresh message', () => {
    const f = fixture(() => Date.parse('2026-10-12T00:00:00Z'));
    const target = { ...f.input, sessionId: 'B', inputId: 'b-input' };
    f.sql.accept(target);
    f.sql.begin(target, 'b-execution');
    expect(f.sql.pause(target, 'b-execution', [], 'user-stop')).toBe(true);
    expect(f.sql.inputCancellationReason('workspace', 'B', 'b-input')).toBe('user_stop');
    // A coordinator may have computed success before Stop; finalization must recheck under the writer lock.
    f.add('silent', 0, [
      {
        status: 'succeeded',
        target: { sessionId: 'B' as SessionId, userTurnId: 'b-input' },
        assistantTurnId: 'partial-output',
        output: { text: 'partial' },
      },
    ]);
    expect(f.store.get(f.input.sessionId as SessionId, 'silent').items).toEqual([stopped]);
    expect(f.store.get(f.input.sessionId as SessionId, 'silent')).toMatchObject({
      state: 'finished',
      completion: { value: { items: [stopped] } },
    });
    expect(f.sql.pending('workspace')).toEqual([]);
    f.store.close();
    const reopened = new LodyOperationStore(f.filename, () => Date.parse('2026-10-12T00:00:00Z'));
    stores.push(reopened);
    reopened.inbox.activate('workspace', 'replacement');
    expect(reopened.inbox.inputCancellationReason('workspace', 'B', 'b-input')).toBe('user_stop');
    reopened.finish(f.input.sessionId as SessionId, 'silent', {
      type: 'result',
      value: { items: [stopped] },
    });
    reopened.finish(f.input.sessionId as SessionId, 'silent', {
      type: 'error',
      error: { code: 'TARGET_TIMEOUT', message: 'Late deadline', retryable: false },
    });
    expect(reopened.get(f.input.sessionId as SessionId, 'silent').completion).toEqual({
      type: 'result',
      value: { items: [stopped] },
    });
    expect(reopened.inbox.pending('workspace')).toEqual([]);
    const fresh = { ...f.input, inputId: 'next-human' };
    reopened.inbox.accept(fresh);
    expect(reopened.inbox.prepare(fresh, 'replacement')).toBeUndefined();
  });
  it('rolls back silent terminalization if its tombstone cannot be saved, then settles exactly once', () => {
    const f = fixture(() => Date.parse('2026-10-12T00:00:00Z'));
    const completion = { type: 'result' as const, value: { items: [stopped] } };
    const accepted = f.store.accept({
      workspaceId: 'workspace' as WorkspaceId,
      ownerMachineId: 'machine' as MachineId,
      requesterSessionId: 'A' as SessionId,
      requesterUserId: 'human',
      operationId: 'silent-failure',
      kind: 'session_chat',
      canonicalCommand: {},
      frozenContinuationConfig: { inputConfig: {} },
      initiatorChainDepth: 0,
      createdAt: '2026-10-12T00:00:00Z',
      deadlineAt: '2026-10-13T00:00:00Z',
      items: [stopped],
    });
    const db = new Database(f.filename);
    try {
      db.exec(
        "CREATE TRIGGER reject_silent BEFORE INSERT ON inbox_results BEGIN SELECT RAISE(ABORT,'disk failure'); END"
      );
      expect(() =>
        f.store.finish(accepted.operation.requesterSessionId, 'silent-failure', completion)
      ).toThrow('disk failure');
      expect(f.store.get(accepted.operation.requesterSessionId, 'silent-failure').state).toBe(
        'active'
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM inbox_results').get()).toEqual({ count: 0 });
      db.exec('DROP TRIGGER reject_silent');
      f.store.finish(accepted.operation.requesterSessionId, 'silent-failure', completion);
      f.store.finish(accepted.operation.requesterSessionId, 'silent-failure', completion);
      expect(db.prepare('SELECT consumed,COUNT(*) AS count FROM inbox_results').get()).toEqual({
        consumed: 1,
        count: 1,
      });
      expect(f.sql.pending('workspace')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('filters only manually stopped targets while preserving the complete Operation result', () => {
    const f = fixture(() => Date.parse('2026-10-12T00:00:00Z'));
    const completed: LodyOperationItemResult = {
      status: 'succeeded',
      target: { sessionId: 'C' as SessionId, userTurnId: 'c-input' },
      assistantTurnId: 'c-output',
      output: { text: 'done' },
    };
    f.add('mixed', 0, [stopped, completed]);
    const intent = f.sql.pending('workspace')[0];
    if (!intent) throw Error('missing wake');
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId);
    if (!batch) throw Error('missing batch');
    expect(f.sql.members(batch)[0]?.completion).toEqual({
      type: 'result',
      value: { items: [completed] },
    });
    expect(f.store.get(f.input.sessionId as SessionId, 'mixed').completion).toEqual({
      type: 'result',
      value: { items: [stopped, completed] },
    });
  });
  it('still returns non-user cancellation and persists no user-stop cause for it', () => {
    const f = fixture(() => Date.parse('2026-10-12T00:00:00Z'));
    const target = { ...f.input, sessionId: 'B', inputId: 'b-input' };
    f.sql.accept(target);
    f.sql.begin(target, 'b-execution');
    f.sql.cancelExecution(target, 'b-execution');
    expect(f.sql.inputCancellationReason('workspace', 'B', 'b-input')).toBeUndefined();
    f.add('agent-cancel', 0, [{ status: 'cancelled', target: stopped.target }]);
    expect(f.sql.pending('workspace')).toHaveLength(1);
  });
});
