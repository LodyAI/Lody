import { Chunk, HashMap, HashSet, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../foundation/bytes';
import { concat } from '../foundation/concat';
import {
  bytesEqual,
  decodeRetainedCbor,
  decodeSnapshotCbor,
  encodeRetainedCbor,
  encodeSnapshotCbor,
  type CborValue,
} from '../foundation/cbor';
import { keyId } from '../foundation/identifiers';
import { retainedSigningPublicKey } from '../foundation/owned-bytes';
import { verifySignature } from '../foundation/signature';
import { LedgerError } from './errors';
import { decodeMachineId, encodeMachineId } from './machine-id';
import { fail, type DeviceKind, type Role } from './records';
import {
  hashAt,
  stateGet,
  type InternalState,
  type Member,
  type Device,
  type DeviceRecord,
  type EpochHistoryPacket,
} from './policy';

const domain = (name: string) => new TextEncoder().encode(`lody-e2ee/${name}\0`);
const lift = <A>(r: Result.Result<A, { readonly code: LedgerError['code'] }>) =>
  Result.mapError(r, (e) => new LedgerError({ code: e.code }));
/**
 * Format versions of the compact authorization-state encoding `S`. Current-only:
 * decoders reject every other version as `unknown-version`. Version 3 preserves machine bindings and historical device kinds; older layouts
 * cannot restore those facts and are rejected without migration.
 */
const SNAPSHOT_BODY_VERSION = 3;
/** Retained envelope version; the digest body shares it so the digest is derivable from retained bytes. */
const RETAINED_VERSION = 3;
const DIGEST_DOMAIN = 'snapshot-digest/v3';
const digestOfBody = (body: Uint8Array) =>
  lift(Bytes.recordHash(sha256(concat([domain(DIGEST_DOMAIN), body]))));
/**
 * Deterministic CBOR: the digest body `[3, genesis, length, head, S]` is the
 * retained array `[3, genesis, length, head, S, verification]` with a 5-element
 * head and without its last one-byte element, so the digest needs no second encoding.
 */
const retainedDigest = (bytes: Uint8Array) =>
  digestOfBody(concat([Uint8Array.of(0x85), bytes.subarray(1, bytes.length - 1)]));
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
// Lowercase hex digit value: '0'-'9' keep their low nibble, 'a'-'f' add 9.
const nibble = (c: number) => (c & 0xf) + (c >> 6) * 9;
const raw = (s: string) => {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = (nibble(s.charCodeAt(2 * i)) << 4) | nibble(s.charCodeAt(2 * i + 1));
  return bytes;
};
// Same-length lowercase hex sorts exactly like its bytes.
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const roles: readonly Role[] = ['owner', 'admin', 'member', 'guest'];
const kinds: readonly DeviceKind[] = ['personal', 'machine', 'recovery'];

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
/**
 * Fixed-width rows of the authorization state `S`, concatenated per table:
 *
 * - memberships, by membership ID: ID (16) | user ID (32) | role (1),
 *   role 0 = removed, 1 owner, 2 admin, 3 member, 4 guest;
 * - devices, by signing key: signing key (32) | encryption key (32) |
 *   membership index (u32 BE) | kind (1: 0 personal, 1 machine, 2 recovery) |
 *   active (1: 0 retired, 1 current);
 * - machine bindings for every historical machine, by device index: device index
 *   (u32 BE) | UTF-8 byte length (u16 BE) | exact UTF-8 (1..256 bytes);
 * - joins, by device index: device index (u32 BE) | request ID (16);
 * - epoch commitments 0..n (32 each) and history packets 1..n (72 each).
 *
 * Each fact is stored once. Used keys, membership IDs, closed joins and
 * commitments are the tables themselves; current members and devices are the
 * rows with a nonzero role or active flag.
 */
const MEMBERSHIP_ROW = 49;
const DEVICE_ROW = 70;
const JOIN_ROW = 20;
const COMMITMENT_ROW = 32;
const PACKET_ROW = 72;
const writeIndex = (out: Uint8Array, at: number, value: number) =>
  new DataView(out.buffer, out.byteOffset).setUint32(at, value);
const readIndex = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
function authState(s: InternalState): CborValue {
  const membershipKeys = [...HashMap.keys(s.membershipUsers)].sort(byKey);
  const membershipIndex = new Map(membershipKeys.map((key, index) => [key, index]));
  const memberships = new Uint8Array(membershipKeys.length * MEMBERSHIP_ROW);
  membershipKeys.forEach((key, index) => {
    const at = index * MEMBERSHIP_ROW;
    memberships.set(raw(key), at);
    memberships.set(stateGet(s.membershipUsers, key)!.toBytes(), at + 16);
    const member = stateGet(s.members, key);
    memberships[at + 48] = member ? roles.indexOf(member.role) + 1 : 0;
  });
  const deviceKeys = [...HashMap.keys(s.deviceHistory)].sort(byKey);
  const deviceIndex = new Map(deviceKeys.map((key, index) => [key, index]));
  const devices = new Uint8Array(deviceKeys.length * DEVICE_ROW);
  const machineRows: Uint8Array[] = [];
  deviceKeys.forEach((key, index) => {
    const at = index * DEVICE_ROW;
    const record = stateGet(s.deviceHistory, key)!;
    devices.set(raw(key), at);
    devices.set(record.encryptionPublicKey.toBytes(), at + 32);
    writeIndex(devices, at + 64, membershipIndex.get(id(record.membershipId))!);
    const current = stateGet(s.devices, key);
    devices[at + 68] = kinds.indexOf(record.kind);
    devices[at + 69] = current ? 1 : 0;
    if (record.kind === 'machine') {
      const machineId = Result.getOrThrow(encodeMachineId(record.machineId));
      const binding = new Uint8Array(6 + machineId.length);
      writeIndex(binding, 0, index);
      new DataView(binding.buffer).setUint16(4, machineId.length);
      binding.set(machineId, 6);
      machineRows.push(binding);
    }
  });
  const joinRows = [...s.closedJoins]
    .map((join) => {
      const split = join.indexOf(':');
      return [deviceIndex.get(join.slice(0, split))!, raw(join.slice(split + 1))] as const;
    })
    .sort(([a], [b]) => a - b);
  const joins = new Uint8Array(joinRows.length * JOIN_ROW);
  joinRows.forEach(([device, request], index) => {
    writeIndex(joins, index * JOIN_ROW, device);
    joins.set(request, index * JOIN_ROW + 4);
  });
  const epochs = s.epoch.number + 1;
  const commitments = new Uint8Array(epochs * COMMITMENT_ROW);
  const packets = new Uint8Array((epochs - 1) * PACKET_ROW);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const row = stateGet(s.historyPackets, epoch)!;
    commitments.set(row.commitment.toBytes(), epoch * COMMITMENT_ROW);
    if (epoch > 0) packets.set(row.packet, (epoch - 1) * PACKET_ROW);
  }
  return [
    memberships,
    devices,
    joins,
    commitments,
    packets,
    s.epoch.rotationRequired,
    concat(machineRows),
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
        SNAPSHOT_BODY_VERSION,
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
/** Digest of protocol, genesis, length, head and actual authorization state; it names no signer. */
export function stateDigestOf(s: InternalState): Result.Result<Bytes.RecordHash, LedgerError> {
  return Result.gen(function* () {
    const head = hashAt(s, s.hashes.length - 1)!;
    const body = yield* lift(
      encodeSnapshotCbor([
        RETAINED_VERSION,
        s.genesis.toBytes(),
        s.hashesOffset + s.hashes.length,
        head.toBytes(),
        authState(s),
      ])
    );
    return yield* digestOfBody(body);
  });
}
export function noteOf(
  s: InternalState,
  signer: Bytes.SigningPublicKey
): Result.Result<ComparisonNote, LedgerError> {
  return Result.gen(function* () {
    const device = stateGet(s.devices, id(signer));
    if (!device || device.kind !== 'personal') return yield* fail('unauthorized');
    return Object.freeze({
      genesis: s.genesis,
      head: hashAt(s, s.hashes.length - 1)!,
      length: s.hashesOffset + s.hashes.length,
      stateDigest: yield* stateDigestOf(s),
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
const verifications: readonly InternalState['verification'][] = [
  'full-history',
  'endorsed-snapshot',
];
/** A party's own retained state bytes and the state digest of its comparison note. */
export function encodeRetainedState(
  s: InternalState
): Result.Result<{ bytes: Uint8Array; stateDigest: Bytes.RecordHash }, LedgerError> {
  return Result.gen(function* () {
    const head = hashAt(s, s.hashes.length - 1)!;
    const bytes = yield* lift(
      encodeRetainedCbor([
        RETAINED_VERSION,
        s.genesis.toBytes(),
        s.hashesOffset + s.hashes.length,
        head.toBytes(),
        authState(s),
        verifications.indexOf(s.verification),
      ])
    );
    return { bytes, stateDigest: yield* retainedDigest(bytes) };
  });
}
/**
 * Decode only: no signature check. The caller vouches that these are its own
 * exported bytes. A supplied `stateDigest` is recomputed from the bytes after
 * they decode (so an older version still reports `unknown-version`) and must match.
 */
export function decodeRetainedState(
  bytes: Uint8Array,
  expected: {
    readonly genesis: Bytes.GenesisHash;
    readonly head: Bytes.RecordHash;
    readonly length: number;
    readonly stateDigest?: Bytes.RecordHash | undefined;
  }
): Result.Result<InternalState, LedgerError> {
  return safely(() =>
    Result.gen(function* () {
      const genesis = yield* lift(Bytes.genesisHash(expected.genesis.toBytes()));
      const head = yield* lift(Bytes.recordHash(expected.head.toBytes()));
      const length = expected.length;
      if (!Number.isSafeInteger(length) || length < 1) return yield* fail('checkpoint-mismatch');
      const root = yield* array(yield* lift(decodeRetainedCbor(bytes)));
      if (root.length !== 6) return yield* fail('canonical');
      if ((yield* uint(root[0])) !== RETAINED_VERSION) return yield* fail('unknown-version');
      if (!bytesEqual(yield* exact(root[1], 32), genesis.toBytes()))
        return yield* fail('wrong-anchor');
      if (
        (yield* uint(root[2])) !== length ||
        !bytesEqual(yield* exact(root[3], 32), head.toBytes())
      )
        return yield* fail('checkpoint-mismatch');
      const verification = verifications[yield* uint(root[5])];
      if (!verification) return yield* fail('canonical');
      const state = yield* decodeAuthState(root[4], {
        genesis,
        length,
        head,
        verification,
        retained: true,
      });
      if (expected.stateDigest) {
        const stored = yield* lift(Bytes.recordHash(expected.stateDigest.toBytes()));
        if (!stored.equals(yield* retainedDigest(bytes)))
          return yield* fail('state-digest-mismatch');
      }
      return state;
    })
  );
}
/** Structural decode of an encoded authorization state at a known position. Establishes no authority by itself. */
function decodeAuthState(
  value: CborValue | undefined,
  at: {
    readonly genesis: Bytes.GenesisHash;
    readonly length: number;
    readonly head: Bytes.RecordHash;
    readonly verification: InternalState['verification'];
    /** The caller's own retained state: its keys passed the curve check when first verified. */
    readonly retained: boolean;
  }
): Result.Result<InternalState, LedgerError> {
  const signingKey = (bytes: Uint8Array) =>
    at.retained
      ? Result.succeed(retainedSigningPublicKey(bytes))
      : lift(Bytes.signingPublicKey(bytes));
  const table = (v: CborValue | undefined, row: number) =>
    v instanceof Uint8Array && v.length % row === 0 ? Result.succeed(v) : fail('canonical');
  return Result.gen(function* () {
    const fields = yield* array(value);
    if (fields.length !== 7) return yield* fail('canonical');
    const membershipBytes = yield* table(fields[0], MEMBERSHIP_ROW),
      deviceBytes = yield* table(fields[1], DEVICE_ROW),
      joinBytes = yield* table(fields[2], JOIN_ROW),
      commitmentBytes = yield* table(fields[3], COMMITMENT_ROW),
      packetBytes = yield* table(fields[4], PACKET_ROW);
    const rotationRequired = fields[5];
    if (typeof rotationRequired !== 'boolean') return yield* fail('canonical');

    const membershipCount = membershipBytes.length / MEMBERSHIP_ROW;
    const membershipIds: Bytes.MembershipId[] = [];
    const membershipUsers = new Map<string, Bytes.UserId>();
    const members = new Map<string, Member>();
    const users = new Set<string>();
    let owner: Bytes.MembershipId | undefined;
    for (let index = 0; index < membershipCount; index++) {
      const row = membershipBytes.subarray(index * MEMBERSHIP_ROW, (index + 1) * MEMBERSHIP_ROW);
      if (index > 0 && cmp(membershipIds[index - 1]!.toBytes(), row.subarray(0, 16)) >= 0)
        return yield* fail('canonical');
      const key = yield* lift(Bytes.membershipId(row.subarray(0, 16)));
      const userId = yield* lift(Bytes.userId(row.subarray(16, 48)));
      const roleByte = row[48]!;
      if (roleByte > roles.length) return yield* fail('canonical');
      membershipIds.push(key);
      membershipUsers.set(id(key), userId);
      if (roleByte === 0) continue;
      const role = roles[roleByte - 1]!;
      if (users.has(id(userId))) return yield* fail('replay');
      users.add(id(userId));
      members.set(id(key), Object.freeze({ userId, role }));
      if (role === 'owner') {
        if (owner) return yield* fail('canonical');
        owner = key;
      }
    }
    if (!owner) return yield* fail('canonical');

    const deviceCount = deviceBytes.length / DEVICE_ROW;
    const machineBytes = fields[6];
    if (!(machineBytes instanceof Uint8Array)) return yield* fail('canonical');
    const bindings = new Map<number, string>();
    let previousMachine = -1;
    for (let offset = 0; offset < machineBytes.length;) {
      if (offset + 6 > machineBytes.length) return yield* fail('canonical');
      const device = readIndex(machineBytes, offset);
      const length = new DataView(machineBytes.buffer, machineBytes.byteOffset).getUint16(
        offset + 4
      );
      if (
        device <= previousMachine ||
        device >= deviceCount ||
        offset + 6 + length > machineBytes.length
      )
        return yield* fail('canonical');
      bindings.set(
        device,
        yield* decodeMachineId(machineBytes.subarray(offset + 6, offset + 6 + length))
      );
      previousMachine = device;
      offset += 6 + length;
    }
    const machineDevices = new Map<string, string>();
    const deviceKeys: Bytes.SigningPublicKey[] = [];
    const deviceHistory = new Map<string, DeviceRecord>();
    const devices = new Map<string, Device>();
    const encryptionKeys = new Set<string>();
    const founded = new Set<number>();
    for (let index = 0; index < deviceCount; index++) {
      const row = deviceBytes.subarray(index * DEVICE_ROW, (index + 1) * DEVICE_ROW);
      if (index > 0 && cmp(deviceKeys[index - 1]!.toBytes(), row.subarray(0, 32)) >= 0)
        return yield* fail('canonical');
      const key = yield* signingKey(row.slice(0, 32));
      const encryptionPublicKey = yield* lift(Bytes.encryptionPublicKey(row.subarray(32, 64)));
      if (encryptionKeys.has(id(encryptionPublicKey))) return yield* fail('replay');
      encryptionKeys.add(id(encryptionPublicKey));
      const membership = readIndex(row, 64);
      const kind = kinds[row[68]!];
      const status = row[69]!;
      if (membership >= membershipCount || !kind || status > 1) return yield* fail('canonical');
      const machineId = bindings.get(index);
      if ((kind === 'machine') !== (machineId !== undefined)) return yield* fail('canonical');
      const binding = kind === 'machine' ? { machineId } : {};
      if (kind === 'personal') founded.add(membership);
      const membershipId = membershipIds[membership]!;
      deviceKeys.push(key);
      deviceHistory.set(
        id(key),
        Object.freeze({
          signingPublicKey: key,
          encryptionPublicKey,
          membershipId,
          kind,
          ...binding,
        })
      );
      if (status === 0) continue;
      // A current device belongs to a current member.
      if (!members.has(id(membershipId))) return yield* fail('canonical');
      if (kind === 'machine' && machineId !== undefined) {
        if (machineDevices.has(machineId)) return yield* fail('canonical');
        machineDevices.set(machineId, id(key));
      }
      devices.set(id(key), Object.freeze({ membershipId, kind, encryptionPublicKey, ...binding }));
    }
    // Every membership was admitted with a device.
    if (founded.size !== membershipCount) return yield* fail('canonical');
    // A signed endorsement cannot make structurally unreachable Owner custody valid.
    if (![...devices.values()].some((d) => d.membershipId.equals(owner) && d.kind !== 'machine'))
      return yield* fail('unauthorized');

    // One join per membership but the genesis one, each naming that membership's founding device.
    const joinCount = joinBytes.length / JOIN_ROW;
    if (joinCount !== membershipCount - 1) return yield* fail('canonical');
    const closedJoins = new Set<string>();
    const joinedMemberships = new Set<string>();
    let lastDevice = -1;
    for (let index = 0; index < joinCount; index++) {
      const row = joinBytes.subarray(index * JOIN_ROW, (index + 1) * JOIN_ROW);
      const device = readIndex(row, 0);
      if (device <= lastDevice || device >= deviceCount) return yield* fail('canonical');
      lastDevice = device;
      const key = deviceKeys[device]!;
      const founding = deviceHistory.get(id(key))!;
      if (founding.kind !== 'personal') return yield* fail('canonical');
      const membership = id(founding.membershipId);
      if (joinedMemberships.has(membership)) return yield* fail('canonical');
      joinedMemberships.add(membership);
      closedJoins.add(`${id(key)}:${keyId(row.subarray(4, 20))}`);
    }

    const epochCount = commitmentBytes.length / COMMITMENT_ROW;
    if (epochCount < 1 || packetBytes.length !== (epochCount - 1) * PACKET_ROW)
      return yield* fail('canonical');
    const number = epochCount - 1;
    if (number > 0xffffffff) return yield* fail('canonical');
    const historyPackets = new Map<number, EpochHistoryPacket>();
    const usedCommitments = new Set<string>();
    for (let epoch = 0; epoch < epochCount; epoch++) {
      const commitment = yield* lift(
        Bytes.epochCommitment(
          commitmentBytes.subarray(epoch * COMMITMENT_ROW, (epoch + 1) * COMMITMENT_ROW)
        )
      );
      if (usedCommitments.has(id(commitment))) return yield* fail('replay');
      usedCommitments.add(id(commitment));
      const packet =
        epoch === 0
          ? new Uint8Array()
          : packetBytes.slice((epoch - 1) * PACKET_ROW, epoch * PACKET_ROW);
      historyPackets.set(epoch, Object.freeze({ epoch, commitment, packet }));
    }
    const keyCommitment = historyPackets.get(number)!.commitment;

    if ((at.length === 1) !== bytesEqual(at.genesis.toBytes(), at.head.toBytes()))
      return yield* fail('canonical');
    // Bounds that follow from the existing supported record grammar, not an audit claim.
    if (
      number >= at.length ||
      membershipCount > at.length ||
      deviceCount > at.length ||
      joinCount >= at.length
    )
      return yield* fail('canonical');
    if (
      at.length === 1 &&
      (membershipCount !== 1 ||
        deviceCount !== 1 ||
        [...devices.values()][0]?.kind !== 'personal' ||
        rotationRequired)
    )
      return yield* fail('canonical');
    return {
      genesis: at.genesis,
      owner,
      members: HashMap.fromIterable(members),
      devices: HashMap.fromIterable(devices),
      machineDevices: HashMap.fromIterable(machineDevices),
      epoch: Object.freeze({ number, keyCommitment, rotationRequired }),
      membershipUsers: HashMap.fromIterable(membershipUsers),
      deviceHistory: HashMap.fromIterable(deviceHistory),
      usedEncKeys: HashSet.fromIterable(encryptionKeys),
      memberUsers: HashSet.fromIterable(users),
      closedJoins: HashSet.fromIterable(closedJoins),
      usedCommitments: HashSet.fromIterable(usedCommitments),
      hashes: Chunk.of(at.head),
      hashesOffset: at.length - 1,
      verification: at.verification,
      historyPackets: HashMap.fromIterable(historyPackets),
    };
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
    if ((yield* uint(body[0])) !== SNAPSHOT_BODY_VERSION) return yield* fail('unknown-version');
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
    const state = yield* decodeAuthState(body[5], {
      genesis,
      length: trust.length,
      head,
      verification: 'endorsed-snapshot',
      retained: false,
    });
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
