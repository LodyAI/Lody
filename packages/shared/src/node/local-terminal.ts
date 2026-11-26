import { getLocalDaemonSocketPath } from './local-ipc';
import { getInstallationProfile } from './installation-profile';
import type { PlatformKind } from '../platform-kind';

// Keep this file in sync with local-terminal.cjs. Electron main consumes the
// CommonJS export while the CLI daemon consumes this TypeScript module.
export function getLocalTerminalSocketPath(platform?: PlatformKind): string {
  // Same 0700 run dir as the control/probe sockets — never a world-writable
  // shared tmpdir, so other local users cannot squat or symlink the
  // well-known path (S1).
  return getLocalDaemonSocketPath(
    `${getInstallationProfile(platform).namespace}-terminal`,
    platform
  );
}
