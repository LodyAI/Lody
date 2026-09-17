import type { SignatureJob, SignatureVerifyExecutor } from '../capabilities';
import { copyBytes } from './cbor';
import {
  assertSignature,
  bytesEqual,
  checkHash,
  checkSignature,
  checkSigningPublicKey,
  createSequentialSignatureVerify,
  hashRecordBytes,
  headAttestationSigningBytes,
  isTrustedSignatureVerifyExecutor,
  recordSigningBytes,
  sequentialSignatureVerify,
  snapshotSigningBytes,
  type Hash,
  type Signature,
  type SigningPointCache,
  type SigningPublicKey,
} from './crypto';
import { LedgerError, fail } from './error';
import {
  applyGenesis,
  applyOperation,
  cloneState,
  publicState,
  verifyOperationProofs,
  type InternalState,
  type OrgState,
} from './policy';
import {
  decodeRecord,
  encodeOrdinaryBody,
  encodeSignedRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  type DecodedRecord,
  type Operation,
} from './schema';
import {
  assertEndorserEligible,
  compareNotes,
  decodeSignedSnapshot,
  encodeSignedSnapshot,
  encodeSnapshotBody,
  stateDigestOf,
  type Comparison,
  type ComparisonNote,
  type SnapshotProposal,
  type SnapshotTrust,
} from './snapshot';

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

export type { Comparison, ComparisonNote, SnapshotProposal, SnapshotTrust };

function withPosition(position: number, run: () => void): void {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof LedgerError && error.position === undefined) {
      throw new LedgerError(error.code, position);
    }
    throw error;
  }
}

function collectProofJobs(genesis: Hash, decoded: DecodedRecord): SignatureJob[] {
  if (decoded.body.type !== 'ordinary') return [];
  const op = decoded.body.fields.operation;
  if (op.type === 'admitMember') {
    return [
      {
        pk: op.request.signingPublicKey,
        msg: joinRequestSigningBytes(genesis, op.request),
        sig: op.request.signature,
      },
    ];
  }
  if (op.type === 'admitDevice') {
    return [
      {
        pk: op.signingPublicKey,
        msg: possessionSigningBytes({
          genesis,
          signingPublicKey: op.signingPublicKey,
          encryptionPublicKey: op.encryptionPublicKey,
          kind: op.kind,
          canManage: op.canManage,
        }),
        sig: op.possessionSignature,
      },
    ];
  }
  return [];
}

function applyDecoded(
  state: InternalState | undefined,
  decoded: DecodedRecord,
  recordHash: Hash,
  position: number,
  expectedAnchor?: Hash,
  proofsChecked = false,
  cache?: SigningPointCache
): InternalState {
  if (decoded.body.type === 'genesis') {
    if (position !== 0) fail('genesis-mismatch', position);
    if (expectedAnchor && !bytesEqual(recordHash, expectedAnchor)) fail('wrong-anchor', position);
    if (state) fail('genesis-mismatch', position);
    return applyGenesis(decoded.body.fields, recordHash, cache);
  }
  if (!state) fail('genesis-mismatch', position);
  if (position === 0) fail('genesis-mismatch', position);
  if (decoded.body.type !== 'ordinary') fail('genesis-mismatch', position);
  const ordinary = decoded.body.fields;
  if (!bytesEqual(ordinary.previousHash, state.hashes[state.hashes.length - 1]!)) {
    fail('wrong-parent', position);
  }
  withPosition(position, () => {
    if (!proofsChecked) verifyOperationProofs(state.genesis, ordinary.operation, cache);
    applyOperation(state, ordinary.signer, ordinary.operation, cache);
  });
  state.hashes.push(recordHash);
  return state;
}

function applyRecord(
  state: InternalState | undefined,
  recordBytes: Uint8Array,
  position: number,
  expectedAnchor?: Hash,
  cache?: SigningPointCache
): InternalState {
  const record = decodeRecord(recordBytes, cache);
  withPosition(position, () => {
    assertSignature(
      record.body.fields.signer,
      recordSigningBytes(record.bodyBytes),
      record.signature,
      'bad-signature',
      cache
    );
  });
  const recordHash = hashRecordBytes(record.recordBytes);
  return applyDecoded(state, record, recordHash, position, expectedAnchor, false, cache);
}

async function verifyJobs(
  jobs: SignatureJob[],
  positions: number[],
  codes: Array<'bad-signature' | 'bad-proof'>,
  executor: SignatureVerifyExecutor
): Promise<void> {
  if (jobs.length === 0) return;
  const results = await executor.verify(jobs);
  if (!Array.isArray(results) || results.length !== jobs.length) fail('invalid-operation');
  for (let i = 0; i < jobs.length; i++) {
    if (results[i] !== true) fail(codes[i]!, positions[i]);
  }
}

export class Ledger {
  private constructor(private readonly internal: InternalState) {
    Object.freeze(this);
  }

  get head(): Hash {
    const head = this.internal.hashes[this.internal.hashes.length - 1];
    if (!head) fail('invalid-operation');
    return copyBytes(head);
  }

  get length(): number {
    return this.internal.hashes.length;
  }

  get origin(): 'genesis' | 'snapshot' {
    return this.internal.origin;
  }

  get snapshotLength(): number | null {
    return this.internal.snapshotLength;
  }

  historyPackets(): ReadonlyMap<number, { commitment: Hash; packet: Uint8Array }> {
    const packets = new Map<number, { commitment: Hash; packet: Uint8Array }>();
    for (const [epoch, row] of this.internal.historyPackets) {
      packets.set(epoch, {
        commitment: copyBytes(row.commitment),
        packet: copyBytes(row.packet),
      });
    }
    return packets;
  }

  get state(): OrgState {
    return publicState(this.internal);
  }

  summary(): LedgerSummary {
    return Object.freeze({
      genesis: copyBytes(this.internal.genesis),
      length: this.length,
      head: this.head,
    });
  }

  hashAt(position: number): Hash {
    if (!Number.isSafeInteger(position) || position < 0 || position >= this.length) {
      fail('invalid-operation');
    }
    const hash = this.internal.hashes[position];
    if (!hash) fail('invalid-operation');
    return copyBytes(hash);
  }

  hasRecordHash(digest: Hash): boolean {
    const want = checkHash(digest);
    for (const hash of this.internal.hashes) {
      if (hash && bytesEqual(hash, want)) return true;
    }
    return false;
  }

  static async verify(input: {
    anchor: Hash;
    records: readonly Uint8Array[];
    executor?: SignatureVerifyExecutor;
    pointCache?: SigningPointCache;
  }): Promise<Ledger> {
    const anchor = checkHash(input.anchor);
    if (input.records.length === 0) fail('genesis-mismatch', 0);
    if (input.executor && !isTrustedSignatureVerifyExecutor(input.executor)) {
      fail('invalid-operation');
    }
    const executor =
      input.executor ??
      (input.pointCache
        ? createSequentialSignatureVerify(input.pointCache)
        : sequentialSignatureVerify);
    const records = input.records.map((record, position) => {
      if (!(record instanceof Uint8Array)) fail('canonical', position);
      return copyBytes(record);
    });
    const decoded: DecodedRecord[] = [];
    const hashes: Hash[] = [];
    const outerJobs: SignatureJob[] = [];
    const outerPos: number[] = [];
    const outerCodes: Array<'bad-signature' | 'bad-proof'> = [];
    for (let position = 0; position < records.length; position++) {
      try {
        const record = decodeRecord(records[position]!, input.pointCache);
        decoded.push(record);
        hashes.push(hashRecordBytes(record.recordBytes));
        outerJobs.push({
          pk: record.body.fields.signer,
          msg: recordSigningBytes(record.bodyBytes),
          sig: record.signature,
        });
        outerPos.push(position);
        outerCodes.push('bad-signature');
      } catch (error: unknown) {
        if (error instanceof LedgerError && error.position === undefined) {
          throw new LedgerError(error.code, position);
        }
        throw error;
      }
    }
    await verifyJobs(outerJobs, outerPos, outerCodes, executor);
    const genesisHash = hashes[0]!;
    const proofJobs: SignatureJob[] = [];
    const proofPos: number[] = [];
    const proofCodes: Array<'bad-signature' | 'bad-proof'> = [];
    for (let position = 1; position < decoded.length; position++) {
      const extra = collectProofJobs(genesisHash, decoded[position]!);
      for (const job of extra) {
        proofJobs.push(job);
        proofPos.push(position);
        proofCodes.push('bad-proof');
      }
    }
    await verifyJobs(proofJobs, proofPos, proofCodes, executor);
    let state: InternalState | undefined;
    for (let position = 0; position < decoded.length; position++) {
      state = applyDecoded(
        state,
        decoded[position]!,
        hashes[position]!,
        position,
        position === 0 ? anchor : undefined,
        true,
        input.pointCache
      );
    }
    if (!state) fail('genesis-mismatch', 0);
    if (!bytesEqual(state.genesis, anchor) || !bytesEqual(state.hashes[0]!, anchor)) {
      fail('wrong-anchor', 0);
    }
    return new Ledger(state);
  }

  async extend(suffix: readonly Uint8Array[], cache?: SigningPointCache): Promise<Ledger> {
    if (suffix.length === 0) return this;
    const next = cloneState(this.internal);
    const records = suffix.map((record, offset) => {
      if (!(record instanceof Uint8Array)) fail('canonical', this.length + offset);
      return copyBytes(record);
    });
    for (let offset = 0; offset < records.length; offset++) {
      applyRecord(next, records[offset]!, this.length + offset, undefined, cache);
    }
    return new Ledger(next);
  }

  prepare(
    operation: Operation,
    signerPublicKey: SigningPublicKey,
    cache?: SigningPointCache
  ): Proposal {
    const signer = checkSigningPublicKey(signerPublicKey, cache);
    const bodyBytes = encodeOrdinaryBody(
      {
        previousHash: this.head,
        signer,
        operation,
      },
      cache
    );
    return Object.freeze({
      signer,
      operation,
      previousHash: this.head,
      bodyBytes,
      signingBytes: signingBytesForBody(bodyBytes),
    });
  }

  async finalize(
    proposal: Proposal,
    signature: Signature,
    cache?: SigningPointCache
  ): Promise<Uint8Array> {
    if (!bytesEqual(proposal.previousHash, this.head)) fail('wrong-parent');
    const recordBytes = encodeSignedRecord(proposal.bodyBytes, signature);
    await this.extend([recordBytes], cache);
    return recordBytes;
  }

  prepareSnapshot(
    endorserPublicKey: SigningPublicKey,
    cache?: SigningPointCache
  ): SnapshotProposal {
    const signer = checkSigningPublicKey(endorserPublicKey, cache);
    assertEndorserEligible(this.internal, signer);
    const bodyBytes = encodeSnapshotBody(this.internal, signer);
    return Object.freeze({
      signer,
      genesis: copyBytes(this.internal.genesis),
      head: this.head,
      length: this.length,
      bodyBytes,
      signingBytes: snapshotSigningBytes(bodyBytes),
      headAttestationSigningBytes: headAttestationSigningBytes(this.internal.genesis, this.head),
    });
  }

  static async finalizeSnapshot(
    proposal: SnapshotProposal,
    signature: Signature,
    cache?: SigningPointCache
  ): Promise<Uint8Array> {
    checkSigningPublicKey(proposal.signer, cache);
    assertSignature(
      proposal.signer,
      proposal.signingBytes,
      checkSignature(signature),
      'bad-signature',
      cache
    );
    return encodeSignedSnapshot(proposal.bodyBytes, signature);
  }

  static async verifySnapshot(input: {
    trust: SnapshotTrust;
    snapshot: Uint8Array;
    suffix?: readonly Uint8Array[];
    pointCache?: SigningPointCache;
  }): Promise<Ledger> {
    const genesis = checkHash(input.trust.genesis);
    const endorser = checkSigningPublicKey(input.trust.endorser, input.pointCache);
    const attestedHead = checkHash(input.trust.head);
    const headSignature = checkSignature(input.trust.headSignature);
    if (!(input.snapshot instanceof Uint8Array)) fail('canonical');
    assertSignature(
      endorser,
      headAttestationSigningBytes(genesis, attestedHead),
      headSignature,
      'bad-signature',
      input.pointCache
    );
    const decoded = decodeSignedSnapshot(copyBytes(input.snapshot), input.pointCache);
    if (!bytesEqual(decoded.genesis, genesis)) fail('wrong-anchor');
    if (!bytesEqual(decoded.signer, endorser)) fail('wrong-anchor');
    if (!bytesEqual(decoded.head, attestedHead)) fail('wrong-anchor');
    assertSignature(
      decoded.signer,
      snapshotSigningBytes(decoded.bodyBytes),
      decoded.signature,
      'bad-signature',
      input.pointCache
    );
    const ledger = new Ledger(decoded.state);
    const suffix = input.suffix ?? [];
    if (suffix.length === 0) return ledger;
    return ledger.extend(suffix, input.pointCache);
  }

  comparisonNote(
    localDevicePublicKey: SigningPublicKey,
    cache?: SigningPointCache
  ): ComparisonNote {
    const noteSigner = checkSigningPublicKey(localDevicePublicKey, cache);
    return Object.freeze({
      genesis: copyBytes(this.internal.genesis),
      length: this.length,
      head: this.head,
      stateDigest: stateDigestOf(this.internal),
      noteSigner,
    });
  }

  static compareNotes(
    local: ComparisonNote,
    remote: ComparisonNote,
    opts: { originalEndorser: SigningPublicKey; pointCache?: SigningPointCache }
  ): Comparison {
    return compareNotes(
      local,
      remote,
      checkSigningPublicKey(opts.originalEndorser, opts.pointCache)
    );
  }
}
