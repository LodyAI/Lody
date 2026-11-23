// Synthetic interoperability fixture. Run manually; tests only read the fixed JSON.
// This minimal CBOR encoder does not import the production DAG-CBOR implementation.
import { createCipheriv } from 'node:crypto';

const head = (major, length) => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length <= 255) return Buffer.from([(major << 5) | 24, length]);
  throw new Error('Fixture encoder supports short values only');
};
const cbor = (value) => {
  if (typeof value === 'number') return head(0, value);
  if (typeof value === 'string') {
    const utf8 = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, utf8.length), utf8]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  throw new Error('Unsupported fixture value');
};
const range = (start, count) => Buffer.from(Array.from({ length: count }, (_, i) => start + i));
const kek = range(0, 32);
const binding = {
  accountId: 'fixture-account/用户',
  workspaceId: 'fixture-workspace',
  genesisHex: range(32, 32).toString('hex'),
  deviceHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  installationId: range(64, 32).toString('hex'),
};
const purposes = [
  'signing-private-key',
  'encryption-private-key',
  'device-credential',
  'installed-epoch-key',
  'rotation-candidate',
];
const vectors = purposes.map((purpose, index) => {
  // Distinct nonce under the same fixture KEK, even though inputs are public.
  const nonce = range(96 + index * 12, 12);
  const plaintext = range(160 + index, 32);
  const aad = cbor([
    'lody-e2ee/client-custody/v1\0',
    1,
    binding.accountId,
    binding.workspaceId,
    Buffer.from(binding.genesisHex, 'hex'),
    Buffer.from(binding.deviceHex, 'hex'),
    binding.installationId,
    purpose,
  ]);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    purpose,
    nonceHex: nonce.toString('hex'),
    plaintextHex: plaintext.toString('hex'),
    aadHex: aad.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    tagHex: tag.toString('hex'),
    blobHex: Buffer.concat([Buffer.from([1]), nonce, ciphertext, tag]).toString('hex'),
  };
});
process.stdout.write(
  JSON.stringify(
    {
      source:
        'Independent minimal canonical CBOR encoder; node:crypto/OpenSSL AES-256-GCM. Public synthetic inputs only. Cross-checked by pinned @ipld/dag-cbor, WebCrypto and noble AES-GCM.',
      version: 1,
      domainUtf8Hex: Buffer.from('lody-e2ee/client-custody/v1\0').toString('hex'),
      kekHex: kek.toString('hex'),
      binding,
      vectors,
    },
    null,
    2
  ) + '\n'
);
