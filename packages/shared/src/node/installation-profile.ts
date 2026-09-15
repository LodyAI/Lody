import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlatformKind, type PlatformKind } from '../platform-kind';

export type InstallationProfile = {
  platform: PlatformKind;
  namespace: 'lody' | 'lody-oss';
  dataDirectoryName: '.lody' | '.lody-oss';
  desktopProtocol: 'lody' | 'lody-oss';
  desktopProductName: 'Lody' | 'Lody OSS';
  desktopAppId: 'ai.lody.desktop' | 'dev.loro.lody.oss';
  localCliHostPort: 17_788 | 17_789;
};

const CLOUD_PROFILE: InstallationProfile = {
  platform: 'cloud',
  namespace: 'lody',
  dataDirectoryName: '.lody',
  desktopProtocol: 'lody',
  desktopProductName: 'Lody',
  desktopAppId: 'ai.lody.desktop',
  localCliHostPort: 17_788,
};

const LOCAL_PROFILE: InstallationProfile = {
  platform: 'local',
  namespace: 'lody-oss',
  dataDirectoryName: '.lody-oss',
  desktopProtocol: 'lody-oss',
  desktopProductName: 'Lody OSS',
  desktopAppId: 'dev.loro.lody.oss',
  localCliHostPort: 17_789,
};

/**
 * Returns the immutable installation profile selected at process assembly.
 * Invalid values fail before any state path or IPC endpoint is used.
 */
export function getInstallationProfile(
  platform: PlatformKind = resolvePlatformKind(process.env.LODY_PLATFORM),
): InstallationProfile {
  return platform === 'local' ? LOCAL_PROFILE : CLOUD_PROFILE;
}

/** Root for process-owned durable state. Callers may inject a home in tests. */
export function getLodyDataDir(
  platform?: PlatformKind,
  homeDir: string = os.homedir(),
): string {
  const override = process.env.LODY_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homeDir, getInstallationProfile(platform).dataDirectoryName);
}

export const LODY_DATA_DIR_UNAVAILABLE_CODE = 'lody_data_dir_unavailable' as const;

/**
 * The installation's data directory could not be created or written.
 *
 * Every session workspace hangs off this directory — worktrees under `repos/`, chat
 * sessions under `chats/` — so when it is absent the first symptom is whatever tool
 * gets handed a path inside it, typically `git` reporting
 * `fatal: Invalid path '<data dir>': No such file or directory`. That message names a
 * path the user never chose and gives no hint that a wrong or unreachable data root
 * is the cause, so callers raise this instead.
 */
export class LodyDataDirUnavailableError extends Error {
  readonly code = LODY_DATA_DIR_UNAVAILABLE_CODE;

  constructor(
    readonly dataDir: string,
    cause: unknown,
  ) {
    super(
      `Lody's data directory is unavailable: ${dataDir}. ` +
        'Create it, or point LODY_DATA_DIR at a writable directory, then restart the daemon.',
      { cause },
    );
    this.name = 'LodyDataDirUnavailableError';
  }
}

/**
 * Resolve the data directory and make sure it exists before a caller hands a path
 * inside it to `git`, an ACP process cwd, or the filesystem.
 *
 * `LODY_DATA_DIR` and the OSS `.lody-oss` profile both move this root, so deriving it
 * is the ONLY supported way to name it; a literal `~/.lody` join reaches a directory
 * that need not exist on the running installation.
 */
export function ensureLodyDataDir(platform?: PlatformKind, homeDir?: string): string {
  const dataDir =
    homeDir === undefined ? getLodyDataDir(platform) : getLodyDataDir(platform, homeDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new LodyDataDirUnavailableError(dataDir, error);
  }
  return dataDir;
}
