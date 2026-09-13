import assert from 'node:assert/strict'
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
