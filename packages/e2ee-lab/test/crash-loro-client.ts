import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HonestClient } from '../src/actors';
import { startLabBackend } from '../src/backend';
import { exportDevice, importDevice } from '../src/platform/device';
import { loroWriter, readLoro, writeLoro } from '../src/platform/content-session';

const dataDir = process.env.LAB_DATA_DIR;
const clientDir = process.env.LAB_CLIENT_DIR;
const marker = process.env.LAB_MARKER;
const text = process.env.LAB_TEXT ?? 'crash-text';
const crashAt = process.env.LAB_CRASH_AT;
const deviceJson = process.env.LAB_DEVICE;
const genesisHex = process.env.LAB_GENESIS;

if (!dataDir || !clientDir || !marker) {
  throw new Error('crash-loro-env');
}

const host = await startLabBackend({
  dataDir,
  host: '127.0.0.1',
  port: 0,
  testMode: true,
});
const device = deviceJson ? await importDevice(deviceJson) : undefined;
const alice = new HonestClient({
  baseUrl: host.baseUrl,
  clientDir,
  account: 'alice',
  testMode: true,
  device,
});
await alice.start();
if (genesisHex) {
  await alice.adoptGenesis(genesisHex);
} else {
  await alice.createSpace();
}
await alice.readLedger();
writeFileSync(
  join(clientDir, 'crash-identity.json'),
  JSON.stringify({
    genesisHex: alice.genesisHex,
    device: await exportDevice(alice.device),
  })
);
if (genesisHex) {
  // Restarted client: verify the persisted document/cursor recover the text.
  const recovered = await readLoro(alice);
  writeFileSync(marker, JSON.stringify({ status: 'completed', text: recovered }));
} else if (crashAt === 'after-import') {
  await writeLoro(alice, text);
  const doc = alice.loroDoc;
  if (!doc) throw new Error('loro-doc-missing');
  const writer = loroWriter(alice, doc);
  await writer.createStream();
  doc.getText('text').insert(doc.getText('text').length, ':tail');
  doc.commit();
  const appended = await writer.appendWriteOnly();
  if (!appended.ok || !('value' in appended) || !appended.value.appended) {
    throw new Error(`tail-append-failed:${JSON.stringify(appended)}`);
  }
  await writer.close();
  alice.crashAt = 'after-import';
  alice.crashMarker = marker;
  await readLoro(alice);
} else {
  if (crashAt) {
    alice.crashAt = crashAt as typeof alice.crashAt;
    alice.crashMarker = marker;
  }
  await writeLoro(alice, text);
  const recovered = await readLoro(alice);
  writeFileSync(marker, JSON.stringify({ status: 'completed', text: recovered }));
}
alice.close();
await host.close();
