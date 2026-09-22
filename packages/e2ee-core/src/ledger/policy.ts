import { Either } from 'effect';
import { applyPolicyChanges, genesisState, operationChanges } from '../pure/ledger-policy';
import { operationProofJobs } from '../pure/operation-proofs';
import type { InternalState } from '../pure/ledger-state';
export { cloneState, publicState } from '../pure/ledger-state';
export type {
  Member,
  Device,
  EpochState,
  OrgState,
  HistoryPacketRow,
  InternalState,
} from '../pure/ledger-state';
import {
  assertSignature,
  liveSigningPointCache,
  type Hash,
  type SigningPointCache,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import { type GenesisFields, type Operation } from './schema';

export function verifyOperationProofs(
  genesis: Hash,
  operation: Operation,
  cache?: SigningPointCache,
  targetMembershipId?: Uint8Array
): void {
  const result = operationProofJobs(genesis, operation, targetMembershipId);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  for (const job of result.right) {
    assertSignature(job.pk, job.msg, job.sig, 'bad-proof', cache);
  }
}

export function applyGenesis(
  fields: GenesisFields,
  recordHash: Hash,
  cache = liveSigningPointCache
): InternalState {
  const result = genesisState(fields, recordHash, cache.schemaFacts);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

/** Temporary legacy replay adapter. All policy decisions live in pure/ledger-policy.
 * Only the privately owned replay accumulator is mutated, after complete success.
 * No full state/history clone per record, and no externally reusable authorization. */
export function applyOperation(
  state: InternalState,
  signer: SigningPublicKey,
  operation: Operation,
  cache = liveSigningPointCache
): void {
  const result = operationChanges(state, signer, operation, cache.schemaFacts);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  applyPolicyChanges(state, result.right);
}
