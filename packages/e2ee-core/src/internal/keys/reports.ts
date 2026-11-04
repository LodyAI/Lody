import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeCbor, encodeCbor, bytesEqual, type CborValue } from '../foundation/cbor';
import { epochNumber, genesisHash, signingPublicKey, signature } from '../foundation/bytes';
import { ContentError, ValidationError } from '../foundation/errors';
import { keyId } from '../foundation/identifiers';
import { concat } from '../foundation/concat';
import {
  hashRecordBytes,
  decodeRecord,
  hasVerifiedRecordHash,
  epochHistoryPacket,
  type LedgerView,
} from '../ledger';
import { verifySignature } from '../foundation/signature';

/** SHA-256 hex digest used to name envelope frames and reports. */
export const mailboxDigest = (bytes: Uint8Array) => keyId(sha256(bytes));
export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
export const isHash = (x: unknown): x is string =>
  typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
export const isBytes = (x: unknown): x is string =>
  typeof x === 'string' && /^(?:[0-9a-f]{2})+$/.test(x) && x.length <= 16384;
const invalid = () => Result.fail(new ValidationError({ code: 'canonical' }));
/** One mailbox slot: the envelope for (workspace genesis, epoch, recipient device), ids in hex. */
export interface MailboxSlot {
  readonly genesis: string;
  readonly epoch: number;
  readonly recipient: string;
}
/** Stable string key of a mailbox slot. */
export const slotId = (s: MailboxSlot) => `${s.genesis}:${s.epoch}:${s.recipient}`;
/** Where an installed key came from: a received envelope (sender and frame digest) or this device's own publication record. */
export type InstallationSource =
  | { readonly _tag: 'Envelope'; readonly sender: string; readonly frameDigest: string }
  | { readonly _tag: 'LocalPublication'; readonly recordHash: string };
/** Everything an installation report claims: slot, epoch commitment, mailbox revision and source. */
export interface InstallationContext extends MailboxSlot {
  readonly commitment: string;
  readonly revision: number;
  readonly source: InstallationSource;
}
/** Structural check of a mailbox slot (hex ids, valid epoch number). */
export const validSlot = (s: MailboxSlot) =>
  isHash(s.genesis) && isHash(s.recipient) && Result.isSuccess(epochNumber(s.epoch));
export const validContext = (c: InstallationContext) =>
  validSlot(c) &&
  isHash(c.commitment) &&
  Number.isSafeInteger(c.revision) &&
  c.revision >= 0 &&
  (c.source?._tag === 'Envelope'
    ? isHash(c.source.sender) && isHash(c.source.frameDigest)
    : c.source?._tag === 'LocalPublication' && isHash(c.source.recordHash));

/** Canonical CBOR body of an installation report for a context. */
export function installationBody(c: InstallationContext) {
  if (!validContext(c)) return invalid();
  const source: CborValue =
    c.source._tag === 'Envelope'
      ? [0, fromHex(c.source.sender), fromHex(c.source.frameDigest)]
      : [1, fromHex(c.source.recordHash)];
  return encodeCbor([
    1,
    fromHex(c.genesis),
    c.epoch,
    fromHex(c.recipient),
    fromHex(c.commitment),
    source,
    c.revision,
  ]);
}
/** Exact bytes a recipient signs for an installation report body. */
export const installationSigningBytes = (body: Uint8Array) =>
  concat([new TextEncoder().encode('lody-e2ee/key-installed/v1\0'), body]);
/** Encode a signed installation report (body and signature). */
export function encodeInstallationReport(c: InstallationContext, signed: Uint8Array) {
  return Result.gen(function* () {
    const body = yield* installationBody(c);
    yield* signature(signed);
    return yield* encodeCbor([body, signed]);
  });
}
/** Decode an installation report into its claimed context, signed message and signature, without verifying it. */
export function decodeInstallationReport(bytes: Uint8Array) {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(bytes);
    if (!Array.isArray(outer) || outer.length !== 2 || !(outer[0] instanceof Uint8Array))
      return yield* invalid();
    const signed = yield* signature(outer[1]);
    const b = yield* decodeCbor(outer[0]);
    if (!Array.isArray(b) || b.length !== 7 || b[0] !== 1 || !Array.isArray(b[5]))
      return yield* invalid();
    const genesis = yield* genesisHash(b[1]);
    const epoch = yield* epochNumber(b[2]);
    const recipient = yield* signingPublicKey(b[3]);
    const commitment = yield* genesisHash(b[4]);
    const p = b[5];
    let source: InstallationSource;
    if (p[0] === 0 && p.length === 3) {
      const sender = yield* signingPublicKey(p[1]);
      const digest = yield* genesisHash(p[2]);
      source = {
        _tag: 'Envelope',
        sender: keyId(sender.toBytes()),
        frameDigest: keyId(digest.toBytes()),
      };
    } else if (p[0] === 1 && p.length === 2) {
      const hash = yield* genesisHash(p[1]);
      source = { _tag: 'LocalPublication', recordHash: keyId(hash.toBytes()) };
    } else return yield* invalid();
    if (typeof b[6] !== 'number' || !Number.isSafeInteger(b[6]) || b[6] < 0)
      return yield* invalid();
    return {
      context: {
        genesis: keyId(genesis.toBytes()),
        epoch,
        recipient: keyId(recipient.toBytes()),
        commitment: keyId(commitment.toBytes()),
        source,
        revision: b[6],
      } as InstallationContext,
      recipient,
      signature: signed,
      message: installationSigningBytes(outer[0]),
    };
  });
}
/** Routing metadata only, never signature/authorization evidence. Wire remains unchanged. */
export function envelopeRouting(frame: Uint8Array) {
  return Result.gen(function* () {
    const a = yield* decodeCbor(frame.subarray(0, -144));
    if (!Array.isArray(a) || a.length !== 4) return yield* invalid();
    const genesis = yield* genesisHash(a[0]);
    const epoch = yield* epochNumber(a[1]);
    const sender = yield* signingPublicKey(a[2]);
    const recipient = yield* signingPublicKey(a[3]);
    return {
      genesis: keyId(genesis.toBytes()),
      epoch,
      sender: keyId(sender.toBytes()),
      recipient: keyId(recipient.toBytes()),
    };
  });
}
/** Exact verified record, not merely a hash present somewhere in the ledger. */
export function checkLocalPublication(
  view: LedgerView,
  c: InstallationContext,
  record: Uint8Array
) {
  return Result.gen(function* () {
    if (c.source._tag !== 'LocalPublication' || !validContext(c)) return yield* invalid();
    const digest = hashRecordBytes(record);
    if (
      keyId(digest.toBytes()) !== c.source.recordHash ||
      !(yield* Result.mapError(
        hasVerifiedRecordHash(view, digest),
        () => new ContentError({ code: 'unauthorized' })
      ))
    )
      return yield* invalid();
    const decoded = yield* decodeRecord(record);
    if (keyId(decoded.body.signer.toBytes()) !== c.recipient) return yield* invalid();
    const b = decoded.body;
    const commitment =
      b.type === 'genesis'
        ? b.epochCommitment.toBytes()
        : (b.operation.type === 'publishEpoch' ||
              b.operation.type === 'removeMemberAndPublishEpoch') &&
            b.operation.epoch === c.epoch
          ? b.operation.commitment.toBytes()
          : null;
    if (
      b.type === 'genesis' &&
      (c.epoch !== 0 || !bytesEqual(digest.toBytes(), view.genesis.toBytes()))
    )
      return yield* invalid();
    if (commitment === null || keyId(commitment) !== c.commitment) return yield* invalid();
    return undefined;
  });
}
/** Check that a claimed installation context matches a genuine ledger view (current epoch, commitment and eligible recipient). */
export function checkInstallationContext(view: LedgerView, c: InstallationContext) {
  return Result.gen(function* () {
    // Query authenticates runtime view provenance before any projected state is used.
    yield* Result.mapError(
      epochHistoryPacket(view, 0),
      () => new ContentError({ code: 'unauthorized' })
    );
    const state = view.inspectState();
    if (
      !validContext(c) ||
      keyId(view.genesis.toBytes()) !== c.genesis ||
      state.epoch.number !== c.epoch ||
      keyId(state.epoch.keyCommitment.toBytes()) !== c.commitment ||
      !state.devices.has(c.recipient)
    )
      return yield* Result.fail(new ContentError({ code: 'unauthorized' }));
    return undefined;
  });
}
/** A signed recipient claim, not evidence that a key is durable or the server stored its source. */
export function authenticateInstallationReport(input: {
  readonly view: LedgerView;
  readonly genesis: import('../foundation/bytes').GenesisHash;
  readonly authenticatedRecipient: import('../foundation/bytes').SigningPublicKey;
  readonly report: Uint8Array;
}) {
  return Result.gen(function* () {
    if (!(input.report instanceof Uint8Array) || input.report.length > 512)
      return yield* Result.fail(new ValidationError({ code: 'oversize' }));
    const parsed = yield* decodeInstallationReport(input.report);
    yield* checkInstallationContext(input.view, parsed.context);
    const expected = yield* signingPublicKey(input.authenticatedRecipient.toBytes());
    const anchor = yield* genesisHash(input.genesis.toBytes());
    if (!parsed.recipient.equals(expected) || parsed.context.genesis !== keyId(anchor.toBytes()))
      return yield* Result.fail(new ContentError({ code: 'unauthorized' }));
    yield* verifySignature(expected.toBytes(), parsed.message, parsed.signature.toBytes());
    return parsed.context;
  });
}
