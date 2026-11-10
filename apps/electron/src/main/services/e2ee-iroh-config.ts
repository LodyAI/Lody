import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { E2eeIrohRelays } from '@lody/platform'

// Pure desktop iroh configuration, shared by the main-process endpoint
// (`e2ee-iroh.mts`) and the embedded CLI environment (`cli-service.ts`).

/** `lody-iroh.<platform>-<arch>.node`, matching `@lody/iroh-native`'s build output. */
export const irohNativeFileName = (platform = process.platform, arch = process.arch) =>
  `lody-iroh.${platform}-${arch}.node`

/**
 * Packaged: the cloud build ships the module in `Contents/Resources` (or the
 * platform's resources directory). Development: the package's own build output.
 * Absent file means no iroh capability.
 */
export function irohNativePath(input: {
  packaged: boolean
  resourcesPath: string
  repoRoot: string | null
}): string | undefined {
  const file = input.packaged
    ? join(input.resourcesPath, irohNativeFileName())
    : input.repoRoot
      ? join(input.repoRoot, 'packages', 'iroh-native', irohNativeFileName())
      : undefined
  return file && existsSync(file) ? file : undefined
}

function findRepoRoot(start: string): string | null {
  let candidate = start
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(candidate, 'pnpm-workspace.yaml'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return null
}

/**
 * The desktop's iroh configuration: relays from the cloud build plus an existing
 * native module file. Shared by the main-process endpoint and the embedded CLI.
 */
export function desktopIrohConfig(input: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  env: Parameters<typeof irohRelaysFromBuild>[0]
}): { file: string; relays: E2eeIrohRelays } | undefined {
  const relays = irohRelaysFromBuild(input.env)
  if (!relays) return undefined
  const file = irohNativePath({
    packaged: input.packaged,
    resourcesPath: input.resourcesPath,
    repoRoot: input.packaged ? null : findRepoRoot(input.appPath)
  })
  return file ? { file, relays } : undefined
}

/** Relays from the official cloud build; the local composition has none. */
export function irohRelaysFromBuild(buildEnv: object): E2eeIrohRelays | undefined {
  // Build env interfaces differ per tsconfig; read the three keys structurally.
  const env = buildEnv as Readonly<Record<string, unknown>>
  if (env.VITE_LODY_PLATFORM !== 'cloud') return undefined
  const urls = (typeof env.VITE_IROH_RELAYS === 'string' ? env.VITE_IROH_RELAYS : '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length === 0 || urls.length > 16) return undefined
  for (const url of urls) {
    try {
      if (new URL(url).protocol !== 'https:') return undefined
    } catch {
      return undefined
    }
  }
  const token =
    typeof env.VITE_IROH_RELAY_TOKEN === 'string' ? env.VITE_IROH_RELAY_TOKEN.trim() : undefined
  return { urls, ...(token ? { token } : {}) }
}
