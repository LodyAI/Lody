// Test launcher for the real host process (the CLI bundle ships its own entry).
import * as addon from '@loro-dev/loro-repo-engine';
import { runNativeRepoHost } from '../../src/node/native-repo-host.ts';

await runNativeRepoHost(process.argv[2], addon);
