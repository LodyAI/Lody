/**
 * Writes frames sealed by the real `@lody/e2ee-core` Loro Streams binding, with the
 * product room AAD, for the native engine keyring's fixed-vector test in loro-repo:
 *   tsx test/generate-native-keyring-vector.mts > lody-e2ee-core-content-v0.json
 * Nonces are random, so each run produces different but equally valid frames.
 */
import {
  EPOCH0,
  EPOCH1,
  aad,
  coreSeal,
  engineRoom,
  hex,
  matrix,
  offset,
  plaintext,
  workspace,
  type Kind,
  type Room,
} from './native-engine-keyring-fixture';

const f = workspace();
const entry = async (name: string, room: Room, kind: Kind, epoch: number) => {
  const sealed = await coreSeal(f, room, kind);
  const { full, contextAad } = aad(f, room, kind);
  return {
    name,
    room: engineRoom(room),
    payload_kind: kind.kind,
    continuation_offset: offset(kind),
    epoch,
    context_aad_hex: hex(contextAad),
    additional_data_hex: hex(full),
    header_hex: hex(sealed.header),
    sealed_hex: hex(sealed.sealed),
  };
};
const cases = [];
for (const [name, room, kind] of matrix) cases.push(await entry(name, room, kind, 0));
f.rotate();
cases.push(await entry('Loro doc update after rotation', matrix[0]![1], matrix[0]![2], 1));
process.stdout.write(
  `${JSON.stringify(
    {
      generator: 'LodyAI/Lody packages/e2ee-core/test/generate-native-keyring-vector.mts',
      genesis_hex: f.genesisHex,
      epoch_keys_hex: [hex(EPOCH0), hex(EPOCH1)],
      signer_public_key_hex: hex(f.owner.raw),
      plaintext_hex: hex(plaintext),
      cases,
    },
    null,
    2
  )}\n`
);
