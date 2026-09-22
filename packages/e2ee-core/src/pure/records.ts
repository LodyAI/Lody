import { Either } from 'effect';
import type { GenesisHash, RecordHash, SigningPublicKey } from './bytes';
import { bytesEqual } from './cbor';
import { ContextMismatch } from './errors';
import { classifyEpochCandidate, type EpochCandidate } from './epoch-candidate';
import { publicState, type InternalState } from './ledger-state';

const recordMaterial = Symbol('recordMaterial');
const viewMaterial = Symbol('viewMaterial');
const applicationMaterial = Symbol('applicationMaterial');

class RecordValue<Stage extends 'Decoded' | 'SignatureChecked'> {
  readonly #bytes: Uint8Array;
  constructor(
    readonly stage: Stage,
    bytes: Uint8Array,
    readonly signer: SigningPublicKey
  ) {
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }
  toBytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
  [recordMaterial](): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

class ViewValue {
  readonly #state: InternalState;
  readonly origin: 'FullReplay' | 'EndorsedSnapshot';
  constructor(
    state: InternalState,
    readonly genesis: GenesisHash,
    readonly head: RecordHash
  ) {
    this.#state = state;
    this.origin = state.origin === 'genesis' ? 'FullReplay' : 'EndorsedSnapshot';
    Object.freeze(this);
  }
  get length(): number {
    return this.#state.hashes.length;
  }
  get deviceCount(): number {
    return this.#state.devices.size;
  }
  hasRecordHash(digest: Uint8Array): boolean {
    return this.#state.hashes.some((hash) => hash !== undefined && bytesEqual(hash, digest));
  }
  /** Inspection is a defensive copy, never an authorization token. */
  inspectState() {
    return publicState(this.#state);
  }
  inspectEpochCandidate(candidate: EpochCandidate) {
    return classifyEpochCandidate(this.#state, candidate);
  }
  [viewMaterial](): InternalState {
    return this.#state;
  }
}

class ApplicableValue {
  readonly #base: ViewValue;
  readonly #next: ViewValue;
  constructor(base: ViewValue, next: ViewValue) {
    this.#base = base;
    this.#next = next;
    Object.freeze(this);
  }
  [applicationMaterial](base: ViewValue): Either.Either<ViewValue, ContextMismatch> {
    return base === this.#base
      ? Either.right(this.#next)
      : Either.left(new ContextMismatch({ context: 'view' }));
  }
}

export type DecodedRecord = RecordValue<'Decoded'>;
export type SignatureCheckedRecord = RecordValue<'SignatureChecked'>;
export type LedgerView = ViewValue;
export type ApplicableRecord = ApplicableValue;

// Package-internal constructors. Only workflow verification imports these;
// public exports expose types and verifying functions, never these constructors.
export const decodedRecord = (bytes: Uint8Array, signer: SigningPublicKey): DecodedRecord =>
  new RecordValue('Decoded', bytes, signer);
export const checkedRecord = (record: DecodedRecord): SignatureCheckedRecord =>
  new RecordValue('SignatureChecked', record[recordMaterial](), record.signer);
export const ledgerView = (
  state: InternalState,
  genesis: GenesisHash,
  head: RecordHash
): LedgerView => new ViewValue(state, genesis, head);
export const applicableRecord = (base: LedgerView, next: LedgerView): ApplicableRecord =>
  new ApplicableValue(base, next);
export const viewState = (view: LedgerView): InternalState => view[viewMaterial]();
export const applyAuthorizedRecord = (
  base: LedgerView,
  record: ApplicableRecord
): Either.Either<LedgerView, ContextMismatch> => record[applicationMaterial](base);
