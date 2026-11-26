import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installEmbeddedKeyringBinding,
  installEmbeddedRoostBinding,
  installEmbeddedNodePtyBinding,
  installEmbeddedSqliteBinding
} from './cli-native-deps.mjs'
import { withDesktopResourceProtocols } from './desktop-protocols.mjs'
import { validateIcns } from './validate-mac-icon.mjs'

// electron-builder Arch enum (electron-builder/out/index Arch).
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/**
 * Swaps the embedded CLI native bindings to the packaging target's
 * platform/arch before files are copied. Required because one electron-builder
 * invocation can pack several arches (`--mac --arm64 --x64`) from the same
 * resources/ staging dir.
 */
export default async function beforePack(context) {
  // Applied to the resolved configuration, including channel-specific overrides.
  context.packager.config.protocols = withDesktopResourceProtocols(
    context.packager.config.protocols
  )
  const archName = ARCH_NAMES[context.arch]
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName
  if (!archName || archName === 'universal') {
    throw new Error(
      `Unsupported packaging arch ${String(context.arch)} for the embedded CLI sqlite binding; ` +
        `universal builds would need one binding per slice.`
    )
  }
  if (platform === 'darwin') {
    // Fail packaging loudly if build/icon.icns is malformed (issue #2887):
    // every PNG chunk must carry the pixel size its OSType slot requires.
    const icnsPath = fileURLToPath(new URL('../build/icon.icns', import.meta.url))
    const { problems, report } = validateIcns(icnsPath)
    console.log(report.join('\n'))
    if (problems.length > 0) {
      throw new Error(
        `build/icon.icns is invalid (${problems.length} problem(s)). ` +
          `Regenerate with: python3 scripts/pad-mac-icon.py\n  ${problems.join('\n  ')}`
      )
    }
    console.log(`[icon.icns] validated ${path.basename(icnsPath)}`)
  }
  installEmbeddedSqliteBinding({ platform, arch: archName })
  installEmbeddedNodePtyBinding({ platform, arch: archName })
  installEmbeddedKeyringBinding({ platform, arch: archName })
  installEmbeddedRoostBinding({ platform, arch: archName })
}
