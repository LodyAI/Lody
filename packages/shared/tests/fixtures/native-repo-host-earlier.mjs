// An earlier Lody's host: the real host entry over the real engine, reporting
// the capabilities and release an earlier build had (serving is unchanged).
import * as addon from '@loro-dev/loro-repo-engine';
import { runNativeRepoHost } from '../../src/node/native-repo-host.ts';

const current = addon.engineVersion();
const capabilities = process.env.LODY_TEST_EARLIER_CAPABILITIES
  ? process.env.LODY_TEST_EARLIER_CAPABILITIES.split(',').filter(Boolean)
  : current.capabilities;
const version = process.env.LODY_TEST_EARLIER_VERSION ?? current.version;
const earlier = {
  ...addon,
  engineVersion: () => ({ ...current, version, build: 'earlier', capabilities }),
  startEngine: (options) =>
    addon.startEngine({
      ...options,
      advertisedCapabilities: capabilities,
      advertisedVersion: version,
    }),
};
await runNativeRepoHost(process.argv[2], earlier);
