import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(path.join(workerData.directory, 'worker.sqlite3'));
try {
  db.exec('create table probe(value integer); insert into probe values(1)');
  if (db.prepare('select value from probe').get().value !== 1)
    throw new Error('Worker binding probe failed');
} finally {
  db.close();
}
require('@loro-dev/roost-node/native');
const { LoroDoc } = require('loro-crdt');
new LoroDoc().getText('probe').insert(0, 'ok');
parentPort.postMessage('ok');
