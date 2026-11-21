/**
 * Shared fixture for the native engine keyring equality test and its vector generator.
 * Byte equality between this package's Loro Streams content binding (the
 * product seal/open path) and the native loro-repo-rs engine keyring
 * (`ContentKeyring`), in both directions. Room AAD comes from the product
 * encoder, `loro-repo`'s `encodeStreamsRoomAdditionalData`, and the core
 * resource names follow `encryptedWorkspaceRoom` in `@lody/shared`.
 * Native engine cloud/E2EE Spec, phase 0: specs/native-engine-cloud-e2ee.md.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { ContentKeyring } from '@loro-dev/loro-repo-engine';
import { encodeStreamsRoomAdditionalData } from 'loro-repo/transport/streams';
import { Effect, Result } from 'effect';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import * as Ledger from '@lody/e2ee-core/protocol';
import * as EpochKeys from '@lody/e2ee-core/protocol';
import { Bytes, type ContentScope } from '@lody/e2ee-core/protocol';
import type * as Signing from '@lody/e2ee-core/protocol';
import { encodeCbor, type CborValue } from '../src/internal/foundation/cbor';
import { disposeEpochKey } from '../src/internal/foundation/epoch-key';

export const read = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);
export const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
export const EPOCH0 = new Uint8Array(32).fill(7);
export const EPOCH1 = new Uint8Array(32).fill(8);
export const ENGINE_NAMESPACE = 'ws-native-keyring';

export function identity(seed: number) {
  const seedBytes = new Uint8Array(32).fill(seed);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedBytes]),
    format: 'der',
    type: 'pkcs8',
  });
  const raw = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const signBytes = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
  const signer: Signing.DeviceSigner = {
    publicKey: read(Bytes.signingPublicKey(raw)),
    sign: (message) => Effect.succeed(read(Bytes.signature(signBytes(message)))),
  };
  return { seed: seedBytes, raw, signBytes, signer };
}

/** A genuine signed ledger: owner genesis at epoch 0, then optional phone, rotation, revocation. */
export function workspace() {
  const owner = identity(1),
    phone = identity(2);
  const tag = (name: string, payload: Uint8Array) =>
    new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
  const record = (body: readonly CborValue[]) =>
    read(encodeCbor([body, owner.signBytes(tag('sig/v1', read(encodeCbor(body))))]));
  const rows = [
    record([
      1,
      owner.raw,
      new Uint8Array(32).fill(10),
      new Uint8Array(16).fill(10),
      new Uint8Array(32).fill(100),
      read(
        EpochKeys.commitEpochKey(
          read(Bytes.genesisHash(new Uint8Array(32))),
          0,
          read(Bytes.epochKey(EPOCH0))
        )
      ).toBytes(),
    ]),
  ];
  const anchor = read(Bytes.genesisHash(Ledger.hashRecordBytes(rows[0]!).toBytes()));
  const view = () =>
    read(
      Ledger.verifyLedger({
        anchor,
        records: rows,
        checkpoint: { head: Ledger.hashRecordBytes(rows.at(-1)!), length: rows.length },
      })
    );
  const append = (op: readonly CborValue[]) =>
    rows.push(record([Ledger.hashRecordBytes(rows.at(-1)!).toBytes(), owner.raw, op]));
  const addPhone = () => {
    const enc = new Uint8Array(32).fill(102);
    const proof = phone.signBytes(
      tag(
        'possess/v2',
        read(encodeCbor([anchor.toBytes(), new Uint8Array(16).fill(10), phone.raw, enc, 0]))
      )
    );
    append([4, 0, phone.raw, enc, proof]);
  };
  const rotate = () => {
    const previousKey = read(Bytes.epochKey(EPOCH0));
    const currentKey = read(Bytes.epochKey(EPOCH1));
    try {
      append([
        7,
        1,
        read(EpochKeys.commitEpochKey(anchor, 1, currentKey)).toBytes(),
        read(EpochKeys.sealHistoryPacket({ genesis: anchor, epoch: 1, currentKey, previousKey })),
      ]);
    } finally {
      disposeEpochKey(previousKey);
      disposeEpochKey(currentKey);
    }
  };
  const revokePhone = () => append([5, phone.raw]);
  const genesisHex = hex(anchor.toBytes());
  /** The installed engine keyring, as main or the daemon would configure it. */
  const keyring = (writer = owner, epochs: readonly Uint8Array[] = [EPOCH0]) => {
    const k = new ContentKeyring();
    k.configureNamespace(ENGINE_NAMESPACE, anchor.toBytes());
    k.configureWriterSigner(ENGINE_NAMESPACE, 'self', writer.seed);
    for (const admitted of [owner, phone]) k.admitWriterPubkey(ENGINE_NAMESPACE, admitted.raw);
    epochs.forEach((secret, epoch) => k.installEpochKey(ENGINE_NAMESPACE, epoch, secret));
    return k;
  };
  return { owner, phone, anchor, genesisHex, view, addPhone, rotate, revokePhone, keyring };
}

export type Room =
  | { readonly kind: 'doc'; readonly docId: string }
  | { readonly kind: 'flock'; readonly flockDocId: string }
  | { readonly kind: 'meta' };
export const engineRoom = (room: Room) =>
  room.kind === 'doc'
    ? { kind: 'loro_doc' as const, id: room.docId }
    : room.kind === 'flock'
      ? { kind: 'flock' as const, id: room.flockDocId }
      : { kind: 'meta' as const, id: 'meta' };
/** Product resources (`encryptedWorkspaceRoom`). */
export const coreRoom = (room: Room) =>
  room.kind === 'doc'
    ? { resource: `doc:${room.docId}`, model: 'loro' as const }
    : room.kind === 'flock'
      ? { resource: `flock:${room.flockDocId}`, model: 'flock' as const }
      : { resource: 'meta', model: 'flock' as const };

export type Kind =
  | { readonly kind: 'update_batch' }
  | { readonly kind: 'snapshot'; readonly offset: string };
export const context = (k: Kind) =>
  k.kind === 'snapshot'
    ? ({
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'snapshot',
        continuationOffset: k.offset,
      } as const)
    : ({
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      } as const);
/** streams-crdt LSCE v2 envelope AAD: domain, the 10-byte prefix, then the provider header. */
export const envelopeAad = (k: Kind, header: Uint8Array) =>
  new Uint8Array([
    ...Buffer.from('loro-streams-crdt-payload-protection/v2\0'),
    ...Buffer.from('LSCE'),
    2,
    k.kind === 'snapshot' ? 2 : 1,
    0,
    header.byteLength,
    0,
    0,
    ...header,
  ]);
export const headerFor = (k: Kind) => new Uint8Array([k.kind === 'snapshot' ? 4 : 3]);

export function aad(f: ReturnType<typeof workspace>, room: Room, k: Kind) {
  const namespace = `lody-e2ee:${f.genesisHex}`;
  const envelope = envelopeAad(k, headerFor(k));
  const full = encodeStreamsRoomAdditionalData(namespace, room, envelope);
  return { full, contextAad: full.subarray(0, full.byteLength - 4 - envelope.byteLength) };
}

export const core = (
  f: ReturnType<typeof workspace>,
  room: Room,
  signer = f.owner.signer,
  writeEpoch: number | 'current' = 'current'
) =>
  makeStreamsUpdateBinding({
    genesis: f.anchor,
    ...coreRoom(room),
    writeEpoch,
    signer,
    ledger: () => Effect.succeed(f.view()),
    readEpochKey: (epoch) => Effect.sync(() => read(Bytes.epochKey(epoch === 0 ? EPOCH0 : EPOCH1))),
  });

export const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
export const offset = (k: Kind) => (k.kind === 'snapshot' ? k.offset : null);

export function engineSeal(
  k: ContentKeyring,
  f: ReturnType<typeof workspace>,
  room: Room,
  kind: Kind
) {
  return k.seal({
    namespace: ENGINE_NAMESPACE,
    room: engineRoom(room),
    payloadKind: kind.kind,
    writer: 'self',
    continuationOffset: offset(kind),
    contextAad: aad(f, room, kind).contextAad,
    plaintext,
  });
}
export function engineOpen(
  k: ContentKeyring,
  f: ReturnType<typeof workspace>,
  room: Room,
  kind: Kind,
  sealed: { header: Uint8Array; sealed: Uint8Array },
  additionalData = aad(f, room, kind).full
) {
  return k.open({
    namespace: ENGINE_NAMESPACE,
    room: engineRoom(room),
    payloadKind: kind.kind,
    continuationOffset: offset(kind),
    header: sealed.header,
    sealed: sealed.sealed,
    additionalData,
  });
}
export const coreSeal = (
  f: ReturnType<typeof workspace>,
  room: Room,
  kind: Kind,
  signer = f.owner.signer
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binding = yield* core(f, room, signer);
        return yield* binding.seal({
          context: context(kind),
          plaintext,
          additionalData: () => aad(f, room, kind).full,
        });
      })
    )
  );
export const coreOpen = (
  f: ReturnType<typeof workspace>,
  room: Room,
  kind: Kind,
  sealed: { header: Uint8Array; sealed: Uint8Array },
  additionalData = aad(f, room, kind).full
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binding = yield* core(f, room);
        return yield* binding.open({ ...sealed, context: context(kind), additionalData });
      })
    )
  );
export const epochOf = (sealed: Uint8Array) =>
  new DataView(sealed.buffer, sealed.byteOffset).getUint32(1);

export const rooms: ReadonlyArray<readonly [string, Room]> = [
  ['Loro doc', { kind: 'doc', docId: 'session-0001' }],
  ['Flock', { kind: 'flock', flockDocId: 'ws-native-keyring:wf:workspace' }],
  ['Meta', { kind: 'meta' }],
];
export const kinds: ReadonlyArray<readonly [string, Kind]> = [
  ['update', { kind: 'update_batch' }],
  ['snapshot', { kind: 'snapshot', offset: '0_123' }],
];
export const matrix = rooms.flatMap(([roomName, room]) =>
  kinds.map(([kindName, kind]) => [`${roomName} ${kindName}`, room, kind] as const)
);
