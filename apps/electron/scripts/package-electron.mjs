import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isMacPackaging,
  resolvePackagedSparkleFeedUrl,
  resolveSparkleRebuildArch
} from './sparkle-packaging.mjs'

// electron-builder derives the packaged version from apps/electron/package.json,
// which tracks the private cloud release line only when someone remembers to bump
// it. Releases are tagged instead, so the tag is the source of truth: this script
// generates a throwaway config that extends electron-builder.yml and overrides the
// version via extraMetadata. Mirrors apps/electron-cloud/package-electron.mjs in
// the private composition repository.

const electronDir = fileURLToPath(new URL('../', import.meta.url))
const baseConfigPath = path.join(electronDir, 'electron-builder.yml')
const packageJsonPath = path.join(electronDir, 'package.json')

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function readPackageVersion() {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  return typeof manifest.version === 'string' ? manifest.version.trim() : ''
}

/**
 * Accepts `v0.80.1` as well so a workflow can forward `github.ref_name` verbatim.
 */
function normalizeVersion(rawVersion) {
  const trimmed = rawVersion.trim()
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

function resolveVersion(forwardedArguments) {
  const flagIndex = forwardedArguments.findIndex((argument) => argument.startsWith('--version='))
  const candidate =
    flagIndex === -1
      ? (process.env.LODY_OSS_RELEASE_VERSION ?? '')
      : forwardedArguments[flagIndex].slice('--version='.length)

  if (flagIndex !== -1) {
    forwardedArguments.splice(flagIndex, 1)
  }

  const version = normalizeVersion(candidate) || readPackageVersion()
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `Refusing to package with version ${JSON.stringify(version)}. Pass --version=<semver>, ` +
        'set LODY_OSS_RELEASE_VERSION, or fix apps/electron/package.json.'
    )
  }
  return version
}

/**
 * `pnpm run package -- --dir` forwards the `--` separator itself, and passing it
 * on makes electron-builder's parser treat every following flag as a positional
 * argument. That silently drops the target selection *and* the publish policy,
 * which then falls back to implicit CI publishing and uploads a release. The
 * separator carries no meaning for electron-builder, so drop it here.
 */
function stripArgumentSeparators(forwardedArguments) {
  return forwardedArguments.filter((argument) => argument !== '--')
}

/**
 * electron-builder defaults `--publish` to `onTagOrDraft`, and additionally
 * triggers implicit publishing when it detects CI, which would upload to GitHub
 * once electron-builder.yml carries a publish provider. Publishing is this
 * repository's release workflow's job, so a caller has to opt in explicitly.
 */
function withExplicitPublishPolicy(forwardedArguments) {
  const hasPublishFlag = forwardedArguments.some(
    (argument) => argument === '-p' || argument === '--publish' || argument.startsWith('--publish=')
  )
  return hasPublishFlag ? forwardedArguments : [...forwardedArguments, '--publish', 'never']
}

/**
 * Guards the invariant the two functions above exist to maintain: a mangled
 * argument vector must fail loudly here rather than turn into an upload.
 */
function assertPublishPolicyIsExplicit(electronBuilderArguments) {
  const publishIndex = electronBuilderArguments.findIndex(
    (argument) => argument === '-p' || argument === '--publish' || argument.startsWith('--publish=')
  )
  const isInlineValue = electronBuilderArguments[publishIndex]?.includes('=')
  const policy = isInlineValue
    ? electronBuilderArguments[publishIndex].split('=')[1]
    : electronBuilderArguments[publishIndex + 1]

  if (publishIndex === -1 || !policy || policy.startsWith('-')) {
    throw new Error(
      `Refusing to run electron-builder without an explicit publish policy: ${electronBuilderArguments.join(' ')}`
    )
  }
}

function resolveRunner() {
  const npmExecPath = process.env.npm_execpath
  if (!npmExecPath || !/\.(?:cjs|mjs|js)$/iu.test(npmExecPath)) {
    throw new Error(
      'package-electron must be launched through pnpm so the package-manager entrypoint is explicit'
    )
  }
  return { command: process.execPath, args: [npmExecPath] }
}

const forwardedArguments = stripArgumentSeparators(process.argv.slice(2))
const version = resolveVersion(forwardedArguments)
const electronBuilderArguments = withExplicitPublishPolicy(forwardedArguments)
assertPublishPolicyIsExplicit(electronBuilderArguments)

const generatedConfigDirectory = mkdtempSync(path.join(tmpdir(), 'lody-oss-electron-builder-'))
const generatedConfigPath = path.join(generatedConfigDirectory, 'electron-builder.json')
const configuredSparkleFeedUrl = process.env.SPARKLE_APPCAST_URL
const sparkleFeedUrl = resolvePackagedSparkleFeedUrl({
  configuredAppcastUrl: configuredSparkleFeedUrl
})
const localSparkleFeed = Boolean(configuredSparkleFeedUrl?.trim())
const generatedConfig = {
  extends: baseConfigPath,
  extraMetadata: { version },
  mac: {
    extendInfo: {
      SUFeedURL: sparkleFeedUrl,
      ...(localSparkleFeed
        ? {
            SUScheduledCheckInterval: 1,
            NSAppTransportSecurity: { NSAllowsLocalNetworking: true }
          }
        : {})
    }
  }
}
writeFileSync(generatedConfigPath, `${JSON.stringify(generatedConfig, null, 2)}\n`, 'utf8')

let cleanedUp = false
function cleanupGeneratedConfig() {
  if (cleanedUp) return
  cleanedUp = true
  rmSync(generatedConfigDirectory, { recursive: true, force: true })
}

console.log(`[package-electron] packaging Lody OSS ${version}`)

const runner = resolveRunner()

if (isMacPackaging(electronBuilderArguments, process.platform)) {
  const sparkleArch = resolveSparkleRebuildArch(electronBuilderArguments, process.arch)
  console.log(`[package-electron] rebuilding Sparkle native addon (${sparkleArch})`)
  const sparkleRebuild = spawnSync(
    runner.command,
    [...runner.args, 'exec', 'electron-sparkle-updater', 'rebuild', '--arch', sparkleArch],
    {
      cwd: electronDir,
      env: process.env,
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
    'exec',
    'electron-builder',
    '--config',
    generatedConfigPath,
    ...electronBuilderArguments
  ],
  {
    cwd: electronDir,
    env: process.env,
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
