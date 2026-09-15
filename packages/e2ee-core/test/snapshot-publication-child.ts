import { writeSync } from 'node:fs';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ContentCipher } from '../src/content';
import { createContentSnapshotPublication } from '../src/snapshot-admission';
import { SqliteSnapshotPublicationStore } from '../src/node-snapshot-publication-store';

const [path, mode, encoded] = process.argv.slice(2);
if (!path || !mode || !encoded) throw new Error('missing arguments');
const input = JSON.parse(encoded);
const body = new Uint8Array(Buffer.from(input.body, 'base64'));
const hold = (state: string) => {
  writeSync(1, `${state}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (mode === 'exclusive-lock') {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN EXCLUSIVE');
    const released = once(process, 'message');
    writeSync(1, 'locked\n');
    await released;
    db.exec('ROLLBACK');
  } finally {
    db.close();
    process.disconnect();
  }
} else if (mode === 'before-commit' || mode === 'after-commit') {
  const store = new SqliteSnapshotPublicationStore(path);
  store.transaction(input.streamKey, (tx) => {
    tx.save({ offset: input.offset, body });
    if (mode === 'before-commit') hold('staged');
  });
  hold('committed');
} else if (mode === 'admit') {
  try {
    const host = createContentSnapshotPublication({
      store: new SqliteSnapshotPublicationStore(path),
      cipher: new ContentCipher({ authorize: () => input.submittingDevice }),
      now: () => 1000,
      mayWriteDocument: () => true,
    });
    const result = await host.admit({ ...input, body });
    writeSync(1, `${result.status}\n`);
  } catch (error) {
    writeSync(1, `${error instanceof Error ? error.message : 'unknown'}\n`);
  }
} else throw new Error('unknown mode');
