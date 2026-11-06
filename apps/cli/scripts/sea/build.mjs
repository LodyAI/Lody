#!/usr/bin/env node
// Build only. Signing/final manifest publication are deliberately separate steps.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { pack, digest } = require('./payload.cjs');
const ownDir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (process.versions.node !== '26.13.0') throw new Error('SEA build requires pinned Node 26.13.0');
if (
  !['lody-oss', 'lody-cloud'].includes(config.product) ||
  !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(config.version) ||
  !['stable', 'next', 'nightly'].includes(config.channel)
)
  throw new Error('Invalid SEA product/version/channel');
if (config.platform !== `${process.platform}-${process.arch}`)
  throw new Error('Build SEA on its target platform');
const distribution = config.distribution ?? `${config.product}-daemon`;
if (!/^[a-z][a-z0-9-]{0,79}$/.test(distribution)) throw new Error('Invalid artifact distribution');
const staging = path.resolve(config.staging),
  output = path.resolve(config.output);
if (!fs.statSync(path.join(staging, 'index.js')).isFile())
  throw new Error('Stage the complete CLI first');
const node = path.resolve(config.node),
  nodeBytes = fs.readFileSync(node);
const outputDir = path.dirname(output);
fs.mkdirSync(outputDir, { recursive: true });
const payload = pack(staging);
const nodeArchive = (await import('node:zlib')).gzipSync(nodeBytes, { level: 9 });
const metadata = {
  format: 1,
  product: config.product,
  distribution,
  version: config.version,
  channel: config.channel,
  platform: config.platform,
  serviceProtocol: 1,
  payloadSha256: digest(payload),
  node: {
    sha256: digest(nodeBytes),
    size: nodeBytes.length,
    version: '26.13.0',
    archiveSha256: digest(nodeArchive),
    archiveSize: nodeArchive.length,
  },
};
const metadataPath = output + '.metadata.json',
  payloadPath = output + '.payload.gz';
fs.writeFileSync(metadataPath, JSON.stringify(metadata));
fs.writeFileSync(payloadPath, payload);
// Bundle the bootstrap's tiny local codec so there are no build-machine paths.
const codec = fs.readFileSync(path.join(ownDir, 'payload.cjs'), 'utf8');
const bootstrap = fs.readFileSync(path.join(ownDir, 'bootstrap.cjs'), 'utf8');
const main = output + '.bootstrap.cjs';
const esbuild = require('esbuild');
const profileSource = path.resolve(
  ownDir,
  '../../../../packages/shared/src/node/installation-profile.ts'
);
const artifactsSource = path.resolve(
  ownDir,
  '../../../../packages/platform/src/runtime-artifacts.ts'
);
const profileBundle = esbuild.buildSync({
  stdin: {
    contents: `export { getLodyDataDir } from ${JSON.stringify(profileSource)}; export { resolveRuntimeArtifactsBaseUrl } from ${JSON.stringify(artifactsSource)};`,
    resolveDir: ownDir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  define: {
    'process.env.LODY_PLATFORM': JSON.stringify(config.product === 'lody-oss' ? 'local' : 'cloud'),
  },
}).outputFiles[0].text;
fs.writeFileSync(
  main,
  `const profile=(()=>{const module={exports:{}};${profileBundle}\nreturn module.exports;})();\nconst codec=(()=>{const module={exports:{}};${codec}\nreturn module.exports;})();\n${bootstrap}`
);
const seaConfig = output + '.sea.json';
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main,
    executable: node,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'cli',
    assets: { metadata: metadataPath, payload: payloadPath },
  })
);
execFileSync(node, ['--build-sea', seaConfig], { stdio: 'inherit' });
fs.chmodSync(output, 0o755);
console.log(JSON.stringify({ output, metadata, rawBytes: fs.statSync(output).size }));
