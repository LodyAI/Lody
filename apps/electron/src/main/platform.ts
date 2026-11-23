import { promises as fs } from 'node:fs'
import { resolvePlatformKind, type PlatformKind } from '@lody/shared/platform-kind'
import { getLocalWorkspaceCatalogPath } from '@lody/shared/node/local-workspace-catalog'
import { getInstallationProfile } from '@lody/shared/node/installation-profile'
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc'
import { parseLocalPlatformSnapshot } from './local-platform-snapshot'
import { resolveDesktopProfile } from './desktop-channel'

/**
 * Build-time platform selection for the desktop shell
 * (specs/platform-providers.md): the public build is local by default and also
 * injects VITE_LODY_PLATFORM=local. Unrecognized values throw at startup.
 */
export const mainPlatformKind: PlatformKind = resolvePlatformKind(
  import.meta.env.VITE_LODY_PLATFORM
)
export const desktopInstallationProfile = resolveDesktopProfile(
  getInstallationProfile(mainPlatformKind),
  import.meta.env.VITE_LODY_RELEASE_CHANNEL
)

export function isLocalPlatform(): boolean {
  return mainPlatformKind === 'local'
}

/**
 * Parses the one atomic local identity/workspace snapshot. A present malformed
 * catalog is a broken installation invariant and must fail; only a missing
 * catalog means the CLI has not provisioned it yet.
 */
export async function readLocalPlatformSnapshot(): Promise<ElectronLocalPlatformSnapshot | null> {
  let raw: string
  try {
    raw = await fs.readFile(getLocalWorkspaceCatalogPath(mainPlatformKind), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    throw new Error('Local platform catalog is not valid JSON', { cause: error })
  }
  return parseLocalPlatformSnapshot(decoded)
}
