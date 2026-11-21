import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { validateNightlyBuildIdentity } from './nightly-candidate.mjs'
import { validateNightlyVersion } from './nightly-version.mjs'

/** Build and packaging use the same inputs; none of these values are runtime overrides. */
export function resolveElectronReleaseProfile({ environment, baseVersion, env = process.env }) {
  const channel = env.LODY_RELEASE_CHANNEL ?? (environment === 'staging' ? 'staging' : 'stable')
  if (
    !['production', 'staging'].includes(environment) ||
    !['stable', 'staging', 'nightly'].includes(channel) ||
    (environment === 'staging') !== (channel === 'staging')
  ) {
    throw new Error(`Unsupported Electron environment/channel: ${environment}/${channel}`)
  }
  if (!semver.valid(baseVersion)) throw new Error('Invalid Electron base version')
  if (channel !== 'nightly') return { channel, version: baseVersion }

  const buildNumber = env.LODY_NIGHTLY_BUILD_NUMBER
  const sourceSha = env.LODY_SOURCE_SHA
  const builtAt = env.LODY_BUILD_TIMESTAMP
  const runId = env.LODY_BUILD_RUN_ID
  validateNightlyBuildIdentity({ buildNumber, sourceSha, builtAt, runId })
  const version = validateNightlyVersion(env.LODY_NIGHTLY_VERSION, baseVersion)
  const number = Number(buildNumber)
  const nativeVersion = `${1 + Math.floor(number / 10000)}.${Math.floor(number / 100) % 100}.${number % 100}`
  return { channel, version, buildNumber, nativeVersion, sourceSha, builtAt, runId }
}

export function assertBuiltReleaseProfile(expected, actual) {
  try {
    assert.deepEqual(actual, expected)
  } catch {
    throw new Error(
      'Electron build identity does not match packaging identity; rebuild before packaging'
    )
  }
}

/** Canonical Nightly Linux installer arch labels (not electron-builder ${arch}). */
export function resolveLinuxNightlyArtifactArch(args = []) {
  const isLinux = args.includes('--linux')
  const hasArm64 = args.includes('--arm64')
  const hasX64 = args.includes('--x64')
  if (isLinux && hasArm64 && hasX64) {
    throw new Error('Nightly Linux packaging builds one architecture per invocation')
  }
  if (isLinux && hasArm64) return 'arm64'
  return 'x64'
}

/** Overrides applied after the shared cloud configuration. */
export function nightlyBuilderOverrides(profile, { linuxArtifactArch = 'x64' } = {}) {
  if (profile.channel !== 'nightly') return {}
  if (linuxArtifactArch !== 'arm64' && linuxArtifactArch !== 'x64') {
    throw new Error(
      `Nightly Linux artifact arch must be arm64 or x64, received ${JSON.stringify(linuxArtifactArch)}`
    )
  }
  const artifactName = 'Lody-${version}-${arch}-nightly.${ext}'
  const linuxArtifactName = `Lody-\${version}-${linuxArtifactArch}-nightly.\${ext}`
  return {
    appId: 'ai.lody.desktop.nightly',
    productName: 'Lody Nightly',
    buildVersion: profile.nativeVersion,
    extraMetadata: {
      name: 'lody-nightly',
      desktopName: 'ai.lody.desktop.nightly.desktop',
      lodyBuild: profile
    },
    protocols: [{ name: 'Lody Nightly', schemes: ['ai.lody.nightly'] }],
    win: {
      executableName: 'lody-nightly',
      icon: fileURLToPath(new URL('./resources/icon-nightly-win.png', import.meta.url))
    },
    nsis: {
      artifactName: 'Lody-${version}-${arch}-setup-nightly.${ext}',
      shortcutName: 'Lody Nightly',
      uninstallDisplayName: 'Lody Nightly'
    },
    mac: { artifactName, icon: 'resources/icon-nightly.png' },
    dmg: { artifactName },
    linux: {
      executableName: 'lodyNightly',
      icon: 'resources/icon-nightly.png',
      desktop: { entry: { Name: 'Lody Nightly' } }
    },
    appImage: { artifactName: linuxArtifactName },
    deb: { artifactName: linuxArtifactName },
    snap: { artifactName: linuxArtifactName },
    releaseInfo: {
      releaseDate: profile.builtAt,
      releaseNotes: `Lody Nightly ${profile.version}\n\nSource: ${profile.sourceSha}`
    }
  }
}
