import { writeFileSync } from 'node:fs';
import { HonestClient } from '../src/actors';
import { importDevice } from '../src/platform/device';

const baseUrl = process.env.LAB_BASE_URL;
const clientDir = process.env.LAB_CLIENT_DIR;
const marker = process.env.LAB_MARKER;
const deviceJson = process.env.LAB_DEVICE;
const genesisHex = process.env.LAB_GENESIS;

if (!baseUrl || !clientDir || !marker || !deviceJson || !genesisHex) {
  throw new Error('crash-epoch-env');
}

const alice = new HonestClient({
  baseUrl,
  clientDir,
  account: 'alice',
  testMode: true,
  device: await importDevice(deviceJson),
});
await alice.start();
await alice.adoptGenesis(genesisHex);
const result = await alice.publishEpoch();
writeFileSync(marker, JSON.stringify(result));
alice.close();
