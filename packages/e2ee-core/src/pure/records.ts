import { historicalContentIdentity } from './content-policy';
import { Result } from 'effect';
import type { GenesisHash, RecordHash, SigningPublicKey } from './bytes';
import { bytesEqual } from './cbor';
import { ContextMismatch } from './errors';
import { classifyEpochCandidate, type EpochCandidate } from './epoch-candidate';
import { publicState, type InternalState } from './ledger-state';
import { SigningFacts } from './signing-facts';

const recordMaterial = Symbol('recordMaterial');
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

// Module-private: callers cannot reach a view's live state through a symbol.
const viewStates = new WeakMap<object, InternalState>();
// Point-validity evidence gathered while verifying this view; never authority.
const viewSigningFacts = new WeakMap<object, SigningFacts>();

class ViewValue {
  readonly #state: InternalState;
  readonly origin: 'FullReplay' | 'EndorsedSnapshot';
  constructor(
    state: InternalState,
    readonly genesis: GenesisHash,
    readonly head: RecordHash,
    facts: SigningFacts
  ) {
    this.#state = state;
    viewSigningFacts.set(this, facts);
    this.origin = state.origin === 'genesis' ? 'FullReplay' : 'EndorsedSnapshot';
    viewStates.set(this, state);
    Object.freeze(this);
  }
  get length(): number {
    return this.#state.hashes.length;
  }
  contentIdentity(deviceIdHex: string) {
    return historicalContentIdentity(this.#state, deviceIdHex);
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
}

class ApplicableValue {
  readonly #base: ViewValue;
  readonly #next: ViewValue;
  constructor(base: ViewValue, next: ViewValue) {
    this.#base = base;
    this.#next = next;
    Object.freeze(this);
  }
  [applicationMaterial](base: ViewValue): Result.Result<ViewValue, ContextMismatch> {
    return base === this.#base
      ? Result.succeed(this.#next)
      : Result.fail(new ContextMismatch({ context: 'view' }));
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
  head: RecordHash,
  facts = SigningFacts.empty
): LedgerView => new ViewValue(state, genesis, head, facts);
export const applicableRecord = (base: LedgerView, next: LedgerView): ApplicableRecord =>
  new ApplicableValue(base, next);
export const viewState = (view: LedgerView): InternalState => viewStates.get(view)!;
export const viewFacts = (view: LedgerView): SigningFacts => viewSigningFacts.get(view)!;
export const applyAuthorizedRecord = (
  base: LedgerView,
  record: ApplicableRecord
): Result.Result<LedgerView, ContextMismatch> => record[applicationMaterial](base);
