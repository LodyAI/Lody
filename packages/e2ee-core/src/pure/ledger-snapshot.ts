import { Either } from 'effect';
import { ValidationError, type LedgerErrorCode } from './errors';
import { SigningFacts } from './signing-facts';
import { keyId, joinKey } from './identifiers';
const fail = (code: LedgerErrorCode): Either.Either<never, ValidationError> =>
  Either.left(new ValidationError({ code }));
import {
  asArray,
  asBool,
  asExactBytes,
  asUint,
  bytesEqual,
  copyBytes,
  decodeSnapshotCbor,
  encodeSnapshotCbor,
  MAX_SNAPSHOT_ARRAY_LENGTH,
  type CborValue,
} from './cbor';
import {
  ENCRYPTION_KEY_BYTES,
  HASH_BYTES,
  HISTORY_PACKET_BYTES,
  MEMBERSHIP_ID_BYTES,
  REQUEST_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_KEY_BYTES,
  USER_ID_BYTES,
  checkEncryptionPublicKey,
  checkHash,
  checkSigningPublicKey,
  headAttestationSigningBytes,
  snapshotSigningBytes,
  snapshotStateDigest,
  type Hash,
  type Signature,
  type SigningPublicKey,
} from './wire-crypto';
import {
  KIND_MACHINE,
  KIND_PERSONAL,
  KIND_RECOVERY,
  ROLE_ADMIN,
  ROLE_GUEST,
  ROLE_MEMBER,
  type DeviceKind,
  type Role,
} from './ledger-schema';
import type { Device, HistoryPacketRow, InternalState, Member } from './ledger-state';
export const SNAPSHOT_VERSION = 1;
export const ROLE_OWNER = 0;
export interface SnapshotTrust {
  readonly genesis: Hash;
  readonly endorser: SigningPublicKey;
  readonly head: Hash;
  readonly headSignature: Signature;
}
export interface SnapshotProposal {
  readonly signer: SigningPublicKey;
  readonly genesis: Hash;
  readonly head: Hash;
  readonly length: number;
  readonly bodyBytes: Uint8Array;
  readonly signingBytes: Uint8Array;
  readonly headAttestationSigningBytes: Uint8Array;
}
export interface ComparisonNote {
  readonly genesis: Hash;
  readonly length: number;
  readonly head: Hash;
  readonly stateDigest: Hash;
  readonly noteSigner: SigningPublicKey;
}
export type Comparison =
  | {
      readonly kind: 'different-org';
    }
  | {
      readonly kind: 'pending-sync';
      readonly localLength: number;
      readonly remoteLength: number;
    }
  | {
      readonly kind: 'agree';
      readonly length: number;
      readonly stateDigest: Hash;
      readonly independent: boolean;
    }
  | {
      readonly kind: 'conflict';
      readonly length: number;
      readonly localDigest: Hash;
      readonly remoteDigest: Hash;
    };
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.byteLength - b.byteLength;
}
function assertSortedUnique(values: readonly Uint8Array[]): Either.Either<void, ValidationError> {
  return Either.gen(function* () {
    for (let i = 1; i < values.length; i++) {
      if (compareBytes(values[i - 1]!, values[i]!) >= 0) return yield* fail('canonical');
    }
    return undefined;
  });
}
function bytesFromHex(id: string): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    if (id.length % 2 !== 0) return yield* fail('canonical');
    const out = new Uint8Array(id.length / 2);
    for (let i = 0; i < out.length; i++) {
      const n = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
      if (!Number.isInteger(n)) return yield* fail('canonical');
      out[i] = n;
    }
    return out;
  });
}
function encodeRole(role: Role): number {
  if (role === 'owner') return ROLE_OWNER;
  if (role === 'admin') return ROLE_ADMIN;
  if (role === 'member') return ROLE_MEMBER;
  return ROLE_GUEST;
}
function decodeRole(value: CborValue): Either.Either<Role, ValidationError> {
  return Either.gen(function* () {
    const role = yield* asUint(value);
    if (role === ROLE_OWNER) return 'owner';
    if (role === ROLE_ADMIN) return 'admin';
    if (role === ROLE_MEMBER) return 'member';
    if (role === ROLE_GUEST) return 'guest';
    return yield* fail('canonical');
  });
}
function encodeKind(kind: DeviceKind): number {
  if (kind === 'personal') return KIND_PERSONAL;
  if (kind === 'machine') return KIND_MACHINE;
  return KIND_RECOVERY;
}
function decodeKind(value: CborValue): Either.Either<DeviceKind, ValidationError> {
  return Either.gen(function* () {
    const kind = yield* asUint(value);
    if (kind === KIND_PERSONAL) return 'personal';
    if (kind === KIND_MACHINE) return 'machine';
    if (kind === KIND_RECOVERY) return 'recovery';
    return yield* fail('canonical');
  });
}
function encodeAuthState(state: InternalState): Either.Either<CborValue, ValidationError> {
  return Either.gen(function* () {
    const members: Array<{
      id: Uint8Array;
      member: Member;
    }> = [];
    for (const [id, member] of state.members) members.push({ id: yield* bytesFromHex(id), member });
    members.sort((a, b) => compareBytes(a.id, b.id));
    const devices: Array<{
      id: Uint8Array;
      device: Device;
    }> = [];
    for (const [id, device] of state.devices) devices.push({ id: yield* bytesFromHex(id), device });
    devices.sort((a, b) => compareBytes(a.id, b.id));
    const usedSigning: Uint8Array[] = [];
    for (const id of state.usedSigningKeys) usedSigning.push(yield* bytesFromHex(id));
    usedSigning.sort(compareBytes);
    const usedEnc: Uint8Array[] = [];
    for (const id of state.usedEncKeys) usedEnc.push(yield* bytesFromHex(id));
    usedEnc.sort(compareBytes);
    const usedMembers: Uint8Array[] = [];
    for (const id of state.usedMembershipIds) usedMembers.push(yield* bytesFromHex(id));
    usedMembers.sort(compareBytes);
    const closed: Array<{
      first: Uint8Array;
      requestId: Uint8Array;
    }> = [];
    for (const join of state.closedJoins) {
      const sep = join.indexOf(':');
      if (sep <= 0) return yield* fail('canonical');
      closed.push({
        first: yield* bytesFromHex(join.slice(0, sep)),
        requestId: yield* bytesFromHex(join.slice(sep + 1)),
      });
    }
    closed.sort((a, b) => compareBytes(a.first, b.first) || compareBytes(a.requestId, b.requestId));
    const history: CborValue[] = [];
    for (let epoch = 0; epoch <= state.epoch.number; epoch++) {
      const row = state.historyPackets.get(epoch);
      if (!row) return yield* fail('invalid-operation');
      history.push([epoch, copyBytes(row.commitment), copyBytes(row.packet)]);
    }
    return [
      copyBytes(state.owner),
      members.map(({ id, member }) => [id, copyBytes(member.userId), encodeRole(member.role)]),
      devices.map(({ id, device }) => [
        id,
        copyBytes(device.membershipId),
        encodeKind(device.kind),
        copyBytes(device.encryptionPublicKey),
      ]),
      state.epoch.number,
      copyBytes(state.epoch.keyCommitment),
      state.epoch.rotationRequired,
      usedSigning,
      usedEnc,
      usedMembers,
      closed.map((row) => [row.first, row.requestId]),
      history,
    ];
  });
}
export function encodeSnapshotBody(
  state: InternalState,
  signer: SigningPublicKey
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    const head = state.hashes[state.hashes.length - 1];
    if (!head) return yield* fail('invalid-operation');
    return yield* encodeSnapshotCbor([
      SNAPSHOT_VERSION,
      copyBytes(state.genesis),
      state.hashes.length,
      copyBytes(head),
      copyBytes(signer),
      yield* encodeAuthState(state),
    ]);
  });
}
export function digestBodyBytes(state: InternalState): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    const head = state.hashes[state.hashes.length - 1];
    if (!head) return yield* fail('invalid-operation');
    return yield* encodeSnapshotCbor([
      SNAPSHOT_VERSION,
      copyBytes(state.genesis),
      state.hashes.length,
      copyBytes(head),
      yield* encodeAuthState(state),
    ]);
  });
}
export function stateDigestOf(state: InternalState): Either.Either<Hash, ValidationError> {
  return Either.gen(function* () {
    return snapshotStateDigest(yield* digestBodyBytes(state));
  });
}
export function encodeSignedSnapshot(
  bodyBytes: Uint8Array,
  signature: Signature
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    if (signature.byteLength !== SIGNATURE_BYTES) return yield* fail('canonical');
    const body = yield* decodeSnapshotCbor(bodyBytes);
    return yield* encodeSnapshotCbor([body, copyBytes(signature)]);
  });
}
export function assertEndorserEligible(
  state: InternalState,
  signer: SigningPublicKey
): Either.Either<void, ValidationError> {
  return Either.gen(function* () {
    const device = state.devices.get(keyId(signer));
    if (!device || device.kind !== 'personal') return yield* fail('unauthorized');
    const member = state.members.get(keyId(device.membershipId));
    if (!member || (member.role !== 'owner' && member.role !== 'admin'))
      return yield* fail('unauthorized');
    return undefined;
  });
}
function decodeKeyList(
  value: CborValue,
  size: number
): Either.Either<Uint8Array[], ValidationError> {
  return Either.gen(function* () {
    const list = yield* asArray(value);
    const keys: Uint8Array[] = [];
    for (const item of list) keys.push(yield* asExactBytes(item, size));
    yield* assertSortedUnique(keys);
    return keys;
  });
}
function importAuthState(
  auth: CborValue,
  genesis: Hash,
  length: number,
  head: Hash,
  signer: SigningPublicKey,
  facts = SigningFacts.empty
): Either.Either<InternalState, ValidationError> {
  return Either.gen(function* () {
    const fields = yield* asArray(auth);
    if (fields.length !== 11) return yield* fail('canonical');
    const owner = yield* asExactBytes(fields[0]!, MEMBERSHIP_ID_BYTES);
    const members = new Map<string, Member>();
    const userIndex = new Map<string, string>();
    let ownerCount = 0;
    const memberRows = yield* asArray(fields[1]!);
    let lastMember: Uint8Array | undefined;
    for (const row of memberRows) {
      const tuple = yield* asArray(row);
      if (tuple.length !== 3) return yield* fail('canonical');
      const membershipId = yield* asExactBytes(tuple[0]!, MEMBERSHIP_ID_BYTES);
      if (lastMember && compareBytes(lastMember, membershipId) >= 0)
        return yield* fail('canonical');
      lastMember = membershipId;
      const userId = yield* asExactBytes(tuple[1]!, USER_ID_BYTES);
      const role = yield* decodeRole(tuple[2]!);
      const membershipHex = keyId(membershipId);
      const userHex = keyId(userId);
      if (members.has(membershipHex) || userIndex.has(userHex)) return yield* fail('replay');
      members.set(membershipHex, { userId: copyBytes(userId), role });
      userIndex.set(userHex, membershipHex);
      if (role === 'owner') ownerCount += 1;
    }
    if (ownerCount !== 1) return yield* fail('canonical');
    const ownerMember = members.get(keyId(owner));
    if (!ownerMember || ownerMember.role !== 'owner') return yield* fail('canonical');
    const devices = new Map<string, Device>();
    let lastDevice: Uint8Array | undefined;
    for (const row of yield* asArray(fields[2]!)) {
      const tuple = yield* asArray(row);
      if (tuple.length !== 4) return yield* fail('canonical');
      const signPub = yield* checkSigningPublicKey(
        yield* asExactBytes(tuple[0]!, SIGNING_KEY_BYTES),
        facts
      );
      if (lastDevice && compareBytes(lastDevice, signPub) >= 0) return yield* fail('canonical');
      lastDevice = signPub;
      const membershipId = yield* asExactBytes(tuple[1]!, MEMBERSHIP_ID_BYTES);
      const kind = yield* decodeKind(tuple[2]!);
      const enc = yield* checkEncryptionPublicKey(
        yield* asExactBytes(tuple[3]!, ENCRYPTION_KEY_BYTES)
      );
      if (!members.has(keyId(membershipId))) return yield* fail('canonical');
      devices.set(keyId(signPub), {
        membershipId: copyBytes(membershipId),
        kind,
        encryptionPublicKey: enc,
      });
    }
    const epochNumber = yield* asUint(fields[3]!);
    const epochCommitment = yield* checkHash(yield* asExactBytes(fields[4]!, HASH_BYTES));
    const rotationRequired = yield* asBool(fields[5]!);
    const usedSigningKeys = new Set(
      (yield* decodeKeyList(fields[6]!, SIGNING_KEY_BYTES)).map(keyId)
    );
    const usedEncKeys = new Set(
      (yield* decodeKeyList(fields[7]!, ENCRYPTION_KEY_BYTES)).map(keyId)
    );
    const usedMembershipIds = new Set(
      (yield* decodeKeyList(fields[8]!, MEMBERSHIP_ID_BYTES)).map(keyId)
    );
    const closedJoins = new Set<string>();
    let lastJoinFirst: Uint8Array | undefined;
    let lastJoinReq: Uint8Array | undefined;
    for (const row of yield* asArray(fields[9]!)) {
      const tuple = yield* asArray(row);
      if (tuple.length !== 2) return yield* fail('canonical');
      const first = yield* checkSigningPublicKey(
        yield* asExactBytes(tuple[0]!, SIGNING_KEY_BYTES),
        facts
      );
      const requestId = yield* asExactBytes(tuple[1]!, REQUEST_ID_BYTES);
      if (lastJoinFirst) {
        const cmp = compareBytes(lastJoinFirst, first);
        if (cmp > 0 || (cmp === 0 && lastJoinReq && compareBytes(lastJoinReq, requestId) >= 0)) {
          return yield* fail('canonical');
        }
      }
      lastJoinFirst = first;
      lastJoinReq = requestId;
      closedJoins.add(joinKey(first, requestId));
    }
    const historyRows = yield* asArray(fields[10]!);
    if (historyRows.length !== epochNumber + 1) return yield* fail('canonical');
    const historyPackets = new Map<number, HistoryPacketRow>();
    const usedCommitments = new Set<string>();
    for (let epoch = 0; epoch <= epochNumber; epoch++) {
      const tuple = yield* asArray(historyRows[epoch]!);
      if (tuple.length !== 3) return yield* fail('canonical');
      if ((yield* asUint(tuple[0]!)) !== epoch) return yield* fail('canonical');
      const commitment = yield* checkHash(yield* asExactBytes(tuple[1]!, HASH_BYTES));
      const packet = tuple[2];
      if (!(packet instanceof Uint8Array)) return yield* fail('canonical');
      if (epoch === 0) {
        if (packet.byteLength !== 0) return yield* fail('canonical');
      } else if (packet.byteLength !== HISTORY_PACKET_BYTES) {
        return yield* fail('canonical');
      }
      if (usedCommitments.has(keyId(commitment))) return yield* fail('replay');
      usedCommitments.add(keyId(commitment));
      historyPackets.set(epoch, { commitment, packet: copyBytes(packet) });
    }
    const latest = historyPackets.get(epochNumber);
    if (!latest || !bytesEqual(latest.commitment, epochCommitment)) return yield* fail('canonical');
    for (const [id, device] of devices) {
      if (!usedSigningKeys.has(id)) return yield* fail('canonical');
      if (!usedEncKeys.has(keyId(device.encryptionPublicKey))) return yield* fail('canonical');
      if (!usedMembershipIds.has(keyId(device.membershipId))) return yield* fail('canonical');
    }
    for (const id of members.keys()) {
      if (!usedMembershipIds.has(id)) return yield* fail('canonical');
    }
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SNAPSHOT_ARRAY_LENGTH) {
      return yield* fail('oversize');
    }
    const genesisEqHead = bytesEqual(genesis, head);
    if ((length === 1) !== genesisEqHead) return yield* fail('canonical');
    const hashes: Array<Uint8Array | undefined> = new Array(length);
    hashes[0] = copyBytes(genesis);
    hashes[length - 1] = copyBytes(head);
    const state: InternalState = {
      genesis: copyBytes(genesis),
      owner: copyBytes(owner),
      members,
      userIndex,
      devices,
      epoch: {
        number: epochNumber,
        keyCommitment: copyBytes(epochCommitment),
        rotationRequired,
      },
      usedSigningKeys,
      usedEncKeys,
      usedMembershipIds,
      closedJoins,
      usedCommitments,
      hashes,
      origin: 'snapshot',
      endorser: copyBytes(signer),
      snapshotLength: length,
      historyPackets,
    };
    yield* assertEndorserEligible(state, signer);
    return state;
  });
}
export function parseSignedSnapshot(
  bytes: Uint8Array,
  facts = SigningFacts.empty
): Either.Either<
  {
    bodyBytes: Uint8Array;
    signature: Signature;
    genesis: Hash;
    length: number;
    head: Hash;
    signer: SigningPublicKey;
    auth: CborValue;
  },
  ValidationError
> {
  return Either.gen(function* () {
    const root = yield* asArray(yield* decodeSnapshotCbor(bytes));
    if (root.length !== 2) return yield* fail('canonical');
    const body = yield* asArray(root[0]!);
    if (body.length !== 6) return yield* fail('canonical');
    if ((yield* asUint(body[0]!)) !== SNAPSHOT_VERSION) return yield* fail('unknown-version');
    const genesis = yield* checkHash(yield* asExactBytes(body[1]!, HASH_BYTES));
    const length = yield* asUint(body[2]!);
    if (length < 1 || length > MAX_SNAPSHOT_ARRAY_LENGTH) return yield* fail('oversize');
    const head = yield* checkHash(yield* asExactBytes(body[3]!, HASH_BYTES));
    const signer = yield* checkSigningPublicKey(
      yield* asExactBytes(body[4]!, SIGNING_KEY_BYTES),
      facts
    );
    const signature = yield* asExactBytes(root[1]!, SIGNATURE_BYTES);
    return {
      bodyBytes: yield* encodeSnapshotCbor(body),
      signature,
      genesis,
      length,
      head,
      signer,
      auth: body[5]!,
    };
  });
}
export function snapshotStateFromParsed(
  parsed: Either.Either.Right<ReturnType<typeof parseSignedSnapshot>>,
  facts = SigningFacts.empty
): Either.Either<InternalState, ValidationError> {
  return Either.gen(function* () {
    return yield* importAuthState(
      parsed.auth,
      parsed.genesis,
      parsed.length,
      parsed.head,
      parsed.signer,
      facts
    );
  });
}
export function decodeSignedSnapshot(
  bytes: Uint8Array,
  facts = SigningFacts.empty
): Either.Either<
  {
    bodyBytes: Uint8Array;
    signature: Signature;
    genesis: Hash;
    length: number;
    head: Hash;
    signer: SigningPublicKey;
    state: InternalState;
  },
  ValidationError
> {
  return Either.gen(function* () {
    const parsed = yield* parseSignedSnapshot(bytes, facts);
    const state = yield* importAuthState(
      parsed.auth,
      parsed.genesis,
      parsed.length,
      parsed.head,
      parsed.signer,
      facts
    );
    return {
      bodyBytes: parsed.bodyBytes,
      signature: parsed.signature,
      genesis: parsed.genesis,
      length: parsed.length,
      head: parsed.head,
      signer: parsed.signer,
      state,
    };
  });
}
export function compareNotes(
  local: ComparisonNote,
  remote: ComparisonNote,
  originalEndorser: SigningPublicKey,
  confirmedNoteSigners: readonly SigningPublicKey[] = []
): Comparison {
  if (!bytesEqual(local.genesis, remote.genesis)) return { kind: 'different-org' };
  if (bytesEqual(local.head, remote.head)) {
    if (local.length !== remote.length || !bytesEqual(local.stateDigest, remote.stateDigest)) {
      return {
        kind: 'conflict',
        length: local.length,
        localDigest: copyBytes(local.stateDigest),
        remoteDigest: copyBytes(remote.stateDigest),
      };
    }
    const confirmed = confirmedNoteSigners.some((key) => bytesEqual(key, remote.noteSigner));
    const independent =
      confirmed &&
      !bytesEqual(remote.noteSigner, originalEndorser) &&
      !bytesEqual(remote.noteSigner, local.noteSigner);
    return {
      kind: 'agree',
      length: local.length,
      stateDigest: copyBytes(local.stateDigest),
      independent,
    };
  }
  if (local.length === remote.length) {
    return {
      kind: 'conflict',
      length: local.length,
      localDigest: copyBytes(local.stateDigest),
      remoteDigest: copyBytes(remote.stateDigest),
    };
  }
  return { kind: 'pending-sync', localLength: local.length, remoteLength: remote.length };
}
export { headAttestationSigningBytes, snapshotSigningBytes };
