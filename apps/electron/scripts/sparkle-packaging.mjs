import path from 'node:path'

export const DEFAULT_SPARKLE_APPCAST_URL =
  'https://github.com/LodyAI/Lody/releases/latest/download/appcast.xml'

export const SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

export function isMacPackaging(args, platform) {
  if (args.includes('--mac')) return true
  if (args.includes('--win') || args.includes('--linux')) return false
  return platform === 'darwin'
}

export function resolveSparkleRebuildArch(args, hostArch) {
  const hasArm64 = args.includes('--arm64')
  const hasX64 = args.includes('--x64')
  if (hasArm64 && hasX64) return 'universal'
  if (hasX64) return 'x64'
  if (hasArm64) return 'arm64'
  return hostArch === 'x64' ? 'x64' : 'arm64'
}

export function shouldInjectSparklePublicKey(input) {
  if (input.platform !== 'darwin' && input.platform !== 'mas') return false
  return Boolean(input.publicEdKey?.trim())
}

export function sparkleInfoPlistPath(input) {
  return path.join(input.appOutDir, `${input.productFilename}.app`, 'Contents', 'Info.plist')
}

export function hasCodeSigningCredentials(env) {
  return Boolean(env.CSC_LINK?.trim() || env.CSC_NAME?.trim())
}

export function shouldAdHocSignSparkleApp(input) {
  if (input.platform !== 'darwin' && input.platform !== 'mas') return false
  return !input.hasCodeSigningCredentials
}

export function resolvePackagedSparkleFeedUrl(input = {}) {
  const configured = input.configuredAppcastUrl?.trim()
  return configured ? configured : DEFAULT_SPARKLE_APPCAST_URL
}
