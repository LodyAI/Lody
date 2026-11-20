// Separate engine host process; see @lody/shared/node/native-repo.
import * as addon from '@loro-dev/loro-repo-engine';
import { runNativeRepoHost } from '@lody/shared/node/native-repo-host';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('native-repo-host requires a data directory');
await runNativeRepoHost(dataDir, addon);
// The engine has stopped (idle, stop or a completed handoff) or another host
// serves the directory: this process has nothing left. Launched as
// Electron-as-Node, its runtime threads otherwise keep it alive indefinitely.
process.exit(0);
