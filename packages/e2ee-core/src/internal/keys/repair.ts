import { Context, Effect, Layer, Result, Schema } from 'effect';
import { keyId } from '../foundation/identifiers';
import type { LedgerView } from '../ledger';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { makeCloseGuard, own, ownIdentity } from '../lifecycle';
import { KeyMailbox } from '../../services/keys';
import { RepairJournal, type RepairTaskRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import type { BackendError, LocalStoreError } from '../../services/errors';
import { isHash } from './reports';

/**
 * A repair request could not be recorded or sent.
 *
 * `replay` means the request id is already used with a different epoch or
 * rejected digest; `unauthorized` means this device is not eligible at the
 * current ledger view. Other reasons are as named.
 *
 * @category Errors
 */
export class RepairError extends Schema.TaggedError<RepairError>()('RepairError', {
  reason: Schema.Literals([
    'invalid-input',
    'closed',
    'storage',
    'corrupt',
    'rollback',
    'unauthorized',
    'replay',
  ]),
}) {}
const fail = (reason: RepairError['reason']) => new RepairError({ reason });
const fromStore = (error: LocalStoreError) =>
  fail(error.reason === 'closed' ? 'closed' : error.reason === 'storage' ? 'storage' : 'corrupt');
const fromLedger = (error: VerifiedLedgerError) =>
  fail(
    error.reason === 'rollback' ? 'rollback' : error.reason === 'corrupt' ? 'corrupt' : 'storage'
  );
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length >= 1 && id.length <= 256;
const validLimit = (limit: number) => Number.isInteger(limit) && limit >= 1 && limit <= 100;

/** Outcome of one finite repair round. */
export interface RepairBatch {
  readonly processed: number;
  readonly blocked: readonly string[];
  readonly next: string | null;
}

/**
 * Ask the mailbox for a fresh envelope when this device cannot install the
 * current epoch key (nothing arrived, or an envelope was rejected).
 *
 * `enqueue(id)` durably records the request under the caller's stable id before
 * anything is sent; `flush` sends pending requests and finishes them as
 * `Repaired`, or `Obsolete`/`Revoked` when the ledger moved on. A repair is a
 * scheduling hint for senders, never evidence that a key was installed.
 *
 * @category Workflows
 */
export class KeyRepair extends Context.Service<
  KeyRepair,
  {
    /** Persist a caller-chosen stable request id for the current epoch; identical retries reuse it without sending yet. */
    enqueue(
      requestId: string,
      rejectedDigest?: string
    ): Effect.Effect<{ readonly id: string }, RepairError>;
    /** Send one id-ordered page (1–100, default 100); failed requests stay pending and appear in `blocked`. */
    flush(limit?: number, cursor?: string | null): Effect.Effect<RepairBatch, RepairError>;
    /** List one page of unacknowledged terminal requests; `next` is a hint, not proof of key installation. */
    results(
      limit?: number,
      cursor?: string | null
    ): Effect.Effect<
      {
        readonly items: readonly {
          readonly id: string;
          readonly outcome: 'Repaired' | 'Obsolete' | 'Revoked';
        }[];
        readonly next: string | null;
      },
      RepairError
    >;
    /** Consume a terminal result; pending requests remain retryable and storage or closed-owner failures propagate. */
    acknowledge(id: string): Effect.Effect<void, RepairError>;
  }
>()('@lody/e2ee-core/KeyRepair') {
  /**
   * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
   * {@link KeyMailbox} and {@link RepairJournal}.
   */
  static readonly layer = Layer.effect(
    KeyRepair,
    Effect.gen(function* () {
      const org = keyId((yield* WorkspaceScope).genesis.toBytes());
      const self = keyId(ownIdentity(yield* DeviceIdentity).signer.publicKey.toBytes());
      const ledger = yield* VerifiedLedger;
      const mailbox = own(yield* KeyMailbox);
      const journal = own(yield* RepairJournal);
      const gate = yield* makeCloseGuard(() => fail('closed'));
      const current = Effect.fnUntraced(function* () {
        yield* gate.guard;
        const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
        yield* gate.guard;
        return view;
      });
      const parse = (row: RepairTaskRow) =>
        validId(row.id) &&
        Number.isInteger(row.epoch) &&
        row.epoch >= 0 &&
        row.epoch <= 0xffffffff &&
        (row.rejected === null || isHash(row.rejected))
          ? Effect.succeed(row)
          : Effect.fail(fail('corrupt'));
      const load = Effect.fnUntraced(function* (id: string) {
        yield* gate.guard;
        const row = yield* journal.load(id).pipe(Effect.mapError(fromStore));
        if (!row) return yield* fail('corrupt');
        return yield* parse(row);
      });
      const disposition = (
        view: LedgerView,
        task: RepairTaskRow
      ): 'Obsolete' | 'Revoked' | null => {
        const state = view.inspectState();
        if (state.epoch.number !== task.epoch) return 'Obsolete';
        return state.devices.get(self) ? null : 'Revoked';
      };
      const finish = Effect.fnUntraced(function* (
        task: RepairTaskRow,
        phase: 'Repaired' | 'Obsolete' | 'Revoked'
      ) {
        const stored = yield* load(task.id);
        if (stored.epoch !== task.epoch || stored.rejected !== task.rejected)
          return yield* fail('corrupt');
        if (stored.phase === phase) return undefined;
        if (stored.phase !== 'Pending') return yield* fail('corrupt');
        yield* journal.finish(task.id, phase).pipe(Effect.mapError(fromStore));
        const completed = yield* load(task.id);
        if (
          completed.phase !== phase ||
          completed.epoch !== task.epoch ||
          completed.rejected !== task.rejected
        )
          return yield* fail('corrupt');
        return undefined;
      });
      const flush = Effect.fnUntraced(function* (limit: number, cursor: string | null) {
        yield* gate.guard;
        if (!validLimit(limit) || (cursor !== null && !validId(cursor)))
          return yield* fail('invalid-input');
        const page = yield* journal.pending(cursor, limit).pipe(Effect.mapError(fromStore));
        const blocked: string[] = [];
        for (const row of page.tasks) {
          const result = yield* Effect.result(
            Effect.gen(function* () {
              const task = yield* parse(row);
              const reason = disposition(yield* current(), task);
              if (reason) return yield* finish(task, reason);
              yield* gate.guard;
              yield* mailbox.repair(
                { genesis: org, epoch: task.epoch, recipient: self },
                task.id,
                task.rejected ?? undefined
              );
              yield* gate.guard;
              yield* finish(task, disposition(yield* current(), task) ?? 'Repaired');
              return undefined;
            })
          );
          if (Result.isFailure(result)) blocked.push(row.id);
        }
        return { processed: page.tasks.length, blocked, next: page.next } satisfies RepairBatch;
      });
      const enqueue = Effect.fnUntraced(function* (id: string, rejectedDigest?: string) {
        const rejected = rejectedDigest ?? null;
        if (!validId(id) || (rejected !== null && !isHash(rejected)))
          return yield* fail('invalid-input');
        const view = yield* current(),
          epoch = view.inspectState().epoch.number;
        if (disposition(view, { id, epoch, rejected, phase: 'Pending' }))
          return yield* fail('unauthorized');
        yield* gate.guard;
        yield* journal.insertIfAbsent({ id, epoch, rejected }).pipe(Effect.mapError(fromStore));
        const original = yield* load(id);
        if (original.epoch !== epoch || original.rejected !== rejected)
          return yield* fail('replay');
        return { id };
      });
      return KeyRepair.of({
        enqueue: Effect.fn('@lody/e2ee-core/KeyRepair.enqueue')(
          function* (requestId, rejectedDigest) {
            return yield* gate.run(enqueue(requestId, rejectedDigest));
          }
        ),
        flush: Effect.fn('@lody/e2ee-core/KeyRepair.flush')(function* (limit = 100, cursor = null) {
          return yield* gate.run(flush(limit, cursor));
        }),
        results: Effect.fn('@lody/e2ee-core/KeyRepair.results')(function* (
          limit = 100,
          cursor = null
        ) {
          yield* gate.guard;
          if (!validLimit(limit) || (cursor !== null && !validId(cursor)))
            return yield* fail('invalid-input');
          const page = yield* journal.results(cursor, limit).pipe(Effect.mapError(fromStore));
          const items: { id: string; outcome: 'Repaired' | 'Obsolete' | 'Revoked' }[] = [];
          for (const row of page.tasks) {
            const task = yield* parse(row);
            items.push({ id: task.id, outcome: task.phase as 'Repaired' | 'Obsolete' | 'Revoked' });
          }
          return { items, next: page.next };
        }),
        acknowledge: Effect.fn('@lody/e2ee-core/KeyRepair.acknowledge')(function* (id: string) {
          yield* gate.guard;
          if (!validId(id)) return yield* fail('invalid-input');
          yield* journal.acknowledge(id).pipe(Effect.mapError(fromStore));
          return undefined;
        }),
      });
    })
  );
}

export type { BackendError };
