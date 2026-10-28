import { Result } from 'effect';
import type { SigningPublicKey } from './foundation/bytes';
import { ContentError } from './foundation/errors';
import { keyId } from './foundation/identifiers';
import {
  decodeRecord,
  hashRecordBytes,
  hasVerifiedCheckpoint,
  requireLedgerContinuation,
  type LedgerView,
} from './ledger';
import { historicalContentIdentity } from './ledger/snapshot';
import type { MachineSharingBinding } from './machine-sharing';

/** Exact machine AdmitDevice original and its one-based verified ledger position. */
export interface MachineSharingAdmission {
  readonly record: Uint8Array;
  readonly length: number;
}
const brand = Symbol('VerifiedMachineSharingGeneration');
/** Genuine ledger-qualified machine incarnation. Generation is its initial admission signing key (hex32).
 * Atomic replacement retains the root; revoke/remove then readmission starts a different root. */
export interface VerifiedMachineSharingGeneration {
  readonly [brand]: true;
  readonly generation: string;
}
const generations = new WeakMap<
  VerifiedMachineSharingGeneration,
  {
    ledger: LedgerView;
    device: SigningPublicKey;
    binding: Omit<MachineSharingBinding, 'workspaceId'>;
  }
>();
const fail = (code: string) => Result.fail(new ContentError({ code }));
const map = <A, E>(value: Result.Result<A, E>) =>
  Result.mapError(value, () => new ContentError({ code: 'machine-generation-proof-unavailable' }));

/** Qualify an initial admission followed by every atomic replacement up to the current device.
 * Each original hash must occupy its supplied position in this genuine view, with increasing positions,
 * one machine/member and an exact replaces chain. No signature/ledger format changes or remote counters.
 * At most 4096 admission records. Unknown snapshot/compact-retained prefixes fail: qualify against a genuine
 * view retaining these checkpoints (normally full replay) at the current endpoint, then use that evidence
 * with a same-position compact view or its continuation. Never infer an unknown prefix from a server hint. */
export function verifyMachineSharingGeneration(input: {
  readonly ledger: LedgerView;
  readonly machineId: string;
  readonly device: SigningPublicKey;
  readonly admissionChain: readonly MachineSharingAdmission[];
}): Result.Result<VerifiedMachineSharingGeneration, ContentError> {
  return Result.gen(function* () {
    yield* map(requireLedgerContinuation(input.ledger, input.ledger));
    if (
      !Array.isArray(input.admissionChain) ||
      input.admissionChain.length < 1 ||
      input.admissionChain.length > 4096
    )
      return yield* fail('machine-generation-proof-unavailable');
    const state = input.ledger.inspectState();
    const current = state.devices.get(keyId(input.device.toBytes()));
    if (!current || current.kind !== 'machine' || current.machineId !== input.machineId)
      return yield* fail('policy-generation-mismatch');
    const ownerMembershipId = keyId(current.membershipId.toBytes());
    let previous: SigningPublicKey | undefined,
      generation = '',
      position = 0;
    for (const step of input.admissionChain) {
      if (!step || !Number.isSafeInteger(step.length) || step.length <= position)
        return yield* fail('machine-generation-proof-unavailable');
      const record = yield* map(decodeRecord(step.record));
      const included = yield* map(
        hasVerifiedCheckpoint(input.ledger, {
          head: hashRecordBytes(record.recordBytes),
          length: step.length,
        })
      );
      if (!included) return yield* fail('machine-generation-proof-unavailable');
      const body = record.body;
      if (
        body.type !== 'ordinary' ||
        body.operation.type !== 'admitDevice' ||
        body.operation.kind !== 'machine' ||
        body.operation.machineId !== input.machineId
      )
        return yield* fail('machine-generation-proof-unavailable');
      const author = yield* map(historicalContentIdentity(input.ledger, body.signer));
      if (keyId(author.memberInstance.toBytes()) !== ownerMembershipId)
        return yield* fail('policy-generation-mismatch');
      const operation = body.operation;
      if (previous ? !operation.replaces?.equals(previous) : operation.replaces !== null)
        return yield* fail('machine-generation-proof-unavailable');
      if (!previous) generation = keyId(operation.signingPublicKey.toBytes());
      previous = operation.signingPublicKey;
      position = step.length;
    }
    if (!previous?.equals(input.device)) return yield* fail('policy-generation-mismatch');
    const proof: VerifiedMachineSharingGeneration = Object.freeze({
      [brand]: true as const,
      generation,
    });
    generations.set(proof, {
      ledger: input.ledger,
      device: previous,
      binding: {
        genesisHash: keyId(input.ledger.genesis.toBytes()),
        machineId: input.machineId,
        ownerMembershipId,
        generation,
      },
    });
    return proof;
  });
}

/** Internal current-binding check; evidence cannot survive revocation/readmission or substitute another generation. */
export function requireMachineSharingGeneration(
  ledger: LedgerView,
  binding: MachineSharingBinding,
  proof: VerifiedMachineSharingGeneration
): Result.Result<void, ContentError> {
  return Result.gen(function* () {
    const row = generations.get(proof);
    if (!row || Result.isFailure(requireLedgerContinuation(row.ledger, ledger)))
      return yield* fail('policy-generation-mismatch');
    const current = ledger.inspectState().devices.get(keyId(row.device.toBytes()));
    if (
      !current ||
      current.kind !== 'machine' ||
      current.machineId !== binding.machineId ||
      keyId(current.membershipId.toBytes()) !== binding.ownerMembershipId ||
      row.binding.genesisHash !== binding.genesisHash ||
      row.binding.machineId !== binding.machineId ||
      row.binding.ownerMembershipId !== binding.ownerMembershipId ||
      row.binding.generation !== binding.generation
    )
      return yield* fail('policy-generation-mismatch');
    return undefined;
  });
}
