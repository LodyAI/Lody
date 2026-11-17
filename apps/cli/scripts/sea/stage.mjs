#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const staging = path.resolve(config.staging);
const source = path.resolve(config.dist);
if (staging === source || source.startsWith(staging + path.sep))
  throw new Error('Staging must not contain source');
if (fs.existsSync(staging)) throw new Error('SEA staging directory must be new');
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(source, staging, {
  recursive: true,
  dereference: true,
  filter: (file) => !file.endsWith('.map'),
});
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify({ type: 'module', version: config.version })
);
process.env.LODY_CLI_SOURCE_ROOT = path.resolve(config.cliRoot);
process.env.LODY_CLI_STAGING_DIR = staging;
const native = await import(
  new URL('../../../electron/scripts/cli-native-deps.mjs', import.meta.url)
);
native.stageCliRuntimePackages();
const target = { platform: process.platform, arch: process.arch };
native.installEmbeddedSqliteBinding(target);
native.installEmbeddedRoostBinding(target);
native.installEmbeddedKeyringBinding(target);
native.installEmbeddedNodePtyBinding(target);
// Runtime JS dependencies in addition to the embedded desktop's native closure.
const { createRequire } = await import('node:module');
const require = createRequire(path.join(path.resolve(config.cliRoot), 'package.json'));
for (const name of ['ignore', 'typescript']) {
  const packageFile = require.resolve(`${name}/package.json`);
  fs.cpSync(path.dirname(packageFile), path.join(staging, 'node_modules', name), {
    recursive: true,
    dereference: true,
  });
}
fs.copyFileSync(
  fileURLToPath(new URL('./probe.mjs', import.meta.url)),
  path.join(staging, '__managed-probe.mjs')
);
fs.copyFileSync(
  fileURLToPath(new URL('./probe-worker.mjs', import.meta.url)),
  path.join(staging, '__managed-probe-worker.mjs')
);
console.log(JSON.stringify({ staging, target, script: fileURLToPath(import.meta.url) }));
