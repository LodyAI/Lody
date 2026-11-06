#!/usr/bin/env node
// Run AFTER platform signing/notarization. Freeze these exact bytes for all retries.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const privateKey = createPrivateKey(process.env.LODY_DAEMON_RELEASE_PRIVATE_KEY ?? '');
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 signing key');
const metadata = JSON.parse(fs.readFileSync(config.capsule + '.metadata.json', 'utf8'));
if (!/^[a-f0-9]{40}$/.test(config.source)) throw new Error('Expected full source SHA');
const trusted = metadata.keys[config.keyId];
if (
  !trusted ||
  !createPublicKey(trusted)
    .export({ type: 'spki', format: 'der' })
    .equals(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))
)
  throw new Error('Signing key differs from embedded trust');
function artifact(input, name) {
  const raw = fs.readFileSync(input),
    compressed = gzipSync(raw, { level: 9 });
  fs.writeFileSync(path.join(config.outputDir, name), compressed, { flag: 'wx' });
  const digest = (b) => createHash('sha256').update(b).digest('hex');
  return {
    file: name,
    sha256: digest(compressed),
    size: compressed.length,
    contentSha256: digest(raw),
    contentSize: raw.length,
  };
}
fs.mkdirSync(config.outputDir, { recursive: true });
const manifest = {
  format: 1,
  product: metadata.product,
  distribution: metadata.distribution,
  version: metadata.version,
  channel: metadata.channel,
  platform: metadata.platform,
  serviceProtocol: 1,
  dataFormat: 1,
  source: config.source,
  payloadSha256: metadata.payloadSha256,
  nodeVersion: metadata.node.version,
  capsule: artifact(config.capsule, 'daemon.gz'),
  node: artifact(config.node, 'node.gz'),
};
// Node must be signed before build: changing it later invalidates the embedded identity.
if (
  manifest.node.contentSha256 !== metadata.node.sha256 ||
  manifest.node.sha256 !== metadata.node.archiveSha256 ||
  manifest.node.size !== metadata.node.archiveSize
)
  throw new Error('Node changed after SEA build');
const payload = JSON.stringify(manifest);
const envelope = {
  keyId: config.keyId,
  payload,
  signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
};
fs.writeFileSync(path.join(config.outputDir, 'manifest.json'), JSON.stringify(envelope) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    version: manifest.version,
    platform: manifest.platform,
    capsule: manifest.capsule,
    node: manifest.node,
  })
);
