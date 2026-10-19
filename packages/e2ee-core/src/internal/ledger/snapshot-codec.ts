import { Chunk, HashMap, HashSet, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../foundation/bytes';
import { concat } from '../foundation/concat';
import {
  bytesEqual,
  copyBytes,
  decodeSnapshotCbor,
  encodeSnapshotCbor,
  type CborValue,
} from '../foundation/cbor';
import { keyId } from '../foundation/identifiers';
import { verifySignature } from '../foundation/signature';
import { LedgerError } from './errors';
import { fail, type DeviceKind, type Role } from './records';
import {
  hashAt,
  stateGet,
  type InternalState,
  type Member,
  type Device,
  type EpochHistoryPacket,
} from './policy';

const domain = (name: string) => new TextEncoder().encode(`lody-e2ee/${name}\0`);
const lift = <A>(r: Result.Result<A, { readonly code: LedgerError['code'] }>) =>
  Result.mapError(r, (e) => new LedgerError({ code: e.code }));
const array = (v: CborValue | undefined): Result.Result<readonly CborValue[], LedgerError> =>
  Array.isArray(v) ? Result.succeed(v) : fail('canonical');
const uint = (v: CborValue | undefined): Result.Result<number, LedgerError> =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ? Result.succeed(v)
    : fail('canonical');
const exact = (v: CborValue | undefined, n: number): Result.Result<Uint8Array, LedgerError> =>
  v instanceof Uint8Array && v.length === n ? Result.succeed(v) : fail('canonical');
const cmp = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const n = a[i]! - b[i]!;
    if (n) return n;
  }
  return a.length - b.length;
};
const id = (v: { toBytes(): Uint8Array }) => keyId(v.toBytes());
const raw = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => Number.parseInt(x, 16)));
const roles: readonly Role[] = ['owner', 'admin', 'member', 'guest'];
const kinds: readonly DeviceKind[] = ['personal', 'machine', 'recovery'];
const sortedKeys = (s: Iterable<string>) => [...s].map(raw).sort(cmp);

/** Independent authenticated contact and expected position; never obtained from the snapshot/journal itself. */
export interface SnapshotIdentityPin {
  readonly genesis: Bytes.GenesisHash;
  readonly endorser: Bytes.SigningPublicKey;
  readonly head: Bytes.RecordHash;
  readonly length: number;
  readonly headSignature: Bytes.Signature;
}
/** Externally confirmed qualification of a snapshot endorser (identity, position, role and kind). */
export interface SnapshotTrust extends SnapshotIdentityPin {
  readonly source: 'external-confirmation';
  readonly membershipId: Bytes.MembershipId;
  readonly role: 'owner' | 'admin';
  readonly kind: 'personal';
  /** Optional additional pin of externally confirmed complete state, not a substitute for role facts. */
  readonly stateDigest?: Bytes.RecordHash;
}
function safely<A>(work: () => Result.Result<A, LedgerError>): Result.Result<A, LedgerError> {
  return Result.try({
    try: () => Result.getOrThrow(work()),
    catch: (error) =>
      error instanceof LedgerError ? error : new LedgerError({ code: 'canonical' }),
  });
}
function ownedPin(pin: SnapshotIdentityPin) {
  return safely(() =>
    Result.gen(function* () {
      const length = pin.length;
      if (!Number.isSafeInteger(length) || length < 1) return yield* fail('oversize');
      return Object.freeze({
        genesis: yield* lift(Bytes.genesisHash(pin.genesis.toBytes())),
        endorser: yield* lift(Bytes.signingPublicKey(pin.endorser.toBytes())),
        head: yield* lift(Bytes.recordHash(pin.head.toBytes())),
        length,
        headSignature: yield* lift(Bytes.signature(pin.headSignature.toBytes())),
      });
    })
  );
}
/** Bytes a manager signs to endorse a snapshot: body, snapshot signing bytes and head attestation. */
export interface SnapshotProposal {
  readonly bodyBytes: Uint8Array;
  readonly signingBytes: Uint8Array;
  readonly headAttestationSigningBytes: Uint8Array;
}
/** Out-of-band comparison tuple: workspace, head, length, state digest and the note's signer. */
export interface ComparisonNote {
  readonly genesis: Bytes.GenesisHash;
  readonly head: Bytes.RecordHash;
  readonly length: number;
  readonly stateDigest: Bytes.RecordHash;
  readonly noteSigner: Bytes.SigningPublicKey;
}
/** Result of comparing two notes: same, conflict, pending sync or different workspace. */
export type Comparison =
  | { readonly kind: 'different-org' }
  | { readonly kind: 'pending-sync'; readonly localLength: number; readonly remoteLength: number }
  | {
      readonly kind: 'conflict';
      readonly length: number;
      readonly localDigest: Bytes.RecordHash;
      readonly remoteDigest: Bytes.RecordHash;
    }
  | {
      readonly kind: 'agree';
      readonly length: number;
      readonly stateDigest: Bytes.RecordHash;
      readonly independent: boolean;
      readonly confirmationSource?: 'manual' | 'authenticated-channel';
    };
/** Exact bytes an endorser signs for a snapshot body. */
export const snapshotSigningBytes = (body: Uint8Array) => concat([domain('snapshot/v1'), body]);
/** Exact bytes an endorser signs to attest a head. */
export const headAttestationSigningBytes = (genesis: Bytes.GenesisHash, head: Bytes.RecordHash) =>
  concat([domain('head-attest/v1'), genesis.toBytes(), head.toBytes()]);
function authState(s: InternalState): CborValue {
  const members = [...s.members]
    .sort(([a], [b]) => cmp(raw(a), raw(b)))
    .map(([key, row]) => [raw(key), row.userId.toBytes(), roles.indexOf(row.role)]);
  const devices = [...s.devices]
    .sort(([a], [b]) => cmp(raw(a), raw(b)))
    .map(([key, row]) => [
      raw(key),
      row.membershipId.toBytes(),
      kinds.indexOf(row.kind),
      row.encryptionPublicKey.toBytes(),
    ]);
  const closed = [...s.closedJoins]
    .map((key) => key.split(':').map(raw))
    .sort((a, b) => cmp(a[0]!, b[0]!) || cmp(a[1]!, b[1]!));
  const history = [...s.historyPackets]
    .sort(([a], [b]) => a - b)
    .map(([epoch, row]) => [epoch, row.commitment.toBytes(), copyBytes(row.packet)]);
  return [
    s.owner.toBytes(),
    members,
    devices,
    s.epoch.number,
    s.epoch.keyCommitment.toBytes(),
    s.epoch.rotationRequired,
    sortedKeys(s.usedSigningKeys),
    sortedKeys(s.usedEncKeys),
    sortedKeys(s.usedMembershipIds),
    closed,
    history,
  ];
}
function eligible(s: InternalState, signer: Bytes.SigningPublicKey) {
  const device = stateGet(s.devices, id(signer));
  const member = device && stateGet(s.members, id(device.membershipId));
  return device?.kind === 'personal' && (member?.role === 'owner' || member?.role === 'admin');
}
export function proposalOf(
  s: InternalState,
  signer: Bytes.SigningPublicKey
): Result.Result<SnapshotProposal, LedgerError> {
  return Result.gen(function* () {
    if (!eligible(s, signer)) return yield* fail('unauthorized');
    const head = hashAt(s, s.hashes.length - 1)!;
    const bodyBytes = yield* lift(
      encodeSnapshotCbor([
        1,
        s.genesis.toBytes(),
        s.hashesOffset + s.hashes.length,
        head.toBytes(),
        signer.toBytes(),
        authState(s),
      ])
    );
    return {
      bodyBytes,
      signingBytes: snapshotSigningBytes(bodyBytes),
      headAttestationSigningBytes: headAttestationSigningBytes(s.genesis, head),
    };
  });
}
export function noteOf(
  s: InternalState,
  signer: Bytes.SigningPublicKey
): Result.Result<ComparisonNote, LedgerError> {
  return Result.gen(function* () {
    const device = stateGet(s.devices, id(signer));
    if (!device || device.kind !== 'personal') return yield* fail('unauthorized');
    const head = hashAt(s, s.hashes.length - 1)!;
    const body = yield* lift(
      encodeSnapshotCbor([
        1,
        s.genesis.toBytes(),
        s.hashesOffset + s.hashes.length,
        head.toBytes(),
        authState(s),
      ])
    );
    const stateDigest = yield* lift(
      Bytes.recordHash(sha256(concat([domain('snapshot-digest/v1'), body])))
    );
    return Object.freeze({
      genesis: s.genesis,
      head,
      length: s.hashesOffset + s.hashes.length,
      stateDigest,
      noteSigner: signer,
    });
  });
}
/** Packaging bytes does not establish endorsement or author authority. */
export function encodeSignedSnapshot(
  bodyBytes: Uint8Array,
  signature: Bytes.Signature
): Result.Result<Uint8Array, LedgerError> {
  return Result.gen(function* () {
    const body = yield* lift(decodeSnapshotCbor(bodyBytes));
    const sig = yield* lift(Bytes.signature(signature.toBytes()));
    return yield* lift(encodeSnapshotCbor([body, sig.toBytes()]));
  });
}
function keySet(v: CborValue | undefined, size: number): Result.Result<Set<string>, LedgerError> {
  return Result.gen(function* () {
    const result = new Set<string>();
    let last: Uint8Array | undefined;
    for (const item of yield* array(v)) {
      const key = yield* exact(item, size);
      if (last && cmp(last, key) >= 0) return yield* fail('canonical');
      last = key;
      result.add(keyId(key));
    }
    return result;
  });
}
/** Internal parser only. Authority creation is performed by replay's module-private view factory. */
function claimedSnapshotState(
  inputBytes: Uint8Array,
  trust: SnapshotIdentityPin
): Result.Result<InternalState, LedgerError> {
  return Result.gen(function* () {
    // Snapshot/journal metadata cannot replace this independently supplied anchor/contact/position.
    const genesis = yield* lift(Bytes.genesisHash(trust.genesis.toBytes()));
    const signer = yield* lift(Bytes.signingPublicKey(trust.endorser.toBytes()));
    const head = yield* lift(Bytes.recordHash(trust.head.toBytes()));
    const headSig = yield* lift(Bytes.signature(trust.headSignature.toBytes()));
    if (
      !Number.isSafeInteger(trust.length) ||
      trust.length < 1 ||
      trust.length > Number.MAX_SAFE_INTEGER
    )
      return yield* fail('oversize');
    const root = yield* array(yield* lift(decodeSnapshotCbor(inputBytes)));
    if (root.length !== 2) return yield* fail('canonical');
    const body = yield* array(root[0]);
    if (body.length !== 6) return yield* fail('canonical');
    if ((yield* uint(body[0])) !== 1) return yield* fail('unknown-version');
    if (!bytesEqual(yield* exact(body[1], 32), genesis.toBytes()))
      return yield* fail('wrong-anchor');
    if (
      (yield* uint(body[2])) !== trust.length ||
      !bytesEqual(yield* exact(body[3], 32), head.toBytes())
    )
      return yield* fail('checkpoint-mismatch');
    if (!bytesEqual(yield* exact(body[4], 32), signer.toBytes()))
      return yield* fail('unauthorized');
    const sig = yield* exact(root[1], 64);
    const bodyBytes = yield* lift(encodeSnapshotCbor(body));
    yield* lift(
      verifySignature(
        signer.toBytes(),
        headAttestationSigningBytes(genesis, head),
        headSig.toBytes()
      )
    );
    yield* lift(verifySignature(signer.toBytes(), snapshotSigningBytes(bodyBytes), sig));
    const fields = yield* array(body[5]);
    if (fields.length !== 11) return yield* fail('canonical');
    const owner = yield* lift(Bytes.membershipId(yield* exact(fields[0], 16)));
    const members = new Map<string, Member>();
    const users = new Set<string>();
    let last: Uint8Array | undefined;
    let owners = 0;
    for (const item of yield* array(fields[1])) {
      const row = yield* array(item);
      if (row.length !== 3) return yield* fail('canonical');
      const key = yield* lift(Bytes.membershipId(yield* exact(row[0], 16)));
      const bytes = key.toBytes();
      if (last && cmp(last, bytes) >= 0) return yield* fail('canonical');
      last = bytes;
      const userId = yield* lift(Bytes.userId(yield* exact(row[1], 32)));
      const role = roles[yield* uint(row[2])];
      if (!role) return yield* fail('canonical');
      if (users.has(id(userId))) return yield* fail('replay');
      users.add(id(userId));
      members.set(id(key), Object.freeze({ userId, role }));
      if (role === 'owner') owners++;
    }
    if (owners !== 1 || members.get(id(owner))?.role !== 'owner') return yield* fail('canonical');
    const devices = new Map<string, Device>();
    const encryptionKeys = new Set<string>();
    last = undefined;
    for (const item of yield* array(fields[2])) {
      const row = yield* array(item);
      if (row.length !== 4) return yield* fail('canonical');
      const key = yield* lift(Bytes.signingPublicKey(yield* exact(row[0], 32)));
      const bytes = key.toBytes();
      if (last && cmp(last, bytes) >= 0) return yield* fail('canonical');
      last = bytes;
      const membershipId = yield* lift(Bytes.membershipId(yield* exact(row[1], 16)));
      const kind = kinds[yield* uint(row[2])];
      if (!kind || !members.has(id(membershipId))) return yield* fail('canonical');
      const encryptionPublicKey = yield* lift(Bytes.encryptionPublicKey(yield* exact(row[3], 32)));
      if (encryptionKeys.has(id(encryptionPublicKey))) return yield* fail('replay');
      encryptionKeys.add(id(encryptionPublicKey));
      devices.set(id(key), Object.freeze({ membershipId, kind, encryptionPublicKey }));
    }
    // A signed endorsement cannot make structurally unreachable Owner custody valid.
    if (
      ![...devices.values()].some((d) => id(d.membershipId) === id(owner) && d.kind !== 'machine')
    )
      return yield* fail('unauthorized');
    const number = yield* uint(fields[3]);
    if (number > 0xffffffff) return yield* fail('canonical');
    const keyCommitment = yield* lift(Bytes.epochCommitment(yield* exact(fields[4], 32)));
    const rotationRequired = fields[5];
    if (typeof rotationRequired !== 'boolean') return yield* fail('canonical');
    const usedSigningKeys = yield* keySet(fields[6], 32);
    const usedEncKeys = yield* keySet(fields[7], 32);
    const usedMembershipIds = yield* keySet(fields[8], 16);
    for (const key of usedSigningKeys) yield* lift(Bytes.signingPublicKey(raw(key)));
    for (const key of usedEncKeys) yield* lift(Bytes.encryptionPublicKey(raw(key)));
    for (const [key, d] of devices)
      if (
        !usedSigningKeys.has(key) ||
        !usedEncKeys.has(id(d.encryptionPublicKey)) ||
        !usedMembershipIds.has(id(d.membershipId))
      )
        return yield* fail('canonical');
    for (const key of members.keys())
      if (!usedMembershipIds.has(key)) return yield* fail('canonical');
    const closedJoins = new Set<string>();
    let lastJoin: Uint8Array | undefined;
    for (const item of yield* array(fields[9])) {
      const row = yield* array(item);
      if (row.length !== 2) return yield* fail('canonical');
      const key = yield* lift(Bytes.signingPublicKey(yield* exact(row[0], 32)));
      const request = yield* exact(row[1], 16);
      const joined = concat([key.toBytes(), request]);
      if (lastJoin && cmp(lastJoin, joined) >= 0) return yield* fail('canonical');
      lastJoin = joined;
      closedJoins.add(`${id(key)}:${keyId(request)}`);
    }
    const history = yield* array(fields[10]);
    if (history.length !== number + 1) return yield* fail('canonical');
    const historyPackets = new Map<number, EpochHistoryPacket>();
    const usedCommitments = new Set<string>();
    for (let epoch = 0; epoch < history.length; epoch++) {
      const row = yield* array(history[epoch]);
      if (row.length !== 3 || (yield* uint(row[0])) !== epoch) return yield* fail('canonical');
      const commitment = yield* lift(Bytes.epochCommitment(yield* exact(row[1], 32)));
      const packet = yield* exact(row[2], epoch === 0 ? 0 : 72);
      if (usedCommitments.has(id(commitment))) return yield* fail('replay');
      usedCommitments.add(id(commitment));
      historyPackets.set(epoch, Object.freeze({ epoch, commitment, packet: copyBytes(packet) }));
    }
    if (!historyPackets.get(number)!.commitment.equals(keyCommitment))
      return yield* fail('canonical');
    if ((trust.length === 1) !== bytesEqual(genesis.toBytes(), head.toBytes()))
      return yield* fail('canonical');
    // Bounds that follow from the existing supported record grammar, not an audit claim.
    if (
      number >= trust.length ||
      members.size > trust.length ||
      devices.size > trust.length ||
      usedSigningKeys.size > trust.length ||
      usedEncKeys.size > trust.length ||
      usedMembershipIds.size > trust.length ||
      closedJoins.size >= trust.length
    )
      return yield* fail('canonical');
    if (
      trust.length === 1 &&
      (members.size !== 1 ||
        devices.size !== 1 ||
        [...devices.values()][0]!.kind !== 'personal' ||
        rotationRequired ||
        usedSigningKeys.size !== 1 ||
        usedEncKeys.size !== 1 ||
        usedMembershipIds.size !== 1 ||
        closedJoins.size !== 0)
    )
      return yield* fail('canonical');
    const hashes = Chunk.of(head);
    const hashesOffset = trust.length - 1;
    const verification = 'endorsed-snapshot' as const;
    const contentAuthors = new Map<
      string,
      InternalState['contentAuthors'] extends HashMap.HashMap<string, infer A> ? A : never
    >();
    for (const [key, d] of devices)
      contentAuthors.set(
        key,
        Object.freeze({
          kind: 'member' as const,
          device: yield* lift(Bytes.signingPublicKey(raw(key))),
          actor: members.get(id(d.membershipId))!.userId,
          memberInstance: d.membershipId,
        })
      );
    const state: InternalState = {
      genesis,
      owner,
      members: HashMap.fromIterable(members),
      devices: HashMap.fromIterable(devices),
      epoch: Object.freeze({ number, keyCommitment, rotationRequired }),
      usedSigningKeys: HashSet.fromIterable(usedSigningKeys),
      usedEncKeys: HashSet.fromIterable(usedEncKeys),
      usedMembershipIds: HashSet.fromIterable(usedMembershipIds),
      memberUsers: HashSet.fromIterable([...members.values()].map((member) => id(member.userId))),
      closedJoins: HashSet.fromIterable(closedJoins),
      usedCommitments: HashSet.fromIterable(usedCommitments),
      hashes,
      hashesOffset,
      verification,
      historyPackets: HashMap.fromIterable(historyPackets),
      contentAuthors: HashMap.fromIterable(contentAuthors),
    };
    if (!eligible(state, signer)) return yield* fail('unauthorized');
    return state;
  });
}
/** External independent role facts are mandatory; no role inference from signed self-claims. */
export function verifiedSnapshotState(
  bytes: Uint8Array,
  trust: SnapshotTrust
): Result.Result<InternalState, LedgerError> {
  return safely(() =>
    Result.gen(function* () {
      const source = trust.source,
        role = trust.role,
        kind = trust.kind;
      if (
        source !== 'external-confirmation' ||
        kind !== 'personal' ||
        (role !== 'owner' && role !== 'admin')
      )
        return yield* fail('unauthorized');
      const pin = yield* ownedPin(trust),
        membership = yield* lift(Bytes.membershipId(trust.membershipId.toBytes()));
      const digest = trust.stateDigest
        ? yield* lift(Bytes.recordHash(trust.stateDigest.toBytes()))
        : undefined;
      const state = yield* claimedSnapshotState(bytes, pin);
      const device = stateGet(state.devices, id(pin.endorser))!;
      if (
        !device.membershipId.equals(membership) ||
        device.kind !== kind ||
        stateGet(state.members, id(membership))?.role !== role
      )
        return yield* fail('unauthorized');
      if (digest) {
        const note = yield* noteOf(state, pin.endorser);
        if (!note.stateDigest.equals(digest)) return yield* fail('checkpoint-mismatch');
      }
      return state;
    })
  );
}
/** Signature evidence from a snapshot whose endorser is pinned by identity only; carries role claims, not a view. */
export interface SnapshotEvidence {
  readonly stage: 'signature-evidence';
  readonly genesis: Bytes.GenesisHash;
  readonly head: Bytes.RecordHash;
  readonly length: number;
  readonly stateDigest: Bytes.RecordHash;
  readonly claims: {
    readonly endorser: Bytes.SigningPublicKey;
    readonly membershipId: Bytes.MembershipId;
    readonly role: 'owner' | 'admin';
    readonly kind: 'personal';
  };
}
/** Role remains a claim. This result is neither LedgerView nor an authority constructor. */
export function authenticateLedgerSnapshotEvidence(
  bytes: Uint8Array,
  pin: SnapshotIdentityPin
): Result.Result<SnapshotEvidence, LedgerError> {
  return safely(() =>
    Result.gen(function* () {
      const owned = yield* ownedPin(pin),
        state = yield* claimedSnapshotState(bytes, owned),
        note = yield* noteOf(state, owned.endorser);
      const device = stateGet(state.devices, id(owned.endorser))!,
        member = stateGet(state.members, id(device.membershipId))!;
      const role = member.role;
      if (role !== 'owner' && role !== 'admin') return yield* fail('unauthorized');
      return Object.freeze({
        stage: 'signature-evidence' as const,
        genesis: owned.genesis,
        head: owned.head,
        length: owned.length,
        stateDigest: note.stateDigest,
        claims: Object.freeze({
          endorser: owned.endorser,
          membershipId: device.membershipId,
          role,
          kind: 'personal' as const,
        }),
      });
    })
  );
}
function ownedNote(note: ComparisonNote) {
  return Result.try({
    try: () =>
      Result.getOrThrow(
        Result.gen(function* () {
          if (!Number.isSafeInteger(note.length) || note.length < 1)
            return yield* fail('canonical');
          return Object.freeze({
            genesis: yield* lift(Bytes.genesisHash(note.genesis.toBytes())),
            head: yield* lift(Bytes.recordHash(note.head.toBytes())),
            length: note.length,
            stateDigest: yield* lift(Bytes.recordHash(note.stateDigest.toBytes())),
            noteSigner: yield* lift(Bytes.signingPublicKey(note.noteSigner.toBytes())),
          });
        })
      ),
    catch: () => new LedgerError({ code: 'canonical' }),
  });
}
/** Raw comparison has no authentication or independent-confirmation claim. */
export function compareNotes(
  local: ComparisonNote,
  remote: ComparisonNote
): Result.Result<Comparison, LedgerError> {
  return Result.gen(function* () {
    const a = yield* ownedNote(local),
      b = yield* ownedNote(remote);
    if (!a.genesis.equals(b.genesis)) return { kind: 'different-org' as const };
    if (a.length !== b.length)
      return { kind: 'pending-sync' as const, localLength: a.length, remoteLength: b.length };
    if (!a.head.equals(b.head) || !a.stateDigest.equals(b.stateDigest))
      return {
        kind: 'conflict' as const,
        length: a.length,
        localDigest: a.stateDigest,
        remoteDigest: b.stateDigest,
      };
    return {
      kind: 'agree' as const,
      length: a.length,
      stateDigest: a.stateDigest,
      independent: false,
    };
  });
}
/** A comparison tuple obtained independently (manually or over an authenticated channel). */
export interface IndependentConfirmation {
  readonly source: 'manual' | 'authenticated-channel';
  /** Caller-obtained actual tuple from the independently authenticated peer, not copied server JSON. */
  readonly expected: ComparisonNote;
}
/** Confirm the exact independently obtained tuple. This never upgrades ledger authority/history. */
export function confirmIndependentComparison(
  local: ComparisonNote,
  remote: ComparisonNote,
  originalEndorser: Bytes.SigningPublicKey,
  confirmation: IndependentConfirmation
): Result.Result<Comparison, LedgerError> {
  return Result.gen(function* () {
    if (confirmation?.source !== 'manual' && confirmation?.source !== 'authenticated-channel')
      return yield* fail('unauthorized');
    const a = yield* ownedNote(local),
      b = yield* ownedNote(remote),
      expected = yield* ownedNote(confirmation.expected);
    const original = yield* lift(Bytes.signingPublicKey(originalEndorser.toBytes()));
    if (
      !b.genesis.equals(expected.genesis) ||
      !b.head.equals(expected.head) ||
      b.length !== expected.length ||
      !b.stateDigest.equals(expected.stateDigest) ||
      !b.noteSigner.equals(expected.noteSigner)
    )
      return yield* fail('unauthorized');
    const compared = yield* compareNotes(a, b);
    return compared.kind === 'agree'
      ? {
          ...compared,
          independent: !b.noteSigner.equals(original) && !b.noteSigner.equals(a.noteSigner),
          confirmationSource: confirmation.source,
        }
      : compared;
  });
}
