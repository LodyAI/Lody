import { historicalContentIdentity } from '../pure/content-policy';
/** Promise/throw facade over the native verification workflows.
 * It owns no replay, signature or policy logic: every state transition runs
 * `workflows/verification.ts`, and every rule lives in pure/. */
import { Effect, Result, Layer } from 'effect';
import type { SignatureVerifyExecutor } from '../capabilities';
import { SignatureVerifier } from '../ports/ledger';
import {
  genesisHash,
  recordHash,
  signature as signatureBytes,
  signingPublicKey,
} from '../pure/bytes';
import { copyBytes } from '../pure/cbor';
import type { EpochCandidate } from '../pure/epoch-candidate';
import { ValidationError } from '../pure/errors';
import * as snapshots from '../pure/ledger-snapshot';
import { encodeOrdinaryBody, signingBytesForBody, type Operation } from '../pure/ledger-schema';
import { publicState, type InternalState, type OrgState } from '../pure/ledger-state';
import { ledgerView, viewFacts, viewState, type LedgerView } from '../pure/records';
import { SigningFacts } from '../pure/signing-facts';
import { checkSigningPublicKey as checkSigningKey } from '../pure/wire-crypto';
import { headAttestationSigningBytes, snapshotSigningBytes } from '../pure/wire-crypto';
import {
  makeExecutorSignatureVerifier,
  makeSignatureVerifier,
  type SigningPointCache,
} from '../platform/signature-verifier';
import * as verification from '../workflows/verification';
import { legacyVerifierLayer, runLegacy, runLegacySync, unwrap } from './compat';
import { assertSignature, checkHash, checkSignature, checkSigningPublicKey } from './crypto';
import type { Hash, Signature, SigningPublicKey } from './crypto';

export interface TrustAnchor {
  readonly genesis: Hash;
}

export interface LedgerSummary {
  readonly genesis: Hash;
  readonly length: number;
  readonly head: Hash;
}

export interface Proposal {
  readonly signer: SigningPublicKey;
  readonly operation: Operation;
  readonly previousHash: Hash;
  readonly bodyBytes: Uint8Array;
  readonly signingBytes: Uint8Array;
}

export type {
  Comparison,
  ComparisonNote,
  SnapshotProposal,
  SnapshotTrust,
} from '../pure/ledger-snapshot';

function ownedRecords(records: readonly Uint8Array[], start: number): Uint8Array[] {
  return records.map((record, offset) => {
    if (!(record instanceof Uint8Array))
      return unwrap(
        Result.fail(new ValidationError({ code: 'canonical', position: start + offset }))
      );
    return copyBytes(record);
  });
}

function verifierLayer(input: {
  readonly executor?: SignatureVerifyExecutor;
  readonly pointCache?: SigningPointCache;
}): Layer.Layer<SignatureVerifier, ValidationError> {
  return input.executor
    ? Layer.effect(SignatureVerifier, makeExecutorSignatureVerifier(input.executor))
    : Layer.succeed(SignatureVerifier, makeSignatureVerifier({ cache: input.pointCache }));
}

/** Point-validity evidence shared by one Ledger and the values derived from it.
 * It only ever holds checked keys; it is never authority and never process-wide. */
interface Lineage {
  facts: SigningFacts;
}

export class Ledger {
  // A true private field: verified state is unreachable from outside, even via `as any`.
  readonly #view: LedgerView;
  readonly #lineage: Lineage;

  private constructor(view: LedgerView, lineage: Lineage) {
    this.#view = view;
    this.#lineage = lineage;
    lineage.facts = lineage.facts.union(viewFacts(view));
    Object.freeze(this);
  }

  /** Wraps a view that only the verification workflows can produce. */
  static fromView(view: LedgerView): Ledger {
    return new Ledger(view, { facts: SigningFacts.empty });
  }

  #derive = (view: LedgerView): Ledger => new Ledger(view, this.#lineage);

  /** This view carrying every key already checked along its lineage. */
  get #working(): LedgerView {
    const state = viewState(this.#view);
    return ledgerView(state, this.#view.genesis, this.#view.head, this.#lineage.facts);
  }

  #remember(view: LedgerView): LedgerView {
    this.#lineage.facts = this.#lineage.facts.union(viewFacts(view));
    return view;
  }

  /** The verified view, for callers moving to `@lody/e2ee-core/effect`. */
  get view(): LedgerView {
    return this.#view;
  }

  get #internal(): InternalState {
    return viewState(this.#view);
  }

  get head(): Hash {
    return this.#view.head.toBytes();
  }

  get length(): number {
    return this.#view.length;
  }

  get origin(): 'genesis' | 'snapshot' {
    return this.#internal.origin;
  }

  get snapshotLength(): number | null {
    return this.#internal.snapshotLength;
  }

  historyPackets(): ReadonlyMap<number, { commitment: Hash; packet: Uint8Array }> {
    const packets = new Map<number, { commitment: Hash; packet: Uint8Array }>();
    for (const [epoch, row] of this.#internal.historyPackets) {
      packets.set(epoch, {
        commitment: copyBytes(row.commitment),
        packet: copyBytes(row.packet),
      });
    }
    return packets;
  }

  get state(): OrgState {
    return publicState(this.#internal);
  }

  summary(): LedgerSummary {
    return Object.freeze({
      genesis: this.#view.genesis.toBytes(),
      length: this.length,
      head: this.head,
    });
  }

  hashAt(position: number): Hash {
    const hash = Number.isSafeInteger(position) ? this.#internal.hashes[position] : undefined;
    if (!hash) return unwrap(Result.fail(new ValidationError({ code: 'invalid-operation' })));
    return copyBytes(hash);
  }

  /** Whether this signing key was ever admitted as a device here, including revoked ones. */
  wasDeviceAdmitted(deviceIdHex: string): boolean {
    return this.#internal.usedSigningKeys.has(deviceIdHex);
  }

  /** Original membership from verified replay; snapshots may retain device evidence only. */
  contentIdentity(deviceIdHex: string) {
    return historicalContentIdentity(this.#internal, deviceIdHex);
  }

  hasRecordHash(digest: Hash): boolean {
    return this.#view.hasRecordHash(checkHash(digest));
  }

  /** Inspection only; installing a candidate still requires durable lifecycle handling. */
  inspectEpochCandidate(candidate: EpochCandidate) {
    return this.#view.inspectEpochCandidate(candidate);
  }

  static async verify(input: {
    anchor: Hash;
    records: readonly Uint8Array[];
    executor?: SignatureVerifyExecutor;
    pointCache?: SigningPointCache;
  }): Promise<Ledger> {
    const anchor = unwrap(genesisHash(input.anchor));
    const records = ownedRecords(input.records, 0);
    return runLegacy(
      verification
        .verifyLedger({ anchor, records })
        .pipe(Effect.map(Ledger.fromView), Effect.provide(verifierLayer(input)))
    );
  }

  async extend(suffix: readonly Uint8Array[], cache?: SigningPointCache): Promise<Ledger> {
    if (suffix.length === 0) return this;
    const records = ownedRecords(suffix, this.length);
    return runLegacy(
      verification
        .extendLedger(this.#working, records)
        .pipe(Effect.map(this.#derive), Effect.provide(legacyVerifierLayer(cache)))
    );
  }

  /** Unchecked proposal: the record is still fully verified when it is appended. */
  prepare(operation: Operation, signerPublicKey: SigningPublicKey): Proposal {
    const signer = unwrap(checkSigningKey(signerPublicKey, this.#lineage.facts));
    const previousHash = this.head;
    const bodyBytes = unwrap(encodeOrdinaryBody({ previousHash, signer, operation }));
    return Object.freeze({
      signer,
      operation,
      previousHash,
      bodyBytes,
      signingBytes: unwrap(signingBytesForBody(bodyBytes)),
    });
  }

  async finalize(
    proposal: Proposal,
    signature: Signature,
    cache?: SigningPointCache
  ): Promise<Uint8Array> {
    const signed = unwrap(signatureBytes(signature));
    return runLegacy(
      verification
        .finalizePrepared(this.#working, proposal.bodyBytes, proposal.previousHash, signed)
        .pipe(
          Effect.map(({ record, view }) => (this.#remember(view), record)),
          Effect.provide(legacyVerifierLayer(cache))
        )
    );
  }

  /** Validate nested proofs and current policy before asking a device to sign.
   * Rejection cannot change this verified view. */
  prepareChecked(
    operation: Operation,
    signerPublicKey: SigningPublicKey,
    cache?: SigningPointCache
  ): Proposal {
    const signer = unwrap(signingPublicKey(signerPublicKey));
    const prepared = runLegacySync(
      verification
        .prepareChecked(this.#working, operation, signer)
        .pipe(Effect.provide(legacyVerifierLayer(cache)))
    );
    return Object.freeze({ signer: signer.toBytes(), operation, ...prepared });
  }

  prepareSnapshot(endorserPublicKey: SigningPublicKey): snapshots.SnapshotProposal {
    const signer = checkSigningPublicKey(endorserPublicKey);
    unwrap(snapshots.assertEndorserEligible(this.#internal, signer));
    const bodyBytes = unwrap(snapshots.encodeSnapshotBody(this.#internal, signer));
    const genesis = this.#view.genesis.toBytes();
    return Object.freeze({
      signer,
      genesis,
      head: this.head,
      length: this.length,
      bodyBytes,
      signingBytes: snapshotSigningBytes(bodyBytes),
      headAttestationSigningBytes: unwrap(headAttestationSigningBytes(genesis, this.head)),
    });
  }

  static async finalizeSnapshot(
    proposal: snapshots.SnapshotProposal,
    signature: Signature,
    cache?: SigningPointCache
  ): Promise<Uint8Array> {
    const signer = checkSigningPublicKey(proposal.signer);
    assertSignature(
      signer,
      proposal.signingBytes,
      checkSignature(signature),
      'bad-signature',
      cache
    );
    return unwrap(snapshots.encodeSignedSnapshot(proposal.bodyBytes, signature));
  }

  static async verifySnapshot(input: {
    trust: snapshots.SnapshotTrust;
    snapshot: Uint8Array;
    suffix?: readonly Uint8Array[];
    pointCache?: SigningPointCache;
  }): Promise<Ledger> {
    const genesis = unwrap(genesisHash(input.trust.genesis));
    const endorser = unwrap(signingPublicKey(input.trust.endorser));
    const head = unwrap(recordHash(input.trust.head));
    const headSignature = unwrap(signatureBytes(input.trust.headSignature));
    const snapshot = ownedRecords([input.snapshot], 0)[0]!;
    const base = await runLegacy(
      verification
        .verifySnapshot({ genesis, endorser, head, headSignature, snapshot })
        .pipe(Effect.map(Ledger.fromView), Effect.provide(legacyVerifierLayer(input.pointCache)))
    );
    return base.extend(input.suffix ?? [], input.pointCache);
  }

  comparisonNote(localDevicePublicKey: SigningPublicKey): snapshots.ComparisonNote {
    const noteSigner = checkSigningPublicKey(localDevicePublicKey);
    return Object.freeze({
      genesis: this.#view.genesis.toBytes(),
      length: this.length,
      head: this.head,
      stateDigest: unwrap(snapshots.stateDigestOf(this.#internal)),
      noteSigner,
    });
  }

  static compareNotes(
    local: snapshots.ComparisonNote,
    remote: snapshots.ComparisonNote,
    opts: {
      originalEndorser: SigningPublicKey;
      confirmedNoteSigners?: readonly SigningPublicKey[];
    }
  ): snapshots.Comparison {
    const confirmed = (opts.confirmedNoteSigners ?? []).map((key) => checkSigningPublicKey(key));
    return snapshots.compareNotes(
      local,
      remote,
      checkSigningPublicKey(opts.originalEndorser),
      confirmed
    );
  }
}
