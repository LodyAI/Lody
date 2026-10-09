import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeCbor, encodeCbor, bytesEqual, type CborValue } from './cbor';
import { epochNumber, genesisHash, signingPublicKey, signature } from './bytes';
import { ValidationError } from './errors';
import { keyId } from './identifiers';
import { concat, hashRecordBytes } from './wire-crypto';
import { decodeRecord } from './ledger-schema';
import type { LedgerView } from './records';

export const mailboxDigest = (bytes: Uint8Array) => keyId(sha256(bytes));
export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
export const isHash = (x: unknown): x is string =>
  typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
export const isBytes = (x: unknown): x is string =>
  typeof x === 'string' && /^(?:[0-9a-f]{2})+$/.test(x) && x.length <= 16384;
const invalid = () => Result.fail(new ValidationError({ code: 'canonical' }));
export interface MailboxSlot {
  readonly genesis: string;
  readonly epoch: number;
  readonly recipient: string;
}
export const slotId = (s: MailboxSlot) => `${s.genesis}:${s.epoch}:${s.recipient}`;
export type InstallationSource =
  | { readonly _tag: 'Envelope'; readonly sender: string; readonly frameDigest: string }
  | { readonly _tag: 'LocalPublication'; readonly recordHash: string };
export interface InstallationContext extends MailboxSlot {
  readonly commitment: string;
  readonly revision: number;
  readonly source: InstallationSource;
}
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
export const installationSigningBytes = (body: Uint8Array) =>
  concat([new TextEncoder().encode('lody-e2ee/key-installed/v1\0'), body]);
export function encodeInstallationReport(c: InstallationContext, signed: Uint8Array) {
  return Result.gen(function* () {
    const body = yield* installationBody(c);
    yield* signature(signed);
    return yield* encodeCbor([body, signed]);
  });
}
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
    if (keyId(digest) !== c.source.recordHash || !view.hasRecordHash(digest))
      return yield* invalid();
    const decoded = yield* decodeRecord(record);
    if (keyId(decoded.body.fields.signer) !== c.recipient) return yield* invalid();
    const b = decoded.body;
    const commitment =
      b.type === 'genesis'
        ? b.fields.epochCommitment
        : b.fields.operation.type === 'publishEpoch' && b.fields.operation.epoch === c.epoch
          ? b.fields.operation.commitment
          : null;
    if (b.type === 'genesis' && (c.epoch !== 0 || !bytesEqual(digest, view.genesis.toBytes())))
      return yield* invalid();
    if (commitment === null || keyId(commitment) !== c.commitment) return yield* invalid();
    return undefined;
  });
}
export function checkInstallationContext(view: LedgerView, c: InstallationContext) {
  const s = view.inspectState();
  return validContext(c) &&
    keyId(s.genesis) === c.genesis &&
    s.epoch.number === c.epoch &&
    keyId(s.epoch.keyCommitment) === c.commitment &&
    s.devices.has(c.recipient)
    ? Result.void
    : Result.fail(new ValidationError({ code: 'unauthorized' }));
}
export type MailboxStatus =
  | 'NeedsEnvelope'
  | 'EnvelopeStored'
  | 'InstallationReported'
  | 'Ineligible'
  | 'Obsolete';
export interface MailboxEntry extends MailboxSlot {
  readonly revision: number;
  readonly envelopes: readonly {
    readonly id: string;
    readonly sender: string;
    readonly digest: string;
    readonly frame: string;
  }[];
  readonly rejected: readonly string[];
  readonly reports: readonly string[];
  readonly reportedRevision: number | null;
  readonly repairs: readonly {
    readonly requestId: string;
    readonly rejectedDigest: string | null;
  }[];
}
export interface MailboxProjection {
  readonly genesis: string;
  readonly head: string;
  readonly length: number;
  readonly epoch: number;
  readonly commitment: string;
  readonly recipients: readonly string[];
}
export interface MailboxDocument {
  readonly version: 1;
  readonly projection: MailboxProjection | null;
  readonly entries: readonly MailboxEntry[];
}
export const emptyMailbox = (): MailboxDocument => ({ version: 1, projection: null, entries: [] });
export function mailboxStatus(doc: MailboxDocument, slot: MailboxSlot): MailboxStatus {
  const p = doc.projection;
  if (!p || p.genesis !== slot.genesis || !p.recipients.includes(slot.recipient))
    return 'Ineligible';
  if (p.epoch !== slot.epoch) return 'Obsolete';
  const row = doc.entries.find((e) => slotId(e) === slotId(slot));
  if (row?.reports.length && row.reportedRevision === row.revision) return 'InstallationReported';
  if (row?.envelopes.some((e) => !row.rejected.includes(e.digest))) return 'EnvelopeStored';
  return 'NeedsEnvelope';
}
/** Rebuild only the derived eligibility projection; accepted ciphertext/reports survive. */
export function projectMailbox(doc: MailboxDocument, view: LedgerView) {
  const state = view.inspectState();
  const old = doc.projection;
  if (
    old &&
    (old.genesis !== keyId(state.genesis) ||
      view.length < old.length ||
      (view.length === old.length && old.head !== keyId(view.head.toBytes())) ||
      !view.hasRecordHash(fromHex(old.head)))
  )
    return Result.fail(new ValidationError({ code: 'wrong-parent' }));
  return Result.succeed({
    ...doc,
    projection: {
      genesis: keyId(state.genesis),
      head: keyId(view.head.toBytes()),
      length: view.length,
      epoch: state.epoch.number,
      commitment: keyId(state.epoch.keyCommitment),
      recipients: [...state.devices.keys()].sort(),
    },
  });
}
export function replaceEntry(doc: MailboxDocument, row: MailboxEntry): MailboxDocument {
  return { ...doc, entries: [...doc.entries.filter((e) => slotId(e) !== slotId(row)), row] };
}
export const newEntry = (slot: MailboxSlot): MailboxEntry => ({
  ...slot,
  revision: 0,
  envelopes: [],
  rejected: [],
  reports: [],
  reportedRevision: null,
  repairs: [],
});
export interface MailboxPage<A> {
  readonly items: readonly A[];
  readonly next: string | null;
}
export function boundedPage<A>(rows: readonly A[], cursor: string | null, limit: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && !/^\d{1,9}$/.test(cursor))
  )
    return invalid();
  const start = cursor === null ? 0 : Number(cursor);
  if (start > rows.length) return invalid();
  return Result.succeed({
    items: rows.slice(start, start + limit),
    next: start + limit < rows.length ? String(start + limit) : null,
  });
}
