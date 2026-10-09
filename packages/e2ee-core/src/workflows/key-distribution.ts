import { Effect } from 'effect';
import { DistributionStore, KeyMailboxRemote } from '../ports/key-mailbox';
import { EpochKeyring } from '../ports/epoch-rotation';
import type { DeviceSigner } from '../ports/ledger';
import { epochNumber, signingPublicKey } from '../pure/bytes';
import { ValidationError, type EpochRotationError, type ClientError } from '../pure/errors';
import { keyId } from '../pure/identifiers';
import { canSendEpoch, checkEpochKey } from '../pure/epoch-envelope';
import { epochDeliveryId } from '../pure/key-delivery';
import {
  envelopeRouting,
  boundedPage,
  checkInstallationContext,
  checkLocalPublication,
  fromHex,
  mailboxDigest,
  installationBody,
  installationSigningBytes,
  encodeInstallationReport,
  decodeInstallationReport,
  type InstallationContext,
  type MailboxSlot,
} from '../pure/key-mailbox';
import {
  acknowledgeResult,
  distributionTaskId,
  finishTask,
  receiveTaskId,
  type DistributionDocument,
  type DistributionResult,
  type ReceiveTask,
} from '../pure/key-distribution';
import { authorizeEpochDelivery, openVerifiedEnvelope } from './epoch-envelope';
import type { LedgerClient } from './ledger-client';
import type { LedgerView } from '../pure/records';
import { bytesEqual } from '../pure/cbor';
import { hashRecordBytes } from '../pure/wire-crypto';
import { decodeRecord } from '../pure/ledger-schema';

/** One local device/Org, persistent finite rounds. Application invokes on startup,
 * verified ledger changes and reconnect. No hidden runtime/loop/handler dependency. */
export class KeyDistributionClient {
  private constructor(
    private readonly client: LedgerClient,
    private readonly signer: DeviceSigner['Service'],
    private readonly store: DistributionStore['Service']
  ) {}
  static make(client: LedgerClient, signer: DeviceSigner['Service']) {
    return Effect.gen(function* () {
      const instance = new KeyDistributionClient(client, signer, yield* DistributionStore);
      const view = yield* client.refresh();
      yield* instance.update((doc) => {
        const binding = {
          genesis: keyId(view.genesis.toBytes()),
          recipient: keyId(signer.publicKey.toBytes()),
        };
        if (
          doc.binding &&
          (doc.binding.genesis !== binding.genesis || doc.binding.recipient !== binding.recipient)
        )
          return Effect.fail(new ValidationError({ code: 'genesis-mismatch' }));
        return Effect.succeed({ ...doc, binding });
      });
      return instance;
    });
  }
  private update<E, R>(
    work: (doc: DistributionDocument) => Effect.Effect<DistributionDocument, E, R>
  ) {
    return this.store.exclusive((tx) =>
      Effect.gen(function* () {
        const next = yield* work(yield* tx.load);
        yield* Effect.uninterruptible(tx.save(next));
        return next;
      })
    );
  }
  private read() {
    return this.store.exclusive((tx) => tx.load);
  }
  private finish(
    kind: 'tasks' | 'receives' | 'repairs',
    id: string,
    outcome: DistributionResult['outcome'],
    code: string | null = null
  ) {
    return this.update((doc) => Effect.succeed(finishTask(doc, kind, id, outcome, code))).pipe(
      Effect.asVoid
    );
  }
  private disposition(view: LedgerView, slot: MailboxSlot): 'Obsolete' | 'Revoked' | null {
    const s = view.inspectState();
    if (keyId(s.genesis) !== slot.genesis || s.epoch.number !== slot.epoch) return 'Obsolete';
    if (!s.devices.has(slot.recipient)) return 'Revoked';
    return null;
  }
  /** Reconstruct target coverage from our own verified ledger, even when server lists omit targets.
   * After publication/local installation, startup also closes the crash-before-scheduling gap. */
  reconcileCurrentEpoch() {
    return Effect.gen({ self: this }, function* () {
      const keyring = yield* EpochKeyring;
      const view = yield* this.client.refresh();
      const state = view.inspectState();
      const signerId = keyId(this.signer.publicKey.toBytes());
      yield* this.update((doc) =>
        Effect.succeed(
          doc.tasks.reduce((d, t) => {
            const reason =
              this.disposition(view, t) ??
              (!canSendEpoch(state, this.signer.publicKey.toBytes()) ? 'Revoked' : null);
            return t.phase === 'pending' && reason ? finishTask(d, 'tasks', t.id, reason) : d;
          }, doc)
        )
      );
      const key = yield* keyring.get(
        view.genesis,
        yield* Effect.fromResult(epochNumber(state.epoch.number))
      );
      if (key === null || !canSendEpoch(state, this.signer.publicKey.toBytes()))
        return { scheduled: 0 };
      yield* Effect.fromResult(checkEpochKey(state, key));
      const remote = yield* KeyMailboxRemote;
      // Publisher provenance is reconstructible after a crash, including verified genesis.
      const record = yield* this.client.currentEpochPublication();
      if (record) {
        const decoded = yield* Effect.fromResult(decodeRecord(record));
        if (keyId(decoded.body.fields.signer) === signerId)
          yield* this.recordLocalInstallation(record);
      }
      let scheduled = 0;
      for (const recipient of [...state.devices.keys()].sort()) {
        if (recipient === signerId) continue;
        const slot = { genesis: keyId(state.genesis), epoch: state.epoch.number, recipient };
        const status = yield* remote.status(slot);
        if (status.status !== 'NeedsEnvelope') continue;
        const id = distributionTaskId(slot, status.revision);
        yield* this.update((doc) => {
          if (doc.tasks.some((t) => t.id === id)) return Effect.succeed(doc);
          scheduled++;
          return Effect.succeed({
            ...doc,
            tasks: [...doc.tasks, { ...slot, id, revision: status.revision, phase: 'pending' }],
          });
        });
      }
      return { scheduled };
    });
  }
  /** At most limit tasks; network/crypto execute outside the document lease. */
  resumePendingDeliveries(limit = 100) {
    return Effect.gen({ self: this }, function* () {
      const remote = yield* KeyMailboxRemote;
      const page = yield* Effect.fromResult(
        boundedPage(
          (yield* this.read()).tasks.filter((t) => t.phase === 'pending'),
          null,
          limit
        )
      );
      for (const task of page.items) {
        const effect = Effect.gen({ self: this }, function* () {
          const view = yield* this.client.refresh();
          const reason =
            this.disposition(view, task) ??
            (!canSendEpoch(view.inspectState(), this.signer.publicKey.toBytes())
              ? 'Revoked'
              : null);
          if (reason) return yield* this.finish('tasks', task.id, reason);
          const status = yield* remote.status(task);
          if (status.revision !== task.revision)
            return yield* this.finish('tasks', task.id, 'Obsolete', 'repair-superseded');
          if (status.status === 'EnvelopeStored' || status.status === 'InstallationReported')
            return yield* this.finish('tasks', task.id, 'Observed');
          if (status.status !== 'NeedsEnvelope')
            return yield* this.finish('tasks', task.id, 'Obsolete');
          const recipient = yield* Effect.fromResult(signingPublicKey(fromHex(task.recipient)));
          const epoch = yield* Effect.fromResult(epochNumber(task.epoch));
          const id = yield* Effect.fromResult(
            epochDeliveryId(view.genesis, epoch, this.signer.publicKey, recipient)
          );
          // Existing exact bytes win. Missing outbox is the only reason to prepare.
          const result = yield* this.client
            .resumeEpochDelivery(id, recipient)
            .pipe(
              Effect.catchTag('ValidationError', (e) =>
                e.code === 'invalid-operation'
                  ? this.client.sendCurrentEpochKey(recipient)
                  : Effect.fail(e)
              )
            );
          if (result._tag === 'Observed') {
            const after = yield* remote.status(task);
            if (after.revision !== task.revision)
              yield* this.finish('tasks', task.id, 'Obsolete', 'repair-superseded');
            else if (after.status === 'NeedsEnvelope')
              yield* this.finish('tasks', task.id, 'Failed', 'repair-needs-another-sender');
            else yield* this.finish('tasks', task.id, 'Observed');
          }
          return undefined;
        });
        yield* this.persistFailure('tasks', task.id, task, effect);
      }
      return { processed: page.items.length };
    });
  }
  private persistFailure<A, R>(
    kind: 'tasks' | 'receives' | 'repairs',
    id: string,
    slot: MailboxSlot,
    effect: Effect.Effect<A, ClientError | EpochRotationError, R>
  ) {
    return effect.pipe(
      Effect.asVoid,
      // Storage failure may mean a commit happened. Leave journal recoverable; defects propagate.
      Effect.catchTag('TransportError', () => Effect.void),
      Effect.catchTags({
        ValidationError: (e) => this.failWithCurrentDisposition(kind, id, slot, e.code),
        AuthorizationError: (e) => this.failWithCurrentDisposition(kind, id, slot, e.operation),
        ContextMismatch: (e) => this.failWithCurrentDisposition(kind, id, slot, e.context),
        CryptoError: (e) => this.finish(kind, id, 'Failed', e.operation),
        EpochRotationError: (e) => this.finish(kind, id, 'Failed', e.reason),
        StreamProtocolError: (e) => this.finish(kind, id, 'Failed', e.code),
      })
    );
  }
  private failWithCurrentDisposition(
    kind: 'tasks' | 'receives' | 'repairs',
    id: string,
    slot: MailboxSlot,
    code: string
  ) {
    return Effect.gen({ self: this }, function* () {
      const view = yield* this.client.refresh();
      const disposition =
        this.disposition(view, slot) ??
        (kind === 'tasks' && !canSendEpoch(view.inspectState(), this.signer.publicKey.toBytes())
          ? 'Revoked'
          : null);
      yield* this.finish(kind, id, disposition ?? 'Failed', code);
    });
  }
  /** Verified receive context is durable BEFORE keyring.put; no plaintext in this journal. */
  receiveAndInstall(sender: DeviceSigner['Service']['publicKey'], input: Uint8Array) {
    const frame = new Uint8Array(input);
    return Effect.gen({ self: this }, function* () {
      const routing = yield* Effect.fromResult(envelopeRouting(frame));
      if (
        routing.sender !== keyId(sender.toBytes()) ||
        routing.recipient !== keyId(this.signer.publicKey.toBytes())
      )
        return yield* Effect.fail(new ValidationError({ code: 'unauthorized' }));
      const view = yield* this.client.refresh();
      const remote = yield* KeyMailboxRemote;
      const slot = { genesis: routing.genesis, epoch: routing.epoch, recipient: routing.recipient };
      const status = yield* remote.status(slot);
      const context: InstallationContext = {
        ...slot,
        commitment: keyId(view.inspectState().epoch.keyCommitment),
        revision: status.revision,
        source: {
          _tag: 'Envelope',
          sender: keyId(sender.toBytes()),
          frameDigest: mailboxDigest(frame),
        },
      };
      yield* Effect.fromResult(checkInstallationContext(view, context));
      const task: ReceiveTask = {
        id: receiveTaskId(context),
        context,
        frame: keyId(frame),
        publication: null,
        report: null,
        phase: 'verify',
      };
      yield* this.saveReceive(task);
      yield* this.completeReceive(task).pipe(
        Effect.catchTags({
          ValidationError: (e) =>
            this.failWithCurrentDisposition('receives', task.id, slot, e.code).pipe(
              Effect.andThen(Effect.fail(e))
            ),
          CryptoError: (e) =>
            this.finish('receives', task.id, 'Failed', e.operation).pipe(
              Effect.andThen(Effect.fail(e))
            ),
          ContextMismatch: (e) =>
            this.failWithCurrentDisposition('receives', task.id, slot, e.context).pipe(
              Effect.andThen(Effect.fail(e))
            ),
        })
      );
      const keyring = yield* EpochKeyring;
      const installed = yield* keyring.get(
        view.genesis,
        yield* Effect.fromResult(epochNumber(routing.epoch))
      );
      if (installed === null)
        return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
      yield* Effect.fromResult(checkEpochKey(view.inspectState(), installed));
      return { _tag: 'Installed' as const, epoch: routing.epoch as number };
    });
  }
  /** Publisher only: exact verified genesis/publishEpoch plus matching durable key. */
  recordLocalInstallation(input: Uint8Array) {
    const record = new Uint8Array(input);
    return Effect.gen({ self: this }, function* () {
      const view = yield* this.client.refresh();
      const state = view.inspectState();
      const remote = yield* KeyMailboxRemote;
      const slot = {
        genesis: keyId(state.genesis),
        epoch: state.epoch.number,
        recipient: keyId(this.signer.publicKey.toBytes()),
      };
      const status = yield* remote.status(slot);
      const context: InstallationContext = {
        ...slot,
        commitment: keyId(state.epoch.keyCommitment),
        revision: status.revision,
        source: { _tag: 'LocalPublication', recordHash: keyId(hashRecordBytes(record)) },
      };
      yield* Effect.fromResult(checkInstallationContext(view, context));
      yield* Effect.fromResult(checkLocalPublication(view, context, record));
      const task: ReceiveTask = {
        id: receiveTaskId(context),
        context,
        frame: null,
        publication: keyId(record),
        report: null,
        phase: 'install',
      };
      yield* this.saveReceive(task);
      yield* this.completeReceive(task);
    });
  }
  private saveReceive(task: ReceiveTask) {
    return this.update((doc) => {
      const existing = doc.receives.find((t) => t.id === task.id);
      if (existing && existing.context.revision === task.context.revision)
        return Effect.succeed(doc);
      // Explicit repair permits the same retained ciphertext to install/report again.
      return Effect.succeed({
        ...doc,
        receives: [...doc.receives.filter((t) => t.id !== task.id), task],
      });
    });
  }
  private completeReceive(request: ReceiveTask) {
    return Effect.gen({ self: this }, function* () {
      const task = (yield* this.read()).receives.find((t) => t.id === request.id);
      if (!task || task.phase === 'done' || task.phase === 'report') return undefined;
      const view = yield* this.client.refresh();
      yield* Effect.fromResult(checkInstallationContext(view, task.context));
      if (task.context.source._tag === 'Envelope') {
        if (!task.frame || mailboxDigest(fromHex(task.frame)) !== task.context.source.frameDigest)
          return yield* Effect.fail(new ValidationError({ code: 'canonical' }));
        const sender = yield* Effect.fromResult(
          signingPublicKey(fromHex(task.context.source.sender))
        );
        yield* authorizeEpochDelivery(
          this.client,
          sender,
          this.signer.publicKey,
          fromHex(task.frame)
        );
      }
      const keyring = yield* EpochKeyring;
      const epoch = yield* Effect.fromResult(epochNumber(task.context.epoch));
      let key = yield* keyring.get(view.genesis, epoch);
      if (task.phase === 'verify' || key === null) {
        if (task.frame === null || task.context.source._tag !== 'Envelope')
          return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
        const sender = yield* Effect.fromResult(
          signingPublicKey(fromHex(task.context.source.sender))
        );
        const opened = yield* openVerifiedEnvelope(
          this.client,
          this.signer.publicKey,
          sender,
          fromHex(task.frame)
        );
        key = opened.key;
        // Persist commitment-checked provenance before keyring write. A 'verify' checkpoint
        // never lets a pre-existing local key stand in for checking this ciphertext.
        if (task.phase === 'verify')
          yield* this.update((doc) =>
            Effect.succeed({
              ...doc,
              receives: doc.receives.map((t) =>
                t.id === task.id && t.phase === 'verify' ? { ...t, phase: 'install' } : t
              ),
            })
          );
        yield* keyring.put(opened.genesis, opened.epoch, key);
      }
      yield* Effect.fromResult(checkEpochKey(view.inspectState(), key));
      // The recorded context and keyring are independent stores. Reload key after a crash;
      // signing/report queue follows successful durable put, never precedes it.
      const latest = yield* this.client.refresh();
      yield* Effect.fromResult(checkInstallationContext(latest, task.context));
      if (task.context.source._tag === 'LocalPublication') {
        if (!task.publication)
          return yield* Effect.fail(new ValidationError({ code: 'canonical' }));
        yield* Effect.fromResult(
          checkLocalPublication(latest, task.context, fromHex(task.publication))
        );
      }
      const body = yield* Effect.fromResult(installationBody(task.context));
      const sig = yield* this.signer.sign(installationSigningBytes(body));
      const report = yield* Effect.fromResult(
        encodeInstallationReport(task.context, sig.toBytes())
      );
      yield* this.update((doc) =>
        Effect.succeed({
          ...doc,
          receives: doc.receives.map((t) =>
            t.id === task.id &&
            t.context.revision === task.context.revision &&
            t.phase === 'install'
              ? { ...t, phase: 'report', report: keyId(report) }
              : t
          ),
        })
      );
      return undefined;
    });
  }
  resumeReceives(limit = 100) {
    return Effect.gen({ self: this }, function* () {
      const page = yield* Effect.fromResult(
        boundedPage(
          (yield* this.read()).receives.filter(
            (t) => t.phase === 'verify' || t.phase === 'install'
          ),
          null,
          limit
        )
      );
      for (const task of page.items)
        yield* this.persistFailure('receives', task.id, task.context, this.completeReceive(task));
      return { processed: page.items.length };
    });
  }
  flushInstallationReports(limit = 100) {
    return Effect.gen({ self: this }, function* () {
      const remote = yield* KeyMailboxRemote;
      const page = yield* Effect.fromResult(
        boundedPage(
          (yield* this.read()).receives.filter((t) => t.phase === 'report'),
          null,
          limit
        )
      );
      for (const task of page.items)
        yield* this.persistFailure(
          'receives',
          task.id,
          task.context,
          Effect.gen({ self: this }, function* () {
            const view = yield* this.client.refresh();
            yield* Effect.fromResult(checkInstallationContext(view, task.context));
            const bytes = fromHex(task.report!);
            const decoded = yield* Effect.fromResult(decodeInstallationReport(bytes));
            if (
              !bytesEqual(
                yield* Effect.fromResult(installationBody(decoded.context)),
                yield* Effect.fromResult(installationBody(task.context))
              )
            )
              return yield* Effect.fail(new ValidationError({ code: 'canonical' }));
            yield* remote.report(
              bytes,
              task.publication === null ? undefined : fromHex(task.publication)
            );
            yield* this.finish('receives', task.id, 'Reported');
            return undefined;
          })
        );
      return { processed: page.items.length };
    });
  }
  fetchAndInstall(cursor: string | null = null, limit = 100) {
    return Effect.gen({ self: this }, function* () {
      const view = yield* this.client.refresh();
      const remote = yield* KeyMailboxRemote;
      const page = yield* remote.fetch(view.inspectState().epoch.number, cursor, limit);
      for (const row of page.items) {
        const sender = yield* Effect.fromResult(signingPublicKey(fromHex(row.sender)));
        yield* this.receiveAndInstall(sender, row.frame);
      }
      return { processed: page.items.length, next: page.next };
    });
  }
  /** Persist a repair episode before attempting the network. Caller supplies a stable
   * request ID for retries, a new ID for a later loss. Durable retries reuse it. */
  requestRepair(requestId: string, rejectedDigest?: string) {
    return Effect.gen({ self: this }, function* () {
      if (
        !requestId ||
        requestId.length > 256 ||
        (rejectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(rejectedDigest))
      )
        return yield* Effect.fail(new ValidationError({ code: 'canonical' }));
      const view = yield* this.client.refresh();
      const slot = {
        genesis: keyId(view.genesis.toBytes()),
        epoch: view.inspectState().epoch.number,
        recipient: keyId(this.signer.publicKey.toBytes()),
      };
      yield* this.update((doc) => {
        const existing = doc.repairs.find((t) => t.id === requestId);
        if (existing) {
          if (
            existing.genesis !== slot.genesis ||
            existing.epoch !== slot.epoch ||
            existing.recipient !== slot.recipient ||
            existing.rejectedDigest !== (rejectedDigest ?? null)
          )
            return Effect.fail(new ValidationError({ code: 'replay' }));
          return Effect.succeed(doc);
        }
        return Effect.succeed({
          ...doc,
          repairs: [
            ...doc.repairs,
            {
              ...slot,
              id: requestId,
              rejectedDigest: rejectedDigest ?? null,
              phase: 'pending' as const,
            },
          ],
        });
      });
      return yield* this.flushRepairs();
    });
  }
  flushRepairs(limit = 100) {
    return Effect.gen({ self: this }, function* () {
      const remote = yield* KeyMailboxRemote;
      const page = yield* Effect.fromResult(
        boundedPage(
          (yield* this.read()).repairs.filter((t) => t.phase === 'pending'),
          null,
          limit
        )
      );
      for (const task of page.items)
        yield* this.persistFailure(
          'repairs',
          task.id,
          task,
          Effect.gen({ self: this }, function* () {
            const view = yield* this.client.refresh();
            const reason = this.disposition(view, task);
            if (reason) return yield* this.finish('repairs', task.id, reason);
            yield* remote.repair(task, task.id, task.rejectedDigest ?? undefined);
            yield* this.finish('repairs', task.id, 'Repaired');
            return undefined;
          })
        );
      return { processed: page.items.length };
    });
  }
  readUnacknowledgedResults(cursor: string | null = null, limit = 100) {
    return this.read().pipe(
      Effect.flatMap((doc) => Effect.fromResult(boundedPage(doc.results, cursor, limit)))
    );
  }
  acknowledgeResult(id: string) {
    return this.update((doc) => Effect.succeed(acknowledgeResult(doc, id))).pipe(Effect.asVoid);
  }
}
