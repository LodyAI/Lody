// An earlier Lody's host: the real host entry over the real engine, reporting
// only the capabilities an earlier build had (serving is unchanged).
import * as addon from '@loro-dev/loro-repo-engine';
import { runNativeRepoHost } from '../../src/node/native-repo-host.ts';

const capabilities = (process.env.LODY_TEST_EARLIER_CAPABILITIES ?? '').split(',').filter(Boolean);
const earlier = {
  ...addon,
  engineVersion: () => ({ ...addon.engineVersion(), build: 'earlier', capabilities }),
  startEngine: (options) => addon.startEngine({ ...options, advertisedCapabilities: capabilities }),
};
await runNativeRepoHost(process.argv[2], earlier);
