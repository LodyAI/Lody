function readNonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function requireSecureUrl(value, label) {
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS unless it targets loopback`)
  }
  return url.href
}

export function resolveCloudElectronUpdateConfig({
  environment,
  releaseChannel,
  updateBaseUrl,
  configuredChannel
} = {}) {
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error(`Unsupported Electron update environment: ${JSON.stringify(environment)}`)
  }

  const baseUrl = readNonEmptyString(updateBaseUrl)
  if (!baseUrl) {
    throw new Error('VITE_ELECTRON_UPDATE_URL is required for Electron cloud packaging')
  }

  const selectedReleaseChannel =
    releaseChannel ?? (environment === 'staging' ? 'staging' : 'stable')
  if (
    !['stable', 'nightly', 'staging'].includes(selectedReleaseChannel) ||
    (environment === 'staging') !== (selectedReleaseChannel === 'staging')
  ) {
    throw new Error(
      `Unsupported Electron environment/channel: ${environment}/${selectedReleaseChannel}`
    )
  }
  const expectedChannel = { staging: 'next', stable: 'latest', nightly: 'nightly' }[
    selectedReleaseChannel
  ]
  const channel = readNonEmptyString(configuredChannel)?.toLowerCase()
  if (!channel) {
    throw new Error('VITE_ELECTRON_UPDATE_CHANNEL is required for Electron cloud packaging')
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `Electron ${environment} packaging requires the ${expectedChannel} update channel, received ${JSON.stringify(channel)}`
    )
  }

  const parsedUrl = new URL(requireSecureUrl(baseUrl, 'VITE_ELECTRON_UPDATE_URL'))
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('Electron update URL must not contain a query string or fragment')
  }
  const environmentTokens = `${parsedUrl.hostname}/${parsedUrl.pathname}`
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
  const oppositeEnvironment = environment === 'staging' ? 'production' : 'staging'
  if (!environmentTokens.includes(environment) || environmentTokens.includes(oppositeEnvironment)) {
    throw new Error(
      `Electron ${environment} update URL must identify the ${environment} environment: ${parsedUrl.href}`
    )
  }
  const nightlyPath = parsedUrl.pathname.split('/').includes('nightly')
  if ((selectedReleaseChannel === 'nightly') !== nightlyPath) {
    throw new Error('Only Nightly update URLs must contain a /nightly path segment')
  }
  return {
    url: parsedUrl.href.replace(/\/+$/u, ''),
    channel
  }
}

export function resolveCloudElectronPackageEnvironment({ args = [], configuredEnvironment } = {}) {
  const hasStagingArgument = args.includes('--staging')
  const hasProductionArgument = args.includes('--production')
  if (hasStagingArgument === hasProductionArgument) {
    throw new Error('Electron cloud packaging requires exactly one of --staging or --production')
  }

  const argumentEnvironment = hasStagingArgument ? 'staging' : 'production'
  const declaredEnvironment = readNonEmptyString(configuredEnvironment)?.toLowerCase()
  if (
    declaredEnvironment &&
    declaredEnvironment !== 'staging' &&
    declaredEnvironment !== 'production'
  ) {
    throw new Error(`Unsupported LODY_ENV: ${JSON.stringify(declaredEnvironment)}`)
  }
  if (declaredEnvironment && declaredEnvironment !== argumentEnvironment) {
    throw new Error(
      `Electron package argument selects ${argumentEnvironment} but LODY_ENV selects ${declaredEnvironment}`
    )
  }
  return argumentEnvironment
}

export function assertBuiltElectronUpdateConfig(expected, actual) {
  if (actual?.url !== expected.url || actual?.channel !== expected.channel) {
    throw new Error(
      `Electron build output update config does not match packaging config: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    )
  }
}

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

export function resolveCloudSparkleAppcastUrl({ updateBaseUrl, architecture } = {}) {
  const baseUrl = readNonEmptyString(updateBaseUrl)
  if (!baseUrl) {
    throw new Error('VITE_ELECTRON_UPDATE_URL is required to derive the Sparkle appcast URL')
  }
  if (architecture !== undefined && architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error(
      `Production Sparkle packaging requires an arm64 or x64 target, received ${JSON.stringify(architecture)}`
    )
  }
  const feedPath = architecture ? `${architecture}/appcast.xml` : 'appcast.xml'
  return requireSecureUrl(`${baseUrl.replace(/\/+$/u, '')}/${feedPath}`, 'VITE_ELECTRON_UPDATE_URL')
}
