import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import path from 'node:path'
import {
  DEFAULT_SPARKLE_APPCAST_URL,
  hasCodeSigningCredentials,
  isMacPackaging,
  resolvePackagedSparkleFeedUrl,
  resolveSparkleRebuildArch,
  shouldAdHocSignSparkleApp,
  shouldInjectSparklePublicKey,
  sparkleInfoPlistPath
} from './sparkle-packaging.mjs'

const releaseWorkflow = readFileSync(
  new URL('../../../.github/workflows/release-electron.yml', import.meta.url),
  'utf8'
)

function releaseWorkflowStep(name) {
  const marker = `      - name: ${name}\n`
  const start = releaseWorkflow.indexOf(marker)
  assert.notEqual(start, -1, `missing release workflow step: ${name}`)
  const next = releaseWorkflow.indexOf('\n      - name:', start + marker.length)
  return releaseWorkflow.slice(start, next === -1 ? undefined : next)
}

void test('pins the Sparkle signing Action and scopes release credentials to trusted steps', () => {
  assert.match(
    releaseWorkflow,
    /uses: Innei\/electron-sparkle-updater\/action@002472bdb78a9608eddc8b39202572af3f7986fb # v1/u
  )
  assert.doesNotMatch(releaseWorkflow, /electron-sparkle-updater\/action@v1/u)

  const buildJobStart = releaseWorkflow.indexOf('\n  build:\n')
  const jobEnvStart = releaseWorkflow.indexOf('\n    env:\n', buildJobStart)
  const stepsStart = releaseWorkflow.indexOf('\n    steps:\n', jobEnvStart)
  assert.notEqual(buildJobStart, -1)
  assert.notEqual(jobEnvStart, -1)
  assert.notEqual(stepsStart, -1)
  const jobEnv = releaseWorkflow.slice(jobEnvStart, stepsStart)
  for (const secretName of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'APPLE_API_KEY_P8',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'SPARKLE_ED_PUBLIC_KEY',
    'SPARKLE_ED_PRIVATE_KEY'
  ]) {
    assert.doesNotMatch(jobEnv, new RegExp(`^\\s+${secretName}:`, 'mu'))
  }

  const prepareStep = releaseWorkflowStep('Prepare macOS signing and notarization credentials')
  assert.match(prepareStep, /SPARKLE_ED_PRIVATE_KEY: \$\{\{ secrets\.SPARKLE_ED_PRIVATE_KEY \}\}/u)
  const packageStep = releaseWorkflowStep('Package (${{ matrix.target }})')
  assert.match(packageStep, /CSC_LINK: \$\{\{ matrix\.target == 'mac'/u)
  assert.match(packageStep, /APPLE_API_KEY_ID: \$\{\{ matrix\.target == 'mac'/u)
  assert.match(packageStep, /SPARKLE_ED_PUBLIC_KEY: \$\{\{ matrix\.target == 'mac'/u)
  assert.doesNotMatch(packageStep, /SPARKLE_ED_PRIVATE_KEY/u)

  const buildStep = releaseWorkflowStep('Build bundled CLI and renderer')
  const cleanupStep = releaseWorkflowStep('Remove macOS notarization key')
  const signingStep = releaseWorkflowStep('Sign appcast and generate Sparkle deltas')
  assert.ok(releaseWorkflow.indexOf(buildStep) < releaseWorkflow.indexOf(prepareStep))
  assert.ok(releaseWorkflow.indexOf(prepareStep) < releaseWorkflow.indexOf(packageStep))
  assert.ok(releaseWorkflow.indexOf(packageStep) < releaseWorkflow.indexOf(cleanupStep))
  assert.ok(releaseWorkflow.indexOf(cleanupStep) < releaseWorkflow.indexOf(signingStep))
  assert.match(cleanupStep, /rm -f "\$\{APPLE_API_KEY\}"/u)
  assert.match(signingStep, /ed-private-key: \$\{\{ secrets\.SPARKLE_ED_PRIVATE_KEY \}\}/u)
  assert.doesNotMatch(signingStep, /APPLE_API_KEY|CSC_LINK|CSC_KEY_PASSWORD/u)
})

void test('treats explicit --mac and host-default darwin packaging as Sparkle package runs', () => {
  assert.equal(isMacPackaging(['--mac', '--arm64', '--x64'], 'linux'), true)
  assert.equal(isMacPackaging(['--dir'], 'darwin'), true)
  assert.equal(isMacPackaging(['--win'], 'darwin'), false)
  assert.equal(isMacPackaging(['--linux', 'AppImage', 'deb'], 'darwin'), false)
  assert.equal(isMacPackaging(['--dir'], 'linux'), false)
})

void test('rebuilds a universal Sparkle addon when packaging both mac slices', () => {
  assert.equal(resolveSparkleRebuildArch(['--mac', '--arm64', '--x64'], 'arm64'), 'universal')
  assert.equal(resolveSparkleRebuildArch(['--mac', '--arm64'], 'arm64'), 'arm64')
  assert.equal(resolveSparkleRebuildArch(['--mac', '--x64'], 'arm64'), 'x64')
  assert.equal(resolveSparkleRebuildArch(['--mac'], 'arm64'), 'arm64')
  assert.equal(resolveSparkleRebuildArch(['--mac'], 'x64'), 'x64')
})

void test('ad-hoc signs Sparkle mac builds only when no Developer ID credentials are present', () => {
  assert.equal(hasCodeSigningCredentials({ CSC_LINK: 'abc', CSC_NAME: '' }), true)
  assert.equal(hasCodeSigningCredentials({ CSC_NAME: 'Developer ID' }), true)
  assert.equal(hasCodeSigningCredentials({ CSC_LINK: '  ', CSC_NAME: '' }), false)
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'darwin', hasCodeSigningCredentials: false }),
    true
  )
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'darwin', hasCodeSigningCredentials: true }),
    false
  )
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'win32', hasCodeSigningCredentials: false }),
    false
  )
})

void test('packages a local Sparkle feed URL when one is configured', () => {
  assert.equal(resolvePackagedSparkleFeedUrl({}), DEFAULT_SPARKLE_APPCAST_URL)
  assert.equal(
    resolvePackagedSparkleFeedUrl({ configuredAppcastUrl: ' http://127.0.0.1:4371/appcast.xml ' }),
    'http://127.0.0.1:4371/appcast.xml'
  )
})

void test('injects the Sparkle public key only into packaged macOS Info.plist files', () => {
  assert.equal(shouldInjectSparklePublicKey({ platform: 'darwin', publicEdKey: 'ed-key' }), true)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'mas', publicEdKey: 'ed-key' }), true)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'darwin', publicEdKey: '  ' }), false)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'win32', publicEdKey: 'ed-key' }), false)
  assert.equal(
    sparkleInfoPlistPath({
      appOutDir: '/dist/mac-arm64',
      productFilename: 'Lody OSS'
    }),
    path.join('/dist/mac-arm64', 'Lody OSS.app', 'Contents', 'Info.plist')
  )
})
