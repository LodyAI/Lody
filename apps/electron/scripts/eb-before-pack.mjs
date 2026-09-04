import {
  installEmbeddedNodePtyBinding,
  installEmbeddedRipgrepBinary,
  installEmbeddedSqliteBinding
} from './cli-native-deps.mjs'

// electron-builder Arch enum (electron-builder/out/index Arch).
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/**
 * Swaps the embedded CLI native bindings to the packaging target's
 * platform/arch before files are copied. Required because one electron-builder
 * invocation can pack several arches (`--mac --arm64 --x64`) from the same
 * resources/ staging dir.
 */
export default async function beforePack(context) {
  const archName = ARCH_NAMES[context.arch]
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName
  if (!archName || archName === 'universal') {
    throw new Error(
      `Unsupported packaging arch ${String(context.arch)} for the embedded CLI sqlite binding; ` +
        `universal builds would need one binding per slice.`
    )
  }
  installEmbeddedSqliteBinding({ platform, arch: archName })
  installEmbeddedNodePtyBinding({ platform, arch: archName })
  installEmbeddedRipgrepBinary({ platform, arch: archName })
}
