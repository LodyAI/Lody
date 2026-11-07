async function main() {
  // Injected SEA entry. The build tool prefixes `codec`; no runtime dependencies.
  const fs = require('node:fs');
  const path = require('node:path');
  const sea = require('node:sea');
  const { createRequire } = require('node:module');
  const metadata = JSON.parse(Buffer.from(sea.getAsset('metadata')).toString());
  if (metadata.format !== 1 || metadata.platform !== `${process.platform}-${process.arch}`)
    throw new Error('SEA platform mismatch');
  const dataDir = profile.getLodyDataDir();
  const root = path.join(dataDir, 'daemon-managed');
  const releaseDir = path.join(root, 'payloads', metadata.payloadSha256);
  function extract() {
    const payload = Buffer.from(sea.getAsset('payload'));
    if (codec.digest(payload) !== metadata.payloadSha256) throw new Error('SEA payload mismatch');
    fs.mkdirSync(path.dirname(releaseDir), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(releaseDir, '.complete'))) {
      const tmp = fs.mkdtempSync(releaseDir + '.stage-');
      try {
        codec.unpack(payload, tmp);
        fs.writeFileSync(path.join(tmp, '.complete'), metadata.payloadSha256, {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        try {
          fs.renameSync(tmp, releaseDir);
        } catch (error) {
          if (!fs.existsSync(path.join(releaseDir, '.complete'))) throw error;
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    codec.verifyTree(payload, releaseDir);
  }
  extract();
  if (process.argv[2] === '__sea-extract') {
    process.stdout.write(JSON.stringify({ releaseDir, metadata }) + '\n');
  } else {
    const nodePath = path.join(
      root,
      'nodes',
      metadata.node.sha256,
      process.platform === 'win32' ? 'node.exe' : 'node'
    );
    if (process.argv[2] === '__sea-install-node') {
      const { gunzipSync } = require('node:zlib');
      const input = gunzipSync(fs.readFileSync(process.argv[3]), {
        maxOutputLength: metadata.node.size,
      });
      if (input.length !== metadata.node.size || codec.digest(input) !== metadata.node.sha256)
        throw new Error('Installer Node identity mismatch');
      fs.mkdirSync(path.dirname(nodePath), { recursive: true, mode: 0o700 });
      const tmp = nodePath + '.' + require('node:crypto').randomUUID() + '.tmp';
      fs.writeFileSync(tmp, input, { flag: 'wx', mode: 0o700, flush: true });
      fs.renameSync(tmp, nodePath);
      process.stdout.write('Managed Node installed. Run this executable with daemon install.\n');
    } else {
      // A SEA is never silently used as a generic Node or replaced by PATH lookup.
      if (
        process.argv[2] === 'daemon' &&
        process.argv[3] === 'install' &&
        !fs.existsSync(nodePath)
      ) {
        const base = profile.resolveRuntimeArtifactsBaseUrl(process.env.LODY_RUNTIME_BASE_URL);
        const url = `${base}/api/runtimes/${metadata.distribution}/${metadata.version}/${metadata.platform}/node.gz`;
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok || !response.body)
          throw new Error('Managed Node download failed: ' + response.status);
        const reader = response.body.getReader(),
          chunks = [];
        let size = 0;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            if (size > metadata.node.archiveSize) throw new Error('Oversized managed Node archive');
            chunks.push(item.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const compressed = Buffer.concat(chunks);
        if (
          size !== metadata.node.archiveSize ||
          codec.digest(compressed) !== metadata.node.archiveSha256
        )
          throw new Error('Managed Node archive mismatch');
        const bytes = require('node:zlib').gunzipSync(compressed, {
          maxOutputLength: metadata.node.size,
        });
        if (bytes.length !== metadata.node.size || codec.digest(bytes) !== metadata.node.sha256)
          throw new Error('Managed Node executable mismatch');
        fs.mkdirSync(path.dirname(nodePath), { recursive: true, mode: 0o700 });
        const tmp = nodePath + '.' + require('node:crypto').randomUUID() + '.tmp';
        fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o700, flush: true });
        fs.renameSync(tmp, nodePath);
      }
      const nodeBytes = fs.readFileSync(nodePath);
      if (
        nodeBytes.length !== metadata.node.size ||
        codec.digest(nodeBytes) !== metadata.node.sha256
      )
        throw new Error('Managed Node is missing or corrupt; run daemon installation');
      const probing = process.argv[2] === '__sea-native-probe';
      const entry = path.join(releaseDir, probing ? '__managed-probe.mjs' : 'index.js');
      globalThis[Symbol.for('lody.sea.context')] = Object.freeze({
        metadata,
        nodePath,
        releaseDir,
        capsulePath: process.execPath,
      });
      process.argv[1] = entry;
      // Import from a real module so relative imports/native bindings/Workers retain layout.
      const bootstrap = path.join(releaseDir, probing ? '__sea-probe.cjs' : '__sea-entry.cjs');
      const entrySource =
        'module.exports=import(' +
        JSON.stringify(probing ? './__managed-probe.mjs' : './index.js') +
        ');\n';
      if (!fs.existsSync(bootstrap))
        fs.writeFileSync(bootstrap, entrySource, { flag: 'wx', mode: 0o600, flush: true });
      if (fs.readFileSync(bootstrap, 'utf8') !== entrySource)
        throw new Error('SEA bootstrap is corrupt');
      createRequire(bootstrap)(bootstrap).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
