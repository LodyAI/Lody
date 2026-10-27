import { Cause, Context, Effect, Layer, Result, Schema } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual, encodeCbor } from '../foundation/cbor';
import { disposeEpochKey } from '../foundation/epoch-key';
import { keyId } from '../foundation/identifiers';
import { signVerified } from '../foundation/signing';
import { verifySignature } from '../foundation/signature';
import { openEpochKeyHpke } from '../crypto/hpke';
import { hashRecordBytes } from '../ledger';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { makeCloseGuard, own, ownIdentity } from '../lifecycle';
import { KeyMailbox } from '../../services/keys';
import { ReceiveJournal, type ReceiveTaskRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import type { BackendError, LocalStoreError } from '../../services/errors';
import {
  authenticateEpochEnvelope,
  authenticateEpochEnvelopeSignature,
  openEpochEnvelope,
} from './envelope';
import { commitEpochKey } from './history';
import { InstalledEpochKeys, type InstalledKeyError } from './installed-keys';
import { ContentError, type ValidationError } from '../foundation/errors';
import type { LedgerError } from '../ledger/errors';
import type { EpochKeyError } from './history';
import type { EpochStagingError } from './staging';
import { HpkePrimitiveError } from '../crypto/hpke';
import * as Reports from './reports';
import {
  authenticateEpochStagedGroup,
  ownEpochStagedGroup,
  type EpochStagedGroup,
} from './staging';

/**
 * A recipient installation step failed.
 *
 * `context-changed` means the ledger or the mailbox revision moved while the
 * task was in flight; the task is retried by `resume`/`flushReports` or ended as
 * `Obsolete`/`Revoked`. `missing-task` means the referenced task or envelope does
 * not exist. Other reasons are as named.
 *
 * @category Errors
 */
export class ReceiveError extends Schema.TaggedError<ReceiveError>()('ReceiveError', {
  reason: Schema.Literals([
    'invalid-input',
    'closed',
    'storage',
    'corrupt',
    'rollback',
    'context-changed',
    'missing-task',
    'invalid-page',
    'unauthorized',
  ]),
}) {}

/**
 * One fetched envelope failed to install. Identifies the failed envelope so the
 * application can decide whether to request a repair; it is not permission to
 * reject the envelope or to advance a fetch cursor. `cause` distinguishes a
 * cryptographic rejection from a retryable local storage or native failure.
 * `cryptographicRejection` is true only at frame authentication/open; later
 * local signing or persistence failures never authorize rejecting the frame.
 *
 * @category Errors
 */
export class MailboxInstallError extends Schema.TaggedError<MailboxInstallError>()(
  'MailboxInstallError',
  {
    genesis: Schema.String,
    epoch: Schema.Number,
    recipient: Schema.String,
    sender: Schema.String,
    frameDigest: Schema.String,
    /** True only for a rejection observed while authenticating/opening this frame. */
    cryptographicRejection: Schema.Boolean,
    cause: Schema.Defect(),
  }
) {}
const fail = (reason: ReceiveError['reason']) => new ReceiveError({ reason });
const fromStore = (error: LocalStoreError) =>
  fail(error.reason === 'closed' ? 'closed' : error.reason === 'storage' ? 'storage' : 'corrupt');
const fromLedger = (error: VerifiedLedgerError) =>
  fail(
    error.reason === 'rollback' ? 'rollback' : error.reason === 'corrupt' ? 'corrupt' : 'storage'
  );

interface Task {
  readonly id: string;
  readonly body: Uint8Array;
  readonly context: Reports.InstallationContext;
  readonly frame: Uint8Array | null;
  readonly publication: Uint8Array | null;
  readonly report: Uint8Array | null;
  readonly phase: ReceiveTaskRow['phase'];
}
const bounded = (value: unknown, max: number): value is Uint8Array =>
  value instanceof Uint8Array && value.length > 0 && value.length <= max;
const pageLimit = (limit: number) => Number.isInteger(limit) && limit >= 1 && limit <= 100;
const sameNullable = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null ? b === null : b !== null && bytesEqual(a, b);

/**
 * Every failure a {@link KeyReceiver} step can report: its own
 * {@link ReceiveError}, a mailbox {@link BackendError}, an installed-key
 * failure, or a protocol rejection of the received bytes (envelope, signature,
 * staged group, key commitment).
 */
export type ReceiveFailure =
  | ReceiveError
  | InstalledKeyError
  | BackendError
  | ContentError
  | ValidationError
  | LedgerError
  | EpochKeyError
  | EpochStagingError
  | HpkePrimitiveError;

/** Outcome of one finite batch over durable tasks. */
export interface ReceiveBatch {
  readonly processed: number;
  /** Task ids that failed and did not reach a terminal phase; retried by the next batch. */
  readonly blocked: readonly string[];
  readonly next: string | null;
}

/**
 * Recipient side of epoch-key delivery: install keys this device receives and
 * report the installations.
 *
 * Every received envelope is verified (outer signature, current sender
 * eligibility, commitment) before decryption, installed through
 * {@link InstalledEpochKeys} with a durable reload, then a signed installation
 * report is queued and later sent. Originals are persisted before any network
 * step, so `resume()` and `flushReports()` can finish interrupted work after a
 * restart without re-signing. Ended tasks stay listed by `results()` until
 * `acknowledge()`; nothing is consumed automatically.
 *
 * A report is a signed claim of installation, not proof of custody.
 *
 * @category Workflows
 */
export class KeyReceiver extends Context.Service<
  KeyReceiver,
  {
    /** Verify, install and report one envelope `sender` addressed to this device. */
    receive(
      sender: Bytes.SigningPublicKey,
      frame: Uint8Array
    ): Effect.Effect<{ readonly id: string; readonly outcome: 'Installed' }, ReceiveFailure>;
    /** Install this device's envelope from a staged group whose record the ledger committed. */
    receiveStagedGroup(
      group: EpochStagedGroup
    ): Effect.Effect<
      { readonly outcome: 'Installed'; readonly epoch: number; readonly recordHash: string },
      ReceiveFailure
    >;
    /** Record (and report) the installation of a key this device published itself. */
    recordLocalInstallation(
      record: Uint8Array
    ): Effect.Effect<{ readonly id: string; readonly outcome: 'Installed' }, ReceiveFailure>;
    /** Finish up to `limit` interrupted installations. */
    resume(limit?: number, cursor?: string | null): Effect.Effect<ReceiveBatch, ReceiveFailure>;
    /** Send up to `limit` queued installation reports. */
    flushReports(
      limit?: number,
      cursor?: string | null
    ): Effect.Effect<ReceiveBatch, ReceiveFailure>;
    /** Ended tasks awaiting acknowledgement. */
    results(
      limit?: number
    ): Effect.Effect<
      readonly { readonly id: string; readonly outcome: 'Reported' | 'Obsolete' | 'Revoked' }[],
      ReceiveError
    >;
    /** Mark an ended task consumed; unfinished tasks stay pending. Fails on invalid ids, storage errors or a closed owner. */
    acknowledge(id: string): Effect.Effect<void, ReceiveError>;
    /**
     * Fetch one page of envelopes for the current epoch from {@link KeyMailbox}
     * and `receive` each. Stops at the first install failure, so `next` is only
     * returned when the whole page installed. The cursor is a caller hint and
     * is never persisted.
     */
    fetchAndInstall(
      cursor?: string | null,
      limit?: number
    ): Effect.Effect<
      { readonly processed: number; readonly next: string | null },
      ReceiveFailure | MailboxInstallError
    >;
  }
>()('@lody/e2ee-core/KeyReceiver') {
  /**
   * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
   * {@link InstalledEpochKeys}, {@link KeyMailbox} and {@link ReceiveJournal}.
   */
  static readonly layer = Layer.effect(
    KeyReceiver,
    Effect.gen(function* () {
      const anchor = (yield* WorkspaceScope).genesis;
      const identity = ownIdentity(yield* DeviceIdentity);
      const signer = identity.signer;
      const pair = identity.encryptionKeyPair;
      const ledger = yield* VerifiedLedger;
      const keys = yield* InstalledEpochKeys;
      const mailbox = own(yield* KeyMailbox);
      const journal = own(yield* ReceiveJournal);
      const gate = yield* makeCloseGuard(() => fail('closed'));
      const envelopeStep = <A, E, R>(work: Effect.Effect<A, E, R>, rejected?: () => void) =>
        work.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (
                (error instanceof ContentError &&
                  ['invalid-envelope', 'bad-signature', 'commitment-mismatch'].includes(
                    error.code
                  )) ||
                (error instanceof HpkePrimitiveError && error.code === 'open-failed')
              )
                rejected?.();
            })
          )
        );
      const self = keyId(signer.publicKey.toBytes()),
        org = keyId(anchor.toBytes());

      const current = Effect.fnUntraced(function* () {
        yield* gate.guard;
        const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
        yield* gate.guard;
        return view;
      });
      const parse = (row: ReceiveTaskRow): Task => {
        if (!Reports.isHash(row.id) || !bounded(row.body, 256)) throw fail('corrupt');
        const body = new Uint8Array(row.body);
        // Decode untrusted canonical context only; the placeholder is never used as signature evidence.
        const decoded = Result.getOrThrow(
          Reports.decodeInstallationReport(
            Result.getOrThrow(encodeCbor([body, new Uint8Array(64)]))
          )
        );
        const context = decoded.context;
        if (
          context.genesis !== org ||
          context.recipient !== self ||
          Reports.mailboxDigest(body) !== row.id
        )
          throw fail('corrupt');
        const frame = bounded(row.frame, 512) ? new Uint8Array(row.frame) : null;
        const publication = bounded(row.publication, 8192) ? new Uint8Array(row.publication) : null;
        const signed = bounded(row.report, 512) ? new Uint8Array(row.report) : null;
        if (
          context.source._tag === 'Envelope'
            ? !frame ||
              publication !== null ||
              Reports.mailboxDigest(frame) !== context.source.frameDigest
            : frame !== null ||
              !publication ||
              keyId(hashRecordBytes(publication).toBytes()) !== context.source.recordHash
        )
          throw fail('corrupt');
        if ((row.phase === 'Report' || row.phase === 'Reported') && !signed) throw fail('corrupt');
        if (row.phase === 'Install' && signed) throw fail('corrupt');
        return { id: row.id, body, context, frame, publication, report: signed, phase: row.phase };
      };
      const parsed = (row: ReceiveTaskRow) =>
        Effect.try({
          try: () => parse(row),
          catch: (error) => (error instanceof ReceiveError ? error : fail('corrupt')),
        });
      const load = Effect.fnUntraced(function* (id: string) {
        yield* gate.guard;
        if (!Reports.isHash(id)) return yield* fail('invalid-input');
        const row = yield* journal.load(id).pipe(Effect.mapError(fromStore));
        if (!row) return yield* fail('missing-task');
        return yield* parsed(row);
      });
      const revision = Effect.fnUntraced(function* (context: Reports.InstallationContext) {
        yield* gate.guard;
        const hint = yield* mailbox.status({ genesis: org, epoch: context.epoch, recipient: self });
        yield* gate.guard;
        if (
          hint.genesis !== org ||
          hint.recipient !== self ||
          hint.epoch !== context.epoch ||
          !Number.isSafeInteger(hint.revision) ||
          hint.revision < 0 ||
          hint.revision !== context.revision
        )
          return yield* fail('context-changed');
        return undefined;
      });
      const saveOriginal = Effect.fnUntraced(function* (
        context: Reports.InstallationContext,
        frame: Uint8Array | null,
        publication: Uint8Array | null
      ) {
        const body = yield* Effect.fromResult(Reports.installationBody(context)),
          id = Reports.mailboxDigest(body);
        yield* gate.guard;
        yield* journal
          .insertIfAbsent({ id, body, frame, publication })
          .pipe(Effect.mapError(fromStore));
        const original = yield* load(id);
        if (
          !bytesEqual(original.body, body) ||
          !sameNullable(original.frame, frame) ||
          !sameNullable(original.publication, publication)
        )
          return yield* fail('corrupt');
        return id;
      });
      const check = Effect.fnUntraced(function* (task: Task) {
        const view = yield* current();
        yield* Effect.fromResult(Reports.checkInstallationContext(view, task.context));
        yield* revision(task.context);
        return view;
      });
      const readInstalled = (epoch: number) =>
        Effect.acquireUseRelease(
          keys.read(epoch),
          () => Effect.void,
          (key) => Effect.sync(() => disposeEpochKey(key))
        );

      const finishInstallation = Effect.fnUntraced(function* (id: string, rejected?: () => void) {
        const task = yield* load(id);
        if (task.phase === 'Revoked' || task.phase === 'Obsolete')
          return yield* fail('context-changed');
        if (task.phase === 'Report' || task.phase === 'Reported') {
          const existingView = yield* check(task);
          if (!task.report) return yield* fail('corrupt');
          const signedContext = yield* Effect.fromResult(
            Reports.authenticateInstallationReport({
              view: existingView,
              genesis: anchor,
              authenticatedRecipient: signer.publicKey,
              report: task.report,
            })
          );
          if (
            !bytesEqual(
              yield* Effect.fromResult(Reports.installationBody(signedContext)),
              task.body
            )
          )
            return yield* fail('corrupt');
          yield* readInstalled(task.context.epoch);
          return undefined;
        }
        const view = yield* check(task);
        if (task.frame && task.context.source._tag === 'Envelope') {
          const sender = yield* Effect.fromResult(
            Bytes.signingPublicKey(Reports.fromHex(task.context.source.sender))
          );
          const context = {
            genesis: anchor,
            epoch: yield* Effect.fromResult(Bytes.epochNumber(task.context.epoch)),
            sender,
            recipient: signer.publicKey,
          };
          // Install is pending work, not evidence that this ciphertext has been opened.
          yield* Effect.acquireUseRelease(
            envelopeStep(
              openEpochEnvelope({ context, pair, frame: task.frame, ledger: current }),
              rejected
            ),
            (key) => keys.saveAndReload(task.context.epoch, key),
            (key) => Effect.sync(() => disposeEpochKey(key))
          );
        } else if (task.publication)
          yield* Effect.fromResult(
            Reports.checkLocalPublication(view, task.context, task.publication)
          );
        else return yield* fail('corrupt');
        yield* Effect.acquireUseRelease(
          keys.read(task.context.epoch),
          (key) =>
            Effect.gen(function* () {
              const digest = yield* Effect.fromResult(
                commitEpochKey(anchor, task.context.epoch, key)
              );
              if (keyId(digest.toBytes()) !== task.context.commitment)
                return yield* fail('corrupt');
              return undefined;
            }),
          (key) => Effect.sync(() => disposeEpochKey(key))
        );
        yield* check(task);
        const signed = yield* signVerified(signer, Reports.installationSigningBytes(task.body));
        const bytes = yield* Effect.fromResult(
          Reports.encodeInstallationReport(task.context, signed.toBytes())
        );
        const latest = yield* check(task);
        yield* Effect.fromResult(
          Reports.authenticateInstallationReport({
            view: latest,
            genesis: anchor,
            authenticatedRecipient: signer.publicKey,
            report: bytes,
          })
        );
        yield* gate.guard;
        yield* journal
          .queueReport(id, bytes)
          .pipe(
            Effect.mapError((error) =>
              error.reason === 'conflict' ? fail('corrupt') : fromStore(error)
            )
          );
        const queued = yield* load(id);
        if (queued.phase !== 'Report' || !queued.report || !bytesEqual(queued.report, bytes))
          return yield* fail('corrupt');
        return undefined;
      });

      const flush = Effect.fnUntraced(function* (id: string) {
        const task = yield* load(id);
        if (task.phase === 'Reported') return undefined;
        if (task.phase !== 'Report' || !task.report) return yield* fail('corrupt');
        const view = yield* check(task);
        const decoded = yield* Effect.fromResult(
          Reports.authenticateInstallationReport({
            view,
            genesis: anchor,
            authenticatedRecipient: signer.publicKey,
            report: task.report,
          })
        );
        const body = yield* Effect.fromResult(Reports.installationBody(decoded));
        if (!bytesEqual(body, task.body)) return yield* fail('corrupt');
        if (task.publication)
          yield* Effect.fromResult(
            Reports.checkLocalPublication(view, task.context, task.publication)
          );
        // Reload current protected possession even when retrying an already signed claim; never re-sign.
        yield* readInstalled(task.context.epoch);
        yield* check(task);
        yield* gate.guard;
        yield* mailbox.report(
          new Uint8Array(task.report),
          task.publication ? new Uint8Array(task.publication) : undefined
        );
        yield* gate.guard;
        yield* journal.markReported(id).pipe(Effect.mapError(fromStore));
        return undefined;
      });

      const disposition = Effect.fnUntraced(function* (id: string) {
        const task = yield* load(id),
          state = (yield* current()).inspectState();
        const phase =
          state.epoch.number !== task.context.epoch
            ? 'Obsolete'
            : !state.devices.has(self)
              ? 'Revoked'
              : null;
        if (phase) {
          yield* gate.guard;
          yield* journal.end(id, phase).pipe(Effect.mapError(fromStore));
        }
        return phase;
      });

      const batch = Effect.fnUntraced(function* (
        kind: 'install' | 'report',
        limit: number,
        cursor: string | null
      ) {
        yield* gate.guard;
        if (!pageLimit(limit) || (cursor !== null && !Reports.isHash(cursor)))
          return yield* fail('invalid-input');
        // Only ID metadata has a lookahead. No context/frame/report payload is loaded here.
        const page = yield* journal
          .pending(kind === 'install' ? 'Install' : 'Report', cursor, limit)
          .pipe(Effect.mapError(fromStore));
        const blocked: string[] = [];
        for (const id of page.ids) {
          const result = yield* Effect.result(
            kind === 'install' ? finishInstallation(id) : flush(id)
          );
          if (Result.isFailure(result)) {
            const ended = yield* Effect.result(disposition(id));
            if (Result.isFailure(ended) || !ended.success) blocked.push(id);
          }
        }
        yield* gate.guard;
        return { processed: page.ids.length, blocked, next: page.next } satisfies ReceiveBatch;
      });

      const receiveStagedGroup = Effect.fnUntraced(function* (inputGroup: EpochStagedGroup) {
        const original = yield* Effect.fromResult(ownEpochStagedGroup(inputGroup));
        const view = yield* current();
        const { sender } = yield* Effect.fromResult(authenticateEpochStagedGroup(view, original));
        const mine = original.envelopes.find((row) => row.recipient === self);
        if (!mine) return yield* fail('missing-task');
        const context = {
          genesis: anchor,
          epoch: yield* Effect.fromResult(Bytes.epochNumber(original.epoch)),
          sender,
          recipient: signer.publicKey,
        };
        const recipient = view.inspectState().devices.get(self);
        if (!recipient || !view.inspectState().members.has(keyId(recipient.membershipId.toBytes())))
          return yield* fail('context-changed');
        const sealed = yield* Effect.fromResult(
          authenticateEpochEnvelopeSignature(context, mine.frame)
        );
        yield* Effect.acquireUseRelease(
          openEpochKeyHpke(pair, recipient.encryptionPublicKey, context, sealed),
          (key) =>
            Effect.gen(function* () {
              const commitment = yield* Effect.fromResult(
                commitEpochKey(anchor, original.epoch, key)
              );
              if (keyId(commitment.toBytes()) !== original.commitment)
                return yield* fail('corrupt');
              const after = yield* current();
              yield* Effect.fromResult(authenticateEpochStagedGroup(after, original));
              const active = after.inspectState().devices.get(self);
              if (
                !active ||
                !after.inspectState().members.has(keyId(active.membershipId.toBytes())) ||
                !active.encryptionPublicKey.equals(recipient.encryptionPublicKey)
              )
                return yield* fail('context-changed');
              return yield* keys.saveAndReload(original.epoch, key);
            }),
          (key) => Effect.sync(() => disposeEpochKey(key))
        );
        return {
          outcome: 'Installed' as const,
          epoch: original.epoch,
          recordHash: original.recordHash,
        };
      });

      const receive = Effect.fnUntraced(function* (
        senderInput: Bytes.SigningPublicKey,
        inputFrame: Uint8Array,
        rejected?: () => void
      ) {
        if (!bounded(inputFrame, 512)) return yield* fail('invalid-input');
        const frame = new Uint8Array(inputFrame);
        const sender = yield* Effect.fromResult(Bytes.signingPublicKey(senderInput.toBytes()));
        const view = yield* current(),
          epoch = view.inspectState().epoch.number;
        const context = {
          genesis: anchor,
          epoch: yield* Effect.fromResult(Bytes.epochNumber(epoch)),
          sender,
          recipient: signer.publicKey,
        };
        yield* envelopeStep(
          Effect.fromResult(authenticateEpochEnvelope(view, context, frame)),
          rejected
        );
        const target = { genesis: org, epoch, recipient: self },
          hint = yield* mailbox.status(target);
        yield* gate.guard;
        const install: Reports.InstallationContext = {
          ...target,
          commitment: keyId(view.inspectState().epoch.keyCommitment.toBytes()),
          revision: hint.revision,
          source: {
            _tag: 'Envelope',
            sender: keyId(sender.toBytes()),
            frameDigest: Reports.mailboxDigest(frame),
          },
        };
        if (hint.genesis !== org || hint.epoch !== epoch || hint.recipient !== self)
          return yield* fail('context-changed');
        yield* Effect.fromResult(Reports.checkInstallationContext(yield* current(), install));
        const id = yield* saveOriginal(install, frame, null);
        yield* finishInstallation(id, rejected);
        return { id, outcome: 'Installed' as const };
      });

      const recordLocalInstallation = Effect.fnUntraced(function* (inputRecord: Uint8Array) {
        if (!bounded(inputRecord, 8192)) return yield* fail('invalid-input');
        const record = new Uint8Array(inputRecord);
        const view = yield* current(),
          epoch = view.inspectState().epoch.number,
          target = { genesis: org, epoch, recipient: self },
          hint = yield* mailbox.status(target);
        yield* gate.guard;
        const context: Reports.InstallationContext = {
          ...target,
          commitment: keyId(view.inspectState().epoch.keyCommitment.toBytes()),
          revision: hint.revision,
          source: {
            _tag: 'LocalPublication',
            recordHash: keyId(hashRecordBytes(record).toBytes()),
          },
        };
        if (hint.genesis !== org || hint.epoch !== epoch || hint.recipient !== self)
          return yield* fail('context-changed');
        yield* Effect.fromResult(Reports.checkLocalPublication(view, context, record));
        const id = yield* saveOriginal(context, null, record);
        yield* finishInstallation(id);
        return { id, outcome: 'Installed' as const };
      });

      const results = Effect.fnUntraced(function* (limit: number) {
        yield* gate.guard;
        if (!pageLimit(limit)) return yield* fail('invalid-input');
        const rows = yield* journal.results(limit).pipe(Effect.mapError(fromStore));
        const out: { id: string; outcome: 'Reported' | 'Obsolete' | 'Revoked' }[] = [];
        for (const row of rows) {
          const task = yield* parsed(row);
          if (task.phase === 'Reported') {
            if (!task.report) return yield* fail('corrupt');
            const signed = Reports.decodeInstallationReport(task.report);
            if (
              Result.isFailure(signed) ||
              !bytesEqual(
                Result.getOrThrow(Reports.installationBody(signed.success.context)),
                task.body
              ) ||
              Result.isFailure(
                verifySignature(
                  signer.publicKey.toBytes(),
                  signed.success.message,
                  signed.success.signature.toBytes()
                )
              )
            )
              return yield* fail('corrupt');
          }
          out.push({ id: task.id, outcome: task.phase as 'Reported' | 'Obsolete' | 'Revoked' });
        }
        return out;
      });

      const validCursor = (value: unknown): value is string =>
        typeof value === 'string' && value.length >= 1 && value.length <= 1024;
      const fetchAndInstall = Effect.fnUntraced(function* (cursor: string | null, limit: number) {
        if (!pageLimit(limit) || (cursor !== null && !validCursor(cursor)))
          return yield* fail('invalid-page');
        const eligible = Effect.fnUntraced(function* () {
          const view = yield* current(),
            state = view.inspectState(),
            device = state.devices.get(self);
          if (!device || !state.members.has(keyId(device.membershipId.toBytes())))
            return yield* fail('unauthorized');
          return state.epoch.number;
        });
        const epoch = yield* eligible();
        const page = yield* mailbox.fetch(epoch, cursor, limit);
        yield* gate.guard;
        const rows = page?.items;
        if (!page || !Array.isArray(rows)) return yield* fail('invalid-page');
        // Capture the length and next cursor once; copy by index so a hostile page
        // cannot change between validation and use.
        const count = rows.length,
          next = page.next;
        if (
          !Number.isInteger(count) ||
          count > limit ||
          (next !== null && (!validCursor(next) || next === cursor)) ||
          (count === 0 && next !== null)
        )
          return yield* fail('invalid-page');
        const items: { sender: Bytes.SigningPublicKey; frame: Uint8Array }[] = [];
        for (let index = 0; index < count; index++) {
          const row = rows[index];
          if (!row) return yield* fail('invalid-page');
          const sender = row.sender,
            frame = row.frame;
          if (!Reports.isHash(sender) || !bounded(frame, 512)) return yield* fail('invalid-page');
          const key = Bytes.signingPublicKey(Reports.fromHex(sender));
          if (Result.isFailure(key)) return yield* fail('invalid-page');
          items.push({ sender: key.success, frame: new Uint8Array(frame) });
        }
        if (rows.length !== count) return yield* fail('invalid-page');
        if ((yield* eligible()) !== epoch) return yield* fail('rollback');
        for (const row of items) {
          const frameDigest = Reports.mailboxDigest(row.frame);
          let cryptographicRejection = false;
          yield* receive(row.sender, row.frame, () => {
            cryptographicRejection = true;
          }).pipe(
            Effect.catchCause((failure) =>
              Effect.failCause(
                Cause.map(
                  failure,
                  (cause) =>
                    new MailboxInstallError({
                      genesis: org,
                      epoch,
                      recipient: self,
                      sender: keyId(row.sender.toBytes()),
                      frameDigest,
                      cryptographicRejection,
                      cause,
                    })
                )
              )
            )
          );
        }
        return { processed: items.length, next };
      });

      return KeyReceiver.of({
        fetchAndInstall: Effect.fn('@lody/e2ee-core/KeyReceiver.fetchAndInstall')(function* (
          cursor = null,
          limit = 100
        ) {
          return yield* gate.run(fetchAndInstall(cursor, limit));
        }),
        receive: Effect.fn('@lody/e2ee-core/KeyReceiver.receive')(function* (sender, frame) {
          return yield* gate.run(receive(sender, frame));
        }),
        receiveStagedGroup: Effect.fn('@lody/e2ee-core/KeyReceiver.receiveStagedGroup')(
          function* (group) {
            return yield* gate.run(receiveStagedGroup(group));
          }
        ),
        recordLocalInstallation: Effect.fn('@lody/e2ee-core/KeyReceiver.recordLocalInstallation')(
          function* (record) {
            return yield* gate.run(recordLocalInstallation(record));
          }
        ),
        resume: Effect.fn('@lody/e2ee-core/KeyReceiver.resume')(function* (
          limit = 100,
          cursor = null
        ) {
          return yield* gate.run(batch('install', limit, cursor));
        }),
        flushReports: Effect.fn('@lody/e2ee-core/KeyReceiver.flushReports')(function* (
          limit = 100,
          cursor = null
        ) {
          return yield* gate.run(batch('report', limit, cursor));
        }),
        results: Effect.fn('@lody/e2ee-core/KeyReceiver.results')(function* (limit = 100) {
          return yield* gate.run(results(limit));
        }),
        acknowledge: Effect.fn('@lody/e2ee-core/KeyReceiver.acknowledge')(function* (id: string) {
          yield* gate.guard;
          if (!Reports.isHash(id)) return yield* fail('invalid-input');
          yield* journal.acknowledge(id).pipe(Effect.mapError(fromStore));
          return undefined;
        }),
      });
    })
  );
}
