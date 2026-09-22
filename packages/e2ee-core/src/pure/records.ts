import { Either } from 'effect';
import type { Ledger } from '../ledger/ledger';
import type { GenesisHash, RecordHash, SigningPublicKey } from './bytes';
import { ContextMismatch } from './errors';

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
  readonly #ledger: Ledger;
  readonly origin: 'FullReplay' | 'EndorsedSnapshot';
  constructor(
    ledger: Ledger,
    readonly genesis: GenesisHash,
    readonly head: RecordHash
  ) {
    this.#ledger = ledger;
    this.origin = ledger.origin === 'genesis' ? 'FullReplay' : 'EndorsedSnapshot';
    Object.freeze(this);
  }
  get length(): number {
    return this.#ledger.length;
  }
  get deviceCount(): number {
    return this.#ledger.state.devices.size;
  }
  /** Inspection is a defensive copy, never an authorization token. */
  inspectState() {
    return this.#ledger.state;
  }
  [viewMaterial](): Ledger {
    return this.#ledger;
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
export const ledgerView = (ledger: Ledger, genesis: GenesisHash, head: RecordHash): LedgerView =>
  new ViewValue(ledger, genesis, head);
export const applicableRecord = (base: LedgerView, next: LedgerView): ApplicableRecord =>
  new ApplicableValue(base, next);
export const rawLedger = (view: LedgerView): Ledger => view[viewMaterial]();
export const applyAuthorizedRecord = (
  base: LedgerView,
  record: ApplicableRecord
): Either.Either<LedgerView, ContextMismatch> => record[applicationMaterial](base);
