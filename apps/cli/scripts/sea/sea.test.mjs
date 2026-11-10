import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url),
  { pack, unpack } = require('./payload.cjs');
const scripts = path.dirname(fileURLToPath(import.meta.url));
test('SEA retains a relocated Worker and runs external JS with managed Node while PATH contains no node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-sea-artifact-'));
  try {
    const staging = path.join(root, 'stage');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      path.join(staging, 'worker.js'),
      `import {parentPort} from 'node:worker_threads'; parentPort.postMessage('worker-ok');`
    );
    fs.writeFileSync(
      path.join(staging, 'index.js'),
      `import {Worker} from 'node:worker_threads'; import{execFileSync}from'node:child_process'; const context=globalThis[Symbol.for('lody.sea.context')]; const child=execFileSync(context.nodePath,['--input-type=module','-e','process.stdout.write("external-js-ok")'],{encoding:'utf8'}); const worker=new Worker(new URL('./worker.js',import.meta.url)); worker.on('message',value=>console.log(JSON.stringify({child,worker:value})));`
    );
    const capsule = path.join(root, 'daemon');
    const config = {
      staging,
      output: capsule,
      node: process.execPath,
      product: 'lody-oss',
      version: '1.2.3',
      channel: 'stable',
      platform: `${process.platform}-${process.arch}`,
    };
    const file = path.join(root, 'build.json');
    fs.writeFileSync(file, JSON.stringify(config));
    execFileSync(process.execPath, [path.join(scripts, 'build.mjs'), file], { stdio: 'pipe' });
    if (process.platform === 'darwin')
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', capsule]);
    const env = {
      ...process.env,
      LODY_DATA_DIR: path.join(root, 'data'),
      PATH: path.join(root, 'empty-path'),
    };
    const nodeGz = path.join(root, 'node.gz');
    fs.writeFileSync(nodeGz, gzipSync(fs.readFileSync(process.execPath)));
    execFileSync(capsule, ['__sea-install-node', nodeGz], { env });
    for (let n = 0; n < 2; n++) {
      const result = JSON.parse(execFileSync(capsule, [], { env, encoding: 'utf8' }).trim());
      assert.deepEqual(result, { child: 'external-js-ok', worker: 'worker-ok' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('SEA packing refuses symlinks and extraction preserves native bytes and refuses traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-sea-files-'));
  try {
    const src = path.join(root, 'src'),
      out = path.join(root, 'out');
    fs.mkdirSync(src);
    fs.mkdirSync(out);
    const native = Buffer.from([0, 1, 255, 2]);
    fs.writeFileSync(path.join(src, 'binding.node'), native);
    unpack(pack(src), out);
    assert.deepEqual(fs.readFileSync(path.join(out, 'binding.node')), native);
    fs.symlinkSync(path.join(src, 'binding.node'), path.join(src, 'alias'));
    assert.throws(() => pack(src), /real files/);
    const header = Buffer.from(
      JSON.stringify({
        format: 1,
        files: [{ path: '../outside', offset: 0, size: 0, mode: 420, sha256: 'bad' }],
      })
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    assert.throws(() => unpack(gzipSync(Buffer.concat([size, header])), out), /Unsafe/);
    assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
