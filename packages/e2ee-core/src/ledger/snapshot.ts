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
  joinKey,
  keyId,
  snapshotSigningBytes,
  snapshotStateDigest,
  type Hash,
  type Signature,
  type SigningPointCache,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import {
  KIND_MACHINE,
  KIND_PERSONAL,
  KIND_RECOVERY,
  ROLE_ADMIN,
  ROLE_GUEST,
  ROLE_MEMBER,
  type DeviceKind,
  type Role,
} from './schema';
import type { Device, HistoryPacketRow, InternalState, Member } from './policy';

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
  | { readonly kind: 'different-org' }
  | { readonly kind: 'pending-sync'; readonly localLength: number; readonly remoteLength: number }
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

function assertSortedUnique(values: readonly Uint8Array[]): void {
  for (let i = 1; i < values.length; i++) {
    if (compareBytes(values[i - 1]!, values[i]!) >= 0) fail('canonical');
  }
}

function bytesFromHex(id: string): Uint8Array {
  if (id.length % 2 !== 0) fail('canonical');
  const out = new Uint8Array(id.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(n)) fail('canonical');
    out[i] = n;
  }
  return out;
}

function encodeRole(role: Role): number {
  if (role === 'owner') return ROLE_OWNER;
  if (role === 'admin') return ROLE_ADMIN;
  if (role === 'member') return ROLE_MEMBER;
  return ROLE_GUEST;
}

function decodeRole(value: CborValue): Role {
  const role = asUint(value);
  if (role === ROLE_OWNER) return 'owner';
  if (role === ROLE_ADMIN) return 'admin';
  if (role === ROLE_MEMBER) return 'member';
  if (role === ROLE_GUEST) return 'guest';
  return fail('canonical');
}

function encodeKind(kind: DeviceKind): number {
  if (kind === 'personal') return KIND_PERSONAL;
  if (kind === 'machine') return KIND_MACHINE;
  return KIND_RECOVERY;
}

function decodeKind(value: CborValue): DeviceKind {
  const kind = asUint(value);
  if (kind === KIND_PERSONAL) return 'personal';
  if (kind === KIND_MACHINE) return 'machine';
  if (kind === KIND_RECOVERY) return 'recovery';
  return fail('canonical');
}

function encodeAuthState(state: InternalState): CborValue {
  const members = [...state.members.entries()]
    .map(([id, member]) => ({ id: bytesFromHex(id), member }))
    .sort((a, b) => compareBytes(a.id, b.id));
  const devices = [...state.devices.entries()]
    .map(([id, device]) => ({ id: bytesFromHex(id), device }))
    .sort((a, b) => compareBytes(a.id, b.id));
  const usedSigning = [...state.usedSigningKeys].map(bytesFromHex).sort(compareBytes);
  const usedEnc = [...state.usedEncKeys].map(bytesFromHex).sort(compareBytes);
  const usedMembers = [...state.usedMembershipIds].map(bytesFromHex).sort(compareBytes);
  const closed = [...state.closedJoins]
    .map((join) => {
      const sep = join.indexOf(':');
      if (sep <= 0) fail('canonical');
      return {
        first: bytesFromHex(join.slice(0, sep)),
        requestId: bytesFromHex(join.slice(sep + 1)),
      };
    })
    .sort((a, b) => compareBytes(a.first, b.first) || compareBytes(a.requestId, b.requestId));
  const history: CborValue[] = [];
  for (let epoch = 0; epoch <= state.epoch.number; epoch++) {
    const row = state.historyPackets.get(epoch);
    if (!row) fail('invalid-operation');
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
      device.canManage,
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
}

export function encodeSnapshotBody(state: InternalState, signer: SigningPublicKey): Uint8Array {
  const head = state.hashes[state.hashes.length - 1];
  if (!head) fail('invalid-operation');
  return encodeSnapshotCbor([
    SNAPSHOT_VERSION,
    copyBytes(state.genesis),
    state.hashes.length,
    copyBytes(head),
    copyBytes(signer),
    encodeAuthState(state),
  ]);
}

export function digestBodyBytes(state: InternalState): Uint8Array {
  const head = state.hashes[state.hashes.length - 1];
  if (!head) fail('invalid-operation');
  return encodeSnapshotCbor([
    SNAPSHOT_VERSION,
    copyBytes(state.genesis),
    state.hashes.length,
    copyBytes(head),
    encodeAuthState(state),
  ]);
}

export function stateDigestOf(state: InternalState): Hash {
  return snapshotStateDigest(digestBodyBytes(state));
}

export function encodeSignedSnapshot(bodyBytes: Uint8Array, signature: Signature): Uint8Array {
  if (signature.byteLength !== SIGNATURE_BYTES) fail('canonical');
  const body = decodeSnapshotCbor(bodyBytes);
  return encodeSnapshotCbor([body, copyBytes(signature)]);
}

export function assertEndorserEligible(state: InternalState, signer: SigningPublicKey): void {
  const device = state.devices.get(keyId(signer));
  if (!device || device.kind !== 'personal' || !device.canManage) fail('unauthorized');
  const member = state.members.get(keyId(device.membershipId));
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) fail('unauthorized');
}

function decodeKeyList(value: CborValue, size: number): Uint8Array[] {
  const list = asArray(value);
  const keys = list.map((item) => asExactBytes(item, size));
  assertSortedUnique(keys);
  return keys;
}

function importAuthState(
  auth: CborValue,
  genesis: Hash,
  length: number,
  head: Hash,
  signer: SigningPublicKey,
  cache?: SigningPointCache
): InternalState {
  const fields = asArray(auth);
  if (fields.length !== 11) fail('canonical');
  const owner = asExactBytes(fields[0]!, MEMBERSHIP_ID_BYTES);
  const members = new Map<string, Member>();
  const userIndex = new Map<string, string>();
  let ownerCount = 0;
  const memberRows = asArray(fields[1]!);
  let lastMember: Uint8Array | undefined;
  for (const row of memberRows) {
    const tuple = asArray(row);
    if (tuple.length !== 3) fail('canonical');
    const membershipId = asExactBytes(tuple[0]!, MEMBERSHIP_ID_BYTES);
    if (lastMember && compareBytes(lastMember, membershipId) >= 0) fail('canonical');
    lastMember = membershipId;
    const userId = asExactBytes(tuple[1]!, USER_ID_BYTES);
    const role = decodeRole(tuple[2]!);
    const membershipHex = keyId(membershipId);
    const userHex = keyId(userId);
    if (members.has(membershipHex) || userIndex.has(userHex)) fail('replay');
    members.set(membershipHex, { userId: copyBytes(userId), role });
    userIndex.set(userHex, membershipHex);
    if (role === 'owner') ownerCount += 1;
  }
  if (ownerCount !== 1) fail('canonical');
  const ownerMember = members.get(keyId(owner));
  if (!ownerMember || ownerMember.role !== 'owner') fail('canonical');

  const devices = new Map<string, Device>();
  let lastDevice: Uint8Array | undefined;
  for (const row of asArray(fields[2]!)) {
    const tuple = asArray(row);
    if (tuple.length !== 5) fail('canonical');
    const signPub = checkSigningPublicKey(asExactBytes(tuple[0]!, SIGNING_KEY_BYTES), cache);
    if (lastDevice && compareBytes(lastDevice, signPub) >= 0) fail('canonical');
    lastDevice = signPub;
    const membershipId = asExactBytes(tuple[1]!, MEMBERSHIP_ID_BYTES);
    const kind = decodeKind(tuple[2]!);
    const enc = checkEncryptionPublicKey(asExactBytes(tuple[3]!, ENCRYPTION_KEY_BYTES));
    const canManage = asBool(tuple[4]!);
    if (!members.has(keyId(membershipId))) fail('canonical');
    devices.set(keyId(signPub), {
      membershipId: copyBytes(membershipId),
      kind,
      encryptionPublicKey: enc,
      canManage,
    });
  }

  const epochNumber = asUint(fields[3]!);
  const epochCommitment = checkHash(asExactBytes(fields[4]!, HASH_BYTES));
  const rotationRequired = asBool(fields[5]!);
  const usedSigningKeys = new Set(decodeKeyList(fields[6]!, SIGNING_KEY_BYTES).map(keyId));
  const usedEncKeys = new Set(decodeKeyList(fields[7]!, ENCRYPTION_KEY_BYTES).map(keyId));
  const usedMembershipIds = new Set(decodeKeyList(fields[8]!, MEMBERSHIP_ID_BYTES).map(keyId));
  const closedJoins = new Set<string>();
  let lastJoinFirst: Uint8Array | undefined;
  let lastJoinReq: Uint8Array | undefined;
  for (const row of asArray(fields[9]!)) {
    const tuple = asArray(row);
    if (tuple.length !== 2) fail('canonical');
    const first = checkSigningPublicKey(asExactBytes(tuple[0]!, SIGNING_KEY_BYTES), cache);
    const requestId = asExactBytes(tuple[1]!, REQUEST_ID_BYTES);
    if (lastJoinFirst) {
      const cmp = compareBytes(lastJoinFirst, first);
      if (cmp > 0 || (cmp === 0 && lastJoinReq && compareBytes(lastJoinReq, requestId) >= 0)) {
        fail('canonical');
      }
    }
    lastJoinFirst = first;
    lastJoinReq = requestId;
    closedJoins.add(joinKey(first, requestId));
  }

  const historyRows = asArray(fields[10]!);
  if (historyRows.length !== epochNumber + 1) fail('canonical');
  const historyPackets = new Map<number, HistoryPacketRow>();
  const usedCommitments = new Set<string>();
  for (let epoch = 0; epoch <= epochNumber; epoch++) {
    const tuple = asArray(historyRows[epoch]!);
    if (tuple.length !== 3) fail('canonical');
    if (asUint(tuple[0]!) !== epoch) fail('canonical');
    const commitment = checkHash(asExactBytes(tuple[1]!, HASH_BYTES));
    const packet = tuple[2];
    if (!(packet instanceof Uint8Array)) fail('canonical');
    if (epoch === 0) {
      if (packet.byteLength !== 0) fail('canonical');
    } else if (packet.byteLength !== HISTORY_PACKET_BYTES) {
      fail('canonical');
    }
    if (usedCommitments.has(keyId(commitment))) fail('replay');
    usedCommitments.add(keyId(commitment));
    historyPackets.set(epoch, { commitment, packet: copyBytes(packet) });
  }
  const latest = historyPackets.get(epochNumber);
  if (!latest || !bytesEqual(latest.commitment, epochCommitment)) fail('canonical');

  for (const [id, device] of devices) {
    if (!usedSigningKeys.has(id)) fail('canonical');
    if (!usedEncKeys.has(keyId(device.encryptionPublicKey))) fail('canonical');
    if (!usedMembershipIds.has(keyId(device.membershipId))) fail('canonical');
  }
  for (const id of members.keys()) {
    if (!usedMembershipIds.has(id)) fail('canonical');
  }

  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SNAPSHOT_ARRAY_LENGTH) {
    fail('oversize');
  }
  const genesisEqHead = bytesEqual(genesis, head);
  if ((length === 1) !== genesisEqHead) fail('canonical');

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
  assertEndorserEligible(state, signer);
  return state;
}

export function parseSignedSnapshot(
  bytes: Uint8Array,
  cache?: SigningPointCache
): {
  bodyBytes: Uint8Array;
  signature: Signature;
  genesis: Hash;
  length: number;
  head: Hash;
  signer: SigningPublicKey;
  auth: CborValue;
} {
  const root = asArray(decodeSnapshotCbor(bytes));
  if (root.length !== 2) fail('canonical');
  const body = asArray(root[0]!);
  if (body.length !== 6) fail('canonical');
  if (asUint(body[0]!) !== SNAPSHOT_VERSION) fail('unknown-version');
  const genesis = checkHash(asExactBytes(body[1]!, HASH_BYTES));
  const length = asUint(body[2]!);
  if (length < 1 || length > MAX_SNAPSHOT_ARRAY_LENGTH) fail('oversize');
  const head = checkHash(asExactBytes(body[3]!, HASH_BYTES));
  const signer = checkSigningPublicKey(asExactBytes(body[4]!, SIGNING_KEY_BYTES), cache);
  const signature = asExactBytes(root[1]!, SIGNATURE_BYTES);
  return {
    bodyBytes: encodeSnapshotCbor(body),
    signature,
    genesis,
    length,
    head,
    signer,
    auth: body[5]!,
  };
}

export function snapshotStateFromParsed(
  parsed: ReturnType<typeof parseSignedSnapshot>,
  cache?: SigningPointCache
): InternalState {
  return importAuthState(
    parsed.auth,
    parsed.genesis,
    parsed.length,
    parsed.head,
    parsed.signer,
    cache
  );
}

export function decodeSignedSnapshot(
  bytes: Uint8Array,
  cache?: SigningPointCache
): {
  bodyBytes: Uint8Array;
  signature: Signature;
  genesis: Hash;
  length: number;
  head: Hash;
  signer: SigningPublicKey;
  state: InternalState;
} {
  const parsed = parseSignedSnapshot(bytes, cache);
  const state = importAuthState(
    parsed.auth,
    parsed.genesis,
    parsed.length,
    parsed.head,
    parsed.signer,
    cache
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
