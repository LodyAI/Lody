import { createRequire } from 'node:module';
const { LoroDoc } = createRequire(
  new URL('.work/js/package.json', import.meta.url),
)('loro-crdt');
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = new LoroDoc();
base.setPeerId('1');
base.getText('body').insert(0, 'Hello');
base.getMap('meta').set('obsolete', true);
base.commit();
const snapshot = base.export({ mode: 'snapshot' }),
  version = base.version();
const a = base.fork();
a.setPeerId('2');
a.getText('body').insert(5, ' A');
a.getMap('meta').delete('obsolete');
a.commit();
const b = base.fork();
b.setPeerId('3');
b.getText('body').insert(5, ' B');
b.getMap('meta').set('status', 'ready');
b.commit();
const updates = [a, b].map((doc) =>
  doc.export({ mode: 'update', from: version }),
);
const merged = new LoroDoc();
merged.import(snapshot);
for (const update of updates) merged.import(update);
const expected = merged.toJSON();
if (process.argv[2]) {
  const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  assert.equal(result.ok, true, result.error);
  merged.import(Buffer.from(result.update, 'base64'));
  assert.deepEqual(merged.toJSON(), {
    body: expected.body + ' native',
    meta: { status: 'ready' },
  });
  console.log('PASS: Swift/Rust iOS update imports into JS WASM and converges');
} else {
  writeFileSync(
    new URL('fixtures.json', import.meta.url),
    JSON.stringify({
      snapshot: Buffer.from(snapshot).toString('base64'),
      updates: updates.map((v) => Buffer.from(v).toString('base64')),
      expectedText: expected.body,
    }),
  );
  console.log('Generated synthetic concurrent/deletion fixture', expected);
}
