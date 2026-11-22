import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePnpmRunner } from '../cli/pnpm-runner.mjs'
import { applyPasskeyPackaging, passkeyPackagingPlan } from './passkey-packaging.mjs'
import { applyIrohPackaging, irohPackagingPlan, irohTargetPlatform } from './iroh-packaging.mjs'
import { createElectronBuilderConfig } from './update-changelog.mjs'
import {
  assertBuiltReleaseProfile,
  resolveElectronReleaseProfile,
  resolveLinuxNightlyArtifactArch
} from './release-profile.mjs'
import {
  assertBuiltElectronUpdateConfig,
  isMacPackaging,
  resolveCloudElectronUpdateConfig,
  resolveCloudElectronPackageEnvironment,
  resolveSparkleRebuildArch
} from './sparkle-packaging.mjs'

const cloudPackagePath = fileURLToPath(new URL('./package.json', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const baseConfigPath = fileURLToPath(new URL('./electron-builder.cloud.yml', import.meta.url))
const cloudAfterPackPath = fileURLToPath(new URL('./sparkle-after-pack.mjs', import.meta.url))

/**
 * Resolves the electron-builder configuration and arguments for one packaging run.
 */
export function createCloudPackagingPlan({
  packageArguments,
  generatedDirectory,
  env = process.env
}) {
  if (env.VITE_LODY_PLATFORM !== 'cloud')
    throw new Error('Cloud packaging requires VITE_LODY_PLATFORM=cloud')
  const cloudPackage = JSON.parse(readFileSync(cloudPackagePath, 'utf8'))
  const updateEnvironment = resolveCloudElectronPackageEnvironment({
    args: packageArguments,
    configuredEnvironment: env.LODY_ENV
  })
  const isStaging = updateEnvironment === 'staging'
  const releaseProfile = resolveElectronReleaseProfile({
    environment: updateEnvironment,
    baseVersion: cloudPackage.version,
    env
  })
  const version = releaseProfile.version
  const electronBuilderArguments = packageArguments.filter(
    (argument) => argument !== '--' && argument !== '--staging' && argument !== '--production'
  )
  if (
    !electronBuilderArguments.some(
      (arg) => arg === '--publish' || arg === '-p' || arg.startsWith('--publish=')
    )
  )
    electronBuilderArguments.push('--publish', 'never')
  const linuxArtifactArch = resolveLinuxNightlyArtifactArch(electronBuilderArguments)
  const macPackaging = isMacPackaging(electronBuilderArguments, process.platform)
  const sparkleArch = macPackaging
    ? resolveSparkleRebuildArch(electronBuilderArguments, process.arch)
    : undefined
  const updateConfig = resolveCloudElectronUpdateConfig({
    environment: updateEnvironment,
    releaseChannel: releaseProfile.channel,
    updateBaseUrl: env.VITE_ELECTRON_UPDATE_URL,
    configuredChannel: env.VITE_ELECTRON_UPDATE_CHANNEL
  })
  const builtUpdateConfigPath = path.join(
    repoRoot,
    'apps',
    'electron',
    'out',
    'main',
    'electron-update-config.json'
  )
  const builtUpdateConfig = JSON.parse(readFileSync(builtUpdateConfigPath, 'utf8'))
  assertBuiltElectronUpdateConfig(updateConfig, builtUpdateConfig)
  assertBuiltReleaseProfile(releaseProfile, builtUpdateConfig.releaseProfile)
  const bundledCliProfilePath = path.join(
    repoRoot,
    'apps/electron/resources/cli/lody-desktop-build.json'
  )
  if (releaseProfile.channel === 'nightly' || existsSync(bundledCliProfilePath)) {
    const bundledCliProfile = JSON.parse(readFileSync(bundledCliProfilePath, 'utf8'))
    assertBuiltReleaseProfile(releaseProfile, bundledCliProfile)
  }

  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('apps/electron/package.json must contain a version')
  }

  const generatedConfig = createElectronBuilderConfig({
    baseConfigPath,
    repoRoot,
    version,
    includeReleaseInfo: !isStaging && releaseProfile.channel !== 'nightly',
    updateBaseUrl: updateConfig.url,
    updateChannel: updateConfig.channel,
    releaseProfile,
    linuxArtifactArch
  })
  if (macPackaging) generatedConfig.afterPack = cloudAfterPackPath
  const architectures = electronBuilderArguments.includes('--universal')
    ? ['universal']
    : ['arm64', 'x64'].filter((arch) => electronBuilderArguments.includes(`--${arch}`))
  const plan = passkeyPackagingPlan({
    enabled: env.LODY_ENABLE_PASSKEY,
    macPackaging,
    appId: generatedConfig.appId ?? 'ai.lody.desktop',
    addonDirectory: env.LODY_PASSKEY_ADDON_DIR,
    provisioningProfile: env.LODY_PASSKEY_PROVISIONING_PROFILE,
    architectures: architectures.length ? architectures : [process.arch]
  })
  applyPasskeyPackaging({
    config: generatedConfig,
    plan,
    repoRoot,
    generatedDirectory
  })
  applyIrohPackaging({
    config: generatedConfig,
    plan: irohPackagingPlan({
      relays: env.VITE_IROH_RELAYS,
      addonDirectory: env.LODY_IROH_ADDON_DIR,
      platform: irohTargetPlatform(electronBuilderArguments),
      architectures: architectures.length ? architectures : [process.arch]
    })
  })
  return {
    generatedConfig,
    electronBuilderArguments,
    macPackaging,
    prepackaged: electronBuilderArguments.includes('--prepackaged'),
    sparkleArch,
    updateConfig,
    updateEnvironment
  }
}

export function runCloudPackaging() {
  const generatedConfigDirectory = mkdtempSync(path.join(tmpdir(), 'lody-electron-builder-'))
  const generatedConfigPath = path.join(generatedConfigDirectory, 'electron-builder.json')
  let plan
  try {
    plan = createCloudPackagingPlan({
      packageArguments: process.argv.slice(2),
      generatedDirectory: generatedConfigDirectory
    })
    writeFileSync(generatedConfigPath, `${JSON.stringify(plan.generatedConfig, null, 2)}\n`, 'utf8')
  } catch (error) {
    rmSync(generatedConfigDirectory, { recursive: true, force: true })
    throw error
  }
  const {
    electronBuilderArguments,
    macPackaging,
    prepackaged,
    sparkleArch,
    updateConfig,
    updateEnvironment
  } = plan

  let cleanedUp = false
  function cleanupGeneratedConfig() {
    if (cleanedUp) return
    cleanedUp = true
    rmSync(generatedConfigDirectory, { recursive: true, force: true })
  }

  const runner = resolvePnpmRunner()
  if (macPackaging && !prepackaged) {
    console.log(`[package-electron] rebuilding Sparkle native addon (${sparkleArch})`)
    const sparkleRebuild = spawnSync(
      runner.command,
      [
        ...runner.args,
        '--dir',
        'apps/electron',
        'exec',
        'electron-sparkle-updater',
        'rebuild',
        '--arch',
        sparkleArch
      ],
      {
        cwd: repoRoot,
        env: process.env,
        shell: runner.shell,
        stdio: 'inherit'
      }
    )
    if (sparkleRebuild.status !== 0) {
      cleanupGeneratedConfig()
      process.exit(sparkleRebuild.status ?? 1)
    }
  }

  const child = spawn(
    runner.command,
    [
      ...runner.args,
      '--dir',
      'apps/electron',
      'exec',
      'electron-builder',
      '--config',
      generatedConfigPath,
      ...electronBuilderArguments
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(process.env.CSC_NAME
          ? { CSC_NAME: process.env.CSC_NAME.replace(/^Developer ID Application:\s*/u, '') }
          : {}),
        LODY_SPARKLE_PACKAGE_ENVIRONMENT: updateEnvironment,
        LODY_SPARKLE_UPDATE_BASE_URL: updateConfig.url
      },
      shell: runner.shell,
      stdio: 'inherit'
    }
  )

  child.on('close', (code) => {
    cleanupGeneratedConfig()
    process.exit(code ?? 1)
  })

  child.on('error', (error) => {
    cleanupGeneratedConfig()
    console.error(error)
    process.exit(1)
  })
}

export async function runPackaging() {
  const platform = process.env.VITE_LODY_PLATFORM?.trim() || 'local'
  if (!['local', 'cloud'].includes(platform))
    throw new Error(`Unsupported VITE_LODY_PLATFORM: ${platform}`)
  if (platform === 'cloud') runCloudPackaging()
  else await import('./scripts/package-local-electron.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPackaging()
}
