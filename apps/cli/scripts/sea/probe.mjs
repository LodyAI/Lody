// Runs only against a staged release, with an isolated data directory.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-native-probe-'));
try {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(directory, 'probe.sqlite3'));
  try {
    db.exec("create table probe(value text); insert into probe values ('ok')");
    if (db.prepare('select value from probe').get().value !== 'ok')
      throw new Error('SQLite probe failed');
  } finally {
    db.close();
  }
  const keyring = require('@napi-rs/keyring');
  if (typeof keyring.AsyncEntry !== 'function') throw new Error('Keyring binding unavailable');
  if (typeof require('@lydell/node-pty').spawn !== 'function')
    throw new Error('PTY binding unavailable');
  require('@loro-dev/roost-node/native');
  const { LoroDoc } = require('loro-crdt');
  const doc = new LoroDoc();
  doc.getText('probe').insert(0, 'ok');
  if (doc.getText('probe').toString() !== 'ok') throw new Error('Loro WASM probe failed');
  const worker = new Worker(new URL('./__managed-probe-worker.mjs', import.meta.url), {
    workerData: { directory },
  });
  await new Promise((resolve, reject) => {
    let ready = false;
    worker.once('message', (value) => {
      ready = value === 'ok';
    });
    worker.once('error', reject);
    worker.once('exit', (code) =>
      code === 0 && ready ? resolve() : reject(new Error('Native Worker probe failed'))
    );
  });
  console.log(
    JSON.stringify({ ok: true, node: process.versions.node, napi: process.versions.napi })
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
