import { Context, Effect, Layer, Result, Schema, Semaphore } from 'effect';
import * as Bytes from '../foundation/bytes';
import { prepareLedgerCommand, type LedgerCommand } from '../ledger/admission';
import { signLedgerRecord } from '../ledger/signing';
import { decodeRecord, hasVerifiedCheckpoint } from '../ledger';
import { makeCloseGuard, own, ownIdentity } from '../lifecycle';
import { LedgerSubmission } from '../submission';
import { LedgerSync, type SubmissionResult } from '../../services/ledger';
import { DeviceIdentity } from '../../services/workspace';

/**
 * A workspace ledger command was refused.
 *
 * - `pending`: a submission is in flight or unacknowledged; resume or
 *   acknowledge it first (no new record is signed meanwhile).
 * - `feed-not-persisted`: the local feed does not yet contain the checkpoint
 *   the submission observed, so acknowledging could lose the result.
 * - `invalid-command`: the command or original record is malformed or not
 *   signed by this device.
 *
 * @category Errors
 */
export class WorkspaceControlError extends Schema.TaggedError<WorkspaceControlError>()(
  'WorkspaceControlError',
  {
    reason: Schema.Literals(['pending', 'closed', 'feed-not-persisted', 'invalid-command']),
  }
) {}
const fail = (reason: WorkspaceControlError['reason']) => new WorkspaceControlError({ reason });

function captureCommand(command: LedgerCommand) {
  return Result.gen(function* () {
    switch (command._tag) {
      case 'AdmitMember': {
        const r = command.request;
        return Object.freeze({
          _tag: command._tag,
          membershipId: yield* Bytes.membershipId(command.membershipId.toBytes()),
          request: Object.freeze({
            requestId: yield* Bytes.requestId(r.requestId.toBytes()),
            userId: yield* Bytes.userId(r.userId.toBytes()),
            signingPublicKey: yield* Bytes.signingPublicKey(r.signingPublicKey.toBytes()),
            encryptionPublicKey: yield* Bytes.encryptionPublicKey(r.encryptionPublicKey.toBytes()),
            expiresAt: r.expiresAt,
            signature: yield* Bytes.signature(r.signature.toBytes()),
          }),
        });
      }
      case 'AdmitDevice':
        return Object.freeze({
          _tag: command._tag,
          kind: command.kind,
          signingPublicKey: yield* Bytes.signingPublicKey(command.signingPublicKey.toBytes()),
          encryptionPublicKey: yield* Bytes.encryptionPublicKey(
            command.encryptionPublicKey.toBytes()
          ),
          possessionSignature: yield* Bytes.signature(command.possessionSignature.toBytes()),
          ...(command.machineId !== undefined ? { machineId: command.machineId } : {}),
          ...(command.replaces !== undefined
            ? {
                replaces:
                  command.replaces === null
                    ? null
                    : yield* Bytes.signingPublicKey(command.replaces.toBytes()),
              }
            : {}),
        });
      case 'SetRole':
        return Object.freeze({
          _tag: command._tag,
          role: command.role,
          membershipId: yield* Bytes.membershipId(command.membershipId.toBytes()),
        });
      case 'RevokeDevice':
        return Object.freeze({
          _tag: command._tag,
          target: yield* Bytes.signingPublicKey(command.target.toBytes()),
        });
      case 'TransferOwner':
        return Object.freeze({
          _tag: command._tag,
          successorMembershipId: yield* Bytes.membershipId(command.successorMembershipId.toBytes()),
        });
    }
    return yield* Result.fail(fail('invalid-command'));
  });
}

/**
 * Sign and submit ordinary ledger commands (admit member or device, set role,
 * revoke device, transfer owner) for this device, one at a time.
 *
 * Each command is prepared against a freshly refreshed genuine view and signed
 * once; the original is submitted through {@link LedgerSubmission}. A pending or
 * unacknowledged submission blocks all new signing. Results are acknowledged
 * only after the local feed contains the checkpoint the submission observed.
 * No automatic rebase or re-sign: a conflict needs a fresh user intent.
 *
 * @category Workflows
 */
export class WorkspaceControl extends Context.Service<
  WorkspaceControl,
  {
    /** Read the local feed through LedgerSync without network work; source-specific failures propagate. */
    current(): Effect.Effect<Effect.Success<ReturnType<LedgerSync['Service']['current']>>, unknown>;
    /** Refresh the verified feed through LedgerSync; source-specific failures propagate without authorizing a command. */
    refresh(): Effect.Effect<Effect.Success<ReturnType<LedgerSync['Service']['refresh']>>, unknown>;
    /** Prepare and sign once against a refreshed view, then submit; pending or unacknowledged work blocks new signing. */
    execute(command: LedgerCommand): Effect.Effect<SubmissionResult, unknown>;
    /** Submit the exact caller-supplied signed record; conflicts never trigger rebase or re-signing. */
    executeOriginal(record: Uint8Array): Effect.Effect<SubmissionResult, unknown>;
    /** Resume the journaled original, or return null; never signs a replacement for an uncertain outcome. */
    resume(): Effect.Effect<SubmissionResult | null, unknown>;
    /** Consume only after the local feed durably contains the observed submission checkpoint; otherwise fail feed-not-persisted. */
    acknowledge(result: SubmissionResult): Effect.Effect<void, unknown>;
  }
>()('@lody/e2ee-core/WorkspaceControl') {
  /** Requires `DeviceIdentity`, `LedgerSubmission` and {@link LedgerSync}. */
  static readonly layer = Layer.effect(
    WorkspaceControl,
    Effect.gen(function* () {
      const signer = ownIdentity(yield* DeviceIdentity).signer;
      const submission = own(yield* LedgerSubmission);
      const sync = own(yield* LedgerSync);
      const serial = yield* Semaphore.make(1);
      const gate = yield* makeCloseGuard(() => fail('closed'));
      const refresh = () => gate.run(sync.refresh());
      const noPending = Effect.fnUntraced(function* () {
        yield* gate.guard;
        if ((yield* submission.pending()).record) return yield* fail('pending');
        return undefined;
      });
      return WorkspaceControl.of({
        current: Effect.fn('@lody/e2ee-core/WorkspaceControl.current')(function* () {
          return yield* sync.current();
        }),
        refresh: Effect.fn('@lody/e2ee-core/WorkspaceControl.refresh')(function* () {
          return yield* serial.withPermit(refresh());
        }),
        executeOriginal: Effect.fn('@lody/e2ee-core/WorkspaceControl.executeOriginal')(
          function* (source) {
            const parsed = yield* Effect.fromResult(decodeRecord(new Uint8Array(source)));
            return yield* serial.withPermit(
              Effect.gen(function* () {
                yield* noPending();
                if (parsed.body.type !== 'ordinary' || !parsed.body.signer.equals(signer.publicKey))
                  return yield* fail('invalid-command');
                yield* refresh();
                const result = yield* submission.submit(parsed.recordBytes);
                yield* refresh();
                return result;
              })
            );
          }
        ),
        execute: Effect.fn('@lody/e2ee-core/WorkspaceControl.execute')(function* (command) {
          const owned = yield* Effect.fromResult(captureCommand(command));
          return yield* serial.withPermit(
            Effect.gen(function* () {
              // A retained pending or unacknowledged result forbids all new signing.
              yield* noPending();
              const current = yield* refresh();
              const proposal = yield* Effect.fromResult(
                prepareLedgerCommand(current.view, signer.publicKey, owned)
              );
              const record = yield* signLedgerRecord(proposal, signer);
              yield* gate.guard;
              const result = yield* submission.submit(record);
              yield* refresh();
              return result;
            })
          );
        }),
        resume: Effect.fn('@lody/e2ee-core/WorkspaceControl.resume')(function* () {
          return yield* serial.withPermit(
            Effect.gen(function* () {
              yield* gate.guard;
              const result = yield* submission.resume();
              if (result) yield* refresh();
              return result;
            })
          );
        }),
        acknowledge: Effect.fn('@lody/e2ee-core/WorkspaceControl.acknowledge')(function* (result) {
          return yield* serial.withPermit(
            Effect.gen(function* () {
              yield* gate.guard;
              const entry = yield* submission.pending();
              const current = yield* sync.current();
              if (
                !entry.checkpoint ||
                !(yield* Effect.fromResult(hasVerifiedCheckpoint(current.view, entry.checkpoint)))
              )
                return yield* fail('feed-not-persisted');
              return yield* submission.acknowledge(result);
            })
          );
        }),
      });
    })
  );
}
