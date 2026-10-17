import { Context, Effect, Layer, Result, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../foundation/bytes';
import { disposeEpochKey } from '../foundation/epoch-key';
import { keyId } from '../foundation/identifiers';
import { decodeRecord, type LedgerView } from '../ledger';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { makeCloseGuard, own, ownIdentity } from '../lifecycle';
import { KeyMailbox } from '../../services/keys';
import { EpochPublicationSource } from '../../services/ledger';
import {
  DeliveryOutbox,
  DistributionJournal,
  type DistributionTaskPhase,
  type DistributionTaskRow,
} from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import type { LocalStoreError } from '../../services/errors';
import { deliverEpochEnvelope, epochDeliveryId, type DeliveryError } from './delivery';
import { InstalledEpochKeys } from './installed-keys';
import { KeyReceiver, type ReceiveFailure } from './receiver';
import { fromHex, isHash } from './reports';

/**
 * A distribution step failed. `context-changed` means the ledger, the mailbox
 * revision or the stored task moved while the step ran; `task-limit` means the
 * {@link DistributionJournal} is full of unacknowledged tasks.
 *
 * @category Errors
 */
export class DistributionError extends Schema.TaggedError<DistributionError>()(
  'DistributionError',
  {
    reason: Schema.Literals([
      'storage',
      'corrupt',
      'closed',
      'rollback',
      'invalid-input',
      'context-changed',
      'task-limit',
    ]),
  }
) {}
const fail = (reason: DistributionError['reason']) => new DistributionError({ reason });
const fromStore = (error: LocalStoreError) =>
  fail(
    error.reason === 'closed'
      ? 'closed'
      : error.reason === 'storage'
        ? 'storage'
        : error.reason === 'capacity'
          ? 'task-limit'
          : error.reason === 'conflict'
            ? 'context-changed'
            : 'corrupt'
  );
const fromLedger = (error: VerifiedLedgerError) =>
  fail(
    error.reason === 'rollback' ? 'rollback' : error.reason === 'corrupt' ? 'corrupt' : 'storage'
  );
/** Storage damage stops a whole batch; anything else only blocks the one task. */
const fatal = (error: unknown) =>
  error instanceof DistributionError && (error.reason === 'storage' || error.reason === 'corrupt');

const taskId = (delivery: string, revision: number) =>
  keyId(
    sha256(new TextEncoder().encode(`lody-e2ee/local-distribution-task/v0:${delivery}:${revision}`))
  );
const boundedPage = (limit: number, cursor: string | null) =>
  Number.isInteger(limit) &&
  limit >= 1 &&
  limit <= 100 &&
  (cursor === null || (typeof cursor === 'string' && /^[0-9a-f]{64}$/.test(cursor)));
const senderEligible = (view: LedgerView, self: string) => {
  const state = view.inspectState(),
    device = state.devices.get(self);
  return (
    !!device &&
    device.kind !== 'recovery' &&
    state.members.has(keyId(device.membershipId.toBytes()))
  );
};
const sameTask = (a: DistributionTaskRow, b: DistributionTaskRow) =>
  a.id === b.id &&
  a.epoch === b.epoch &&
  a.recipient === b.recipient &&
  a.revision === b.revision &&
  a.phase === b.phase &&
  a.consumed === b.consumed;

/**
 * Every failure a {@link KeyDistributor} step can report: its own
 * {@link DistributionError}, a delivery or receive failure (see
 * `ReceiveFailure`), or an {@link EpochPublicationSource} failure.
 */
export type DistributionFailure =
  | DistributionError
  | DeliveryError
  | LocalStoreError
  | ReceiveFailure;

/** Outcome of one finite delivery round. */
export interface DistributionBatch {
  readonly processed: number;
  /** Task ids still pending after this round; retried by the next one. */
  readonly blocked: readonly string[];
  readonly next: string | null;
}

/** One finished delivery awaiting acknowledgement. */
export interface DistributionResult {
  readonly id: string;
  readonly epoch: number;
  readonly recipient: string;
  readonly revision: number;
  readonly outcome: Exclude<DistributionTaskPhase, 'Pending'>;
}

/**
 * Sender side of epoch-key delivery: make sure every current device can obtain
 * the current epoch key from {@link KeyMailbox}.
 *
 * `reconcileCurrentEpoch` schedules one task per eligible recipient (targets
 * come from the verified ledger, never from the server) and mailbox revision;
 * `resumePendingDeliveries` encrypts or re-sends the saved original envelope and
 * finishes a task once the mailbox reports the envelope stored. Mailbox
 * revisions only trigger retries; they never authorize or end a task — only the
 * ledger does (`Obsolete`/`Revoked`).
 *
 * @category Workflows
 */
export class KeyDistributor extends Context.Service<
  KeyDistributor,
  {
    /** Discover one page of current eligible devices (1–100, default 100) and durably schedule missing deliveries. */
    reconcileCurrentEpoch(
      limit?: number,
      cursor?: string | null
    ): Effect.Effect<
      {
        readonly scheduled: number;
        readonly blocked: readonly string[];
        readonly next: string | null;
      },
      DistributionFailure
    >;
    /** Retry one page of saved originals; blocked tasks retain their bytes and `next` allows later tasks to progress. */
    resumePendingDeliveries(
      limit?: number,
      cursor?: string | null
    ): Effect.Effect<DistributionBatch, DistributionFailure>;
    /** List unacknowledged terminal tasks in id order; `Observed` records a mailbox observation, not receiver custody. */
    results(
      limit?: number,
      cursor?: string | null
    ): Effect.Effect<
      { readonly items: readonly DistributionResult[]; readonly next: string | null },
      DistributionError
    >;
    /** Consume a terminal task and free task capacity; never deletes its original outbox ciphertext. Pending tasks fail. */
    acknowledge(id: string): Effect.Effect<void, DistributionError>;
  }
>()('@lody/e2ee-core/KeyDistributor') {
  /**
   * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
   * `InstalledEpochKeys`, `KeyReceiver`, {@link KeyMailbox},
   * {@link DeliveryOutbox}, {@link DistributionJournal} and
   * {@link EpochPublicationSource}.
   */
  static readonly layer = Layer.effect(
    KeyDistributor,
    Effect.gen(function* () {
      const anchor = (yield* WorkspaceScope).genesis;
      const signer = ownIdentity(yield* DeviceIdentity).signer;
      const ledger = yield* VerifiedLedger;
      const keys = yield* InstalledEpochKeys;
      const receiver = yield* KeyReceiver;
      const mailbox = own(yield* KeyMailbox);
      const outbox = own(yield* DeliveryOutbox);
      const journal = own(yield* DistributionJournal);
      const publications = own(yield* EpochPublicationSource);
      const gate = yield* makeCloseGuard(() => fail('closed'));
      const org = keyId(anchor.toBytes()),
        self = keyId(signer.publicKey.toBytes());
      const store = <A>(effect: Effect.Effect<A, LocalStoreError>) =>
        gate.guard.pipe(Effect.flatMap(() => effect.pipe(Effect.mapError(fromStore))));

      const parse = (row: DistributionTaskRow) =>
        Effect.try({
          try: () => {
            if (
              !/^[0-9a-f]{64}$/.test(row.id) ||
              !isHash(row.recipient) ||
              !Number.isSafeInteger(row.epoch) ||
              row.epoch < 0 ||
              row.epoch > 0xffffffff ||
              !Number.isSafeInteger(row.revision) ||
              row.revision < 0 ||
              (row.phase === 'Pending' && row.consumed)
            )
              throw fail('corrupt');
            const delivery = Result.getOrThrow(
              epochDeliveryId({
                genesis: anchor,
                sender: signer.publicKey,
                epoch: Result.getOrThrow(Bytes.epochNumber(row.epoch)),
                recipient: Result.getOrThrow(Bytes.signingPublicKey(fromHex(row.recipient))),
              })
            );
            if (row.id !== taskId(delivery, row.revision)) throw fail('corrupt');
            return { ...row };
          },
          catch: () => fail('corrupt'),
        });
      const load = Effect.fnUntraced(function* (id: string) {
        const row = yield* store(journal.load(id));
        if (!row) return yield* fail('corrupt');
        return yield* parse(row);
      });
      const current = Effect.fnUntraced(function* () {
        yield* gate.guard;
        const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
        yield* gate.guard;
        return view;
      });
      const hint = Effect.fnUntraced(function* (epoch: number, target: string) {
        const value = yield* mailbox.status({ genesis: org, epoch, recipient: target });
        if (
          value.genesis !== org ||
          value.epoch !== epoch ||
          value.recipient !== target ||
          !Number.isSafeInteger(value.revision) ||
          value.revision < 0
        )
          return yield* fail('context-changed');
        yield* gate.guard;
        return { revision: value.revision, status: value.status };
      });
      const terminal = Effect.fnUntraced(function* (
        task: DistributionTaskRow,
        phase: Exclude<DistributionTaskPhase, 'Pending'>
      ) {
        if (!sameTask(yield* load(task.id), task)) return yield* fail('context-changed');
        yield* store(journal.finish(task.id, phase));
        if (!sameTask(yield* load(task.id), { ...task, phase, consumed: false }))
          return yield* fail('corrupt');
        return undefined;
      });
      const disposition = (view: LedgerView, task: DistributionTaskRow) =>
        view.inspectState().epoch.number !== task.epoch
          ? ('Obsolete' as const)
          : !senderEligible(view, self) || !view.inspectState().devices.has(task.recipient)
            ? ('Revoked' as const)
            : null;

      const schedule = Effect.fnUntraced(function* (epoch: number, target: string) {
        const remote = yield* hint(epoch, target),
          latest = yield* current();
        if (
          latest.inspectState().epoch.number !== epoch ||
          !senderEligible(latest, self) ||
          !latest.inspectState().devices.has(target)
        )
          return yield* fail('context-changed');
        const delivery = yield* Effect.fromResult(
          epochDeliveryId({
            genesis: anchor,
            epoch: yield* Effect.fromResult(Bytes.epochNumber(epoch)),
            sender: signer.publicKey,
            recipient: yield* Effect.fromResult(Bytes.signingPublicKey(fromHex(target))),
          })
        );
        const task: DistributionTaskRow = {
          id: taskId(delivery, remote.revision),
          epoch,
          recipient: target,
          revision: remote.revision,
          phase: 'Pending',
          consumed: false,
        };
        const inserted = yield* store(journal.insertIfAbsent(task));
        const stored = yield* load(task.id);
        if (
          stored.epoch !== epoch ||
          stored.recipient !== target ||
          stored.revision !== remote.revision
        )
          return yield* fail('corrupt');
        if (inserted && !sameTask(stored, task)) return yield* fail('corrupt');
        return inserted;
      });
      const reconcile = Effect.fnUntraced(function* (limit: number, cursor: string | null) {
        if (!boundedPage(limit, cursor)) return yield* fail('invalid-input');
        const view = yield* current(),
          epoch = view.inspectState().epoch.number;
        if (!senderEligible(view, self))
          return { scheduled: 0, next: null, blocked: [] as string[] };
        const record = yield* publications.current(view);
        yield* gate.guard;
        if (record !== null) {
          if (!(record instanceof Uint8Array) || record.length > 8192)
            return yield* fail('invalid-input');
          const original = new Uint8Array(record),
            decoded = yield* Effect.fromResult(decodeRecord(original));
          if (decoded.body.signer.equals(signer.publicKey))
            yield* receiver.recordLocalInstallation(original);
        }
        const state = view.inspectState(),
          targets = [...state.devices.entries()]
            .filter(
              ([id, device]) =>
                id !== self &&
                state.members.has(keyId(device.membershipId.toBytes())) &&
                id > (cursor ?? '')
            )
            .map(([id]) => id)
            .sort();
        const selected = targets.slice(0, limit),
          blocked: string[] = [];
        let scheduled = 0;
        for (const target of selected) {
          const attempted = yield* Effect.result(schedule(epoch, target));
          if (Result.isFailure(attempted)) {
            if (fatal(attempted.failure)) return yield* attempted.failure;
            blocked.push(target);
          } else if (attempted.success) scheduled++;
        }
        yield* gate.guard;
        return { scheduled, blocked, next: targets.length > limit ? selected.at(-1)! : null };
      });

      const deliver = Effect.fnUntraced(function* (id: string) {
        const task = yield* load(id),
          reason = disposition(yield* current(), task);
        if (reason) {
          yield* terminal(task, reason);
          return true;
        }
        return yield* Effect.acquireUseRelease(
          keys.read(task.epoch),
          Effect.fnUntraced(function* (key) {
            const context = {
              genesis: anchor,
              epoch: Result.getOrThrow(Bytes.epochNumber(task.epoch)),
              sender: signer.publicKey,
              recipient: yield* Effect.fromResult(Bytes.signingPublicKey(fromHex(task.recipient))),
            };
            const result = yield* deliverEpochEnvelope({
              context,
              ledger: current,
              prepare: { key, signer },
            }).pipe(
              Effect.provideService(DeliveryOutbox, outbox),
              Effect.provideService(KeyMailbox, mailbox)
            );
            const after = disposition(yield* current(), task);
            if (after) {
              yield* terminal(task, after);
              return true;
            }
            if (result.outcome !== 'Stored') return false;
            const status = yield* hint(task.epoch, task.recipient);
            // A repaired/rejected original cannot silently produce fresh ciphertext/ID.
            // Remote hints leave work pending; they never create a ledger terminal reason.
            if (status.revision !== task.revision || status.status === 'NeedsEnvelope')
              return false;
            yield* terminal(task, disposition(yield* current(), task) ?? 'Observed');
            return true;
          }),
          (key) => Effect.sync(() => disposeEpochKey(key))
        );
      });
      const resume = Effect.fnUntraced(function* (limit: number, cursor: string | null) {
        if (!boundedPage(limit, cursor)) return yield* fail('invalid-input');
        const page = yield* store(journal.pending(cursor, limit));
        const blocked: string[] = [];
        for (const id of page.ids) {
          const attempt = yield* Effect.result(deliver(id));
          if (Result.isFailure(attempt)) {
            if (fatal(attempt.failure)) return yield* attempt.failure;
            blocked.push(id);
          } else if (!attempt.success) blocked.push(id);
        }
        yield* gate.guard;
        return { processed: page.ids.length, blocked, next: page.next } satisfies DistributionBatch;
      });

      return KeyDistributor.of({
        reconcileCurrentEpoch: Effect.fn('@lody/e2ee-core/KeyDistributor.reconcileCurrentEpoch')(
          function* (limit = 100, cursor = null) {
            return yield* gate.run(reconcile(limit, cursor));
          }
        ),
        resumePendingDeliveries: Effect.fn(
          '@lody/e2ee-core/KeyDistributor.resumePendingDeliveries'
        )(function* (limit = 100, cursor = null) {
          return yield* gate.run(resume(limit, cursor));
        }),
        results: Effect.fn('@lody/e2ee-core/KeyDistributor.results')(function* (
          limit = 100,
          cursor = null
        ) {
          if (!boundedPage(limit, cursor)) return yield* fail('invalid-input');
          const page = yield* store(journal.results(cursor, limit));
          const items: DistributionResult[] = [];
          for (const row of page.tasks) {
            const task = yield* parse(row);
            if (task.phase === 'Pending' || task.consumed) return yield* fail('corrupt');
            items.push({
              id: task.id,
              epoch: task.epoch,
              recipient: task.recipient,
              revision: task.revision,
              outcome: task.phase,
            });
          }
          return { items, next: page.next };
        }),
        acknowledge: Effect.fn('@lody/e2ee-core/KeyDistributor.acknowledge')(function* (
          id: string
        ) {
          if (!/^[0-9a-f]{64}$/.test(id)) return yield* fail('invalid-input');
          const task = yield* load(id);
          if (task.phase === 'Pending') return yield* fail('invalid-input');
          yield* store(journal.acknowledge(id));
          if (!sameTask(yield* load(id), { ...task, consumed: true }))
            return yield* fail('corrupt');
          return undefined;
        }),
      });
    })
  );
}
