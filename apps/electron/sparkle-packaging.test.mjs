import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import semver from 'semver'
import { runInNewContext } from 'node:vm'
import { parse as parseYaml } from 'yaml'
import {
  assertBuiltElectronUpdateConfig,
  isMacPackaging,
  resolveCloudElectronPackageEnvironment,
  resolveCloudElectronUpdateConfig,
  resolveCloudSparkleAppcastUrl,
  resolveSparkleRebuildArch
} from './sparkle-packaging.mjs'
import { resolvePackagedSparkleAppcastUrl } from './sparkle-after-pack.mjs'
import {
  assertBuiltReleaseProfile,
  nightlyBuilderOverrides,
  resolveElectronReleaseProfile,
  resolveLinuxNightlyArtifactArch
} from './release-profile.mjs'

const nightlyEnv = {
  LODY_RELEASE_CHANNEL: 'nightly',
  LODY_NIGHTLY_BUILD_NUMBER: '65536',
  LODY_NIGHTLY_VERSION: '0.90.0-nightly.1',
  LODY_SOURCE_SHA: 'a'.repeat(40),
  LODY_BUILD_TIMESTAMP: '2026-09-23T00:00:00.000Z',
  LODY_BUILD_RUN_ID: '123'
}

void test('Nightly requires an explicit production channel and its own feed', () => {
  const config = {
    environment: 'production',
    releaseChannel: 'nightly',
    updateBaseUrl: 'https://updates.example.com/production/nightly/',
    configuredChannel: 'nightly'
  }
  assert.deepEqual(resolveCloudElectronUpdateConfig(config), {
    url: 'https://updates.example.com/production/nightly',
    channel: 'nightly'
  })
  for (const override of [
    { environment: 'staging' },
    { releaseChannel: undefined },
    { configuredChannel: 'latest' },
    { updateBaseUrl: 'https://updates.example.com/production' },
    { updateBaseUrl: 'https://nightly.example.com/production' },
    { updateBaseUrl: 'https://updates.example.com/staging/nightly' }
  ])
    assert.throws(() => resolveCloudElectronUpdateConfig({ ...config, ...override }))
  assert.throws(
    () =>
      resolveCloudElectronUpdateConfig({
        ...config,
        releaseChannel: 'stable',
        configuredChannel: 'latest'
      }),
    /Only Nightly/u
  )
})

void test('Nightly produces an isolated application and traceable native build identity', () => {
  const profile = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.89.4',
    env: nightlyEnv
  })
  assert.equal(profile.version, '0.90.0-nightly.1')
  assert.equal(profile.nativeVersion, '7.55.36')
  const previous = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.89.4',
    env: {
      ...nightlyEnv,
      LODY_NIGHTLY_BUILD_NUMBER: '65535',
      LODY_NIGHTLY_VERSION: '0.90.0-nightly.0'
    }
  })
  assert.equal(previous.nativeVersion, '7.55.35')
  const config = nightlyBuilderOverrides(profile)
  assert.equal(config.appId, 'ai.lody.desktop.nightly')
  assert.equal(config.extraMetadata.name, 'lody-nightly')
  assert.deepEqual(config.extraMetadata.lodyBuild, profile)
  assert.deepEqual(config.protocols[0].schemes, ['ai.lody.nightly'])
  assert.match(config.releaseInfo.releaseNotes, new RegExp(nightlyEnv.LODY_SOURCE_SHA))
  for (const target of ['mac', 'dmg', 'nsis', 'deb', 'snap', 'appImage']) {
    assert.match(config[target].artifactName, /-nightly\.\$\{ext\}$/u)
    assert.equal(config[target].artifactName.includes(' '), false)
  }
  assert.doesNotThrow(() => assertBuiltReleaseProfile(profile, JSON.parse(JSON.stringify(profile))))
  for (const change of [
    { version: previous.version },
    { sourceSha: 'c'.repeat(40) },
    { channel: 'stable' }
  ]) {
    assert.throws(() => assertBuiltReleaseProfile(profile, { ...profile, ...change }), /rebuild/u)
  }
})

void test('Nightly rejects incomplete provenance and invalid or overflowing build numbers', () => {
  for (const key of Object.keys(nightlyEnv).filter((name) => name !== 'LODY_RELEASE_CHANNEL')) {
    assert.throws(
      () =>
        resolveElectronReleaseProfile({
          environment: 'production',
          baseVersion: '1.0.0',
          env: { ...nightlyEnv, [key]: '' }
        }),
      new RegExp(key)
    )
  }
  for (const value of ['0', '-1', '01', '1.5', 'NaN', '99990000', '4294967296']) {
    assert.throws(
      () =>
        resolveElectronReleaseProfile({
          environment: 'production',
          baseVersion: '1.0.0',
          env: { ...nightlyEnv, LODY_NIGHTLY_BUILD_NUMBER: value }
        }),
      /BUILD_NUMBER/u
    )
  }
  assert.throws(
    () =>
      resolveElectronReleaseProfile({
        environment: 'staging',
        baseVersion: '1.0.0',
        env: nightlyEnv
      }),
    /environment\/channel/u
  )
  const stable = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '1.0.0',
    env: {}
  })
  assert.deepEqual(stable, { channel: 'stable', version: '1.0.0' })
  assert.deepEqual(nightlyBuilderOverrides(stable), {})
})

void test('Nightly native versions increase across carries within Apple and Windows limits', () => {
  let previous
  for (const [buildNumber, expected] of [
    ['1', '1.0.1'],
    ['99', '1.0.99'],
    ['100', '1.1.0'],
    ['9999', '1.99.99'],
    ['10000', '2.0.0'],
    ['99989999', '9999.99.99']
  ]) {
    const profile = resolveElectronReleaseProfile({
      environment: 'production',
      baseVersion: '0.89.4',
      env: { ...nightlyEnv, LODY_NIGHTLY_BUILD_NUMBER: buildNumber }
    })
    assert.equal(profile.nativeVersion, expected)
    assert.match(profile.nativeVersion, /^[1-9][0-9]{0,3}\.[0-9]{1,2}\.[0-9]{1,2}$/u)
    if (previous) assert.equal(semver.gt(profile.nativeVersion, previous), true)
    previous = profile.nativeVersion
  }
})

void test('resetting the display sequence still advances both native and fallback update versions', () => {
  const previous = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.101.8',
    env: { ...nightlyEnv, LODY_NIGHTLY_VERSION: '0.102.0-nightly.90' }
  })
  const next = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.102.0',
    env: {
      ...nightlyEnv,
      LODY_NIGHTLY_BUILD_NUMBER: '65537',
      LODY_NIGHTLY_VERSION: '0.103.0-nightly.0'
    }
  })
  assert.equal(semver.gt(next.version, previous.version), true)
  assert.equal(semver.gt(next.nativeVersion, previous.nativeVersion), true)
})

void test('detects mac packaging and the native addon architecture', () => {
  assert.equal(isMacPackaging(['--mac', '--arm64', '--x64'], 'linux'), true)
  assert.equal(isMacPackaging(['--win'], 'darwin'), false)
  assert.equal(isMacPackaging(['--dir'], 'darwin'), true)
  assert.equal(resolveSparkleRebuildArch(['--mac', '--arm64', '--x64'], 'arm64'), 'universal')
  assert.equal(resolveSparkleRebuildArch(['--mac', '--x64'], 'arm64'), 'x64')
  assert.equal(resolveSparkleRebuildArch(['--mac'], 'arm64'), 'arm64')
})

void test('binds staging and production packages to their required update channels', () => {
  assert.deepEqual(
    resolveCloudElectronUpdateConfig({
      environment: 'staging',
      updateBaseUrl: 'https://updates.example.com/staging/',
      configuredChannel: 'next'
    }),
    { url: 'https://updates.example.com/staging', channel: 'next' }
  )
  assert.deepEqual(
    resolveCloudElectronUpdateConfig({
      environment: 'production',
      updateBaseUrl: 'https://updates.example.com/production',
      configuredChannel: 'LATEST'
    }),
    { url: 'https://updates.example.com/production', channel: 'latest' }
  )
  assert.throws(
    () =>
      resolveCloudElectronUpdateConfig({
        environment: 'staging',
        updateBaseUrl: 'https://updates.example.com/staging',
        configuredChannel: 'latest'
      }),
    /staging packaging requires the next update channel/u
  )
  assert.throws(
    () => resolveCloudElectronUpdateConfig({ environment: 'production' }),
    /VITE_ELECTRON_UPDATE_URL is required/u
  )
  assert.throws(
    () =>
      resolveCloudElectronUpdateConfig({
        environment: 'staging',
        updateBaseUrl: 'https://updates.example.com/production',
        configuredChannel: 'next'
      }),
    /staging update URL must identify the staging environment/u
  )
  assert.throws(
    () =>
      resolveCloudElectronUpdateConfig({
        environment: 'staging',
        updateBaseUrl: 'https://staging.example.com/production',
        configuredChannel: 'next'
      }),
    /staging update URL must identify the staging environment/u
  )
  assert.throws(
    () =>
      resolveCloudElectronUpdateConfig({
        environment: 'staging',
        updateBaseUrl: 'https://updates.example.com/staging?source=production',
        configuredChannel: 'next'
      }),
    /must not contain a query string or fragment/u
  )
})

void test('requires one package environment and rejects conflicting selectors', () => {
  assert.equal(resolveCloudElectronPackageEnvironment({ args: ['--staging', '--mac'] }), 'staging')
  assert.equal(
    resolveCloudElectronPackageEnvironment({
      args: ['--production', '--win'],
      configuredEnvironment: 'production'
    }),
    'production'
  )
  assert.throws(() => resolveCloudElectronPackageEnvironment({ args: ['--mac'] }), /exactly one/u)
  assert.throws(
    () =>
      resolveCloudElectronPackageEnvironment({
        args: ['--staging'],
        configuredEnvironment: 'production'
      }),
    /argument selects staging but LODY_ENV selects production/u
  )
  assert.throws(
    () =>
      resolveCloudElectronPackageEnvironment({
        args: ['--production'],
        configuredEnvironment: 'stagign'
      }),
    /Unsupported LODY_ENV/u
  )
})

void test('rejects packaging stale build output from another update environment', () => {
  const expected = { url: 'https://updates.example.com/staging', channel: 'next' }
  assert.doesNotThrow(() => assertBuiltElectronUpdateConfig(expected, { ...expected }))
  assert.throws(
    () =>
      assertBuiltElectronUpdateConfig(expected, {
        url: 'https://updates.example.com/production',
        channel: 'latest'
      }),
    /build output update config does not match packaging config/u
  )
})

void test('derives the Sparkle feed from the selected cloud update channel', () => {
  assert.equal(
    resolveCloudSparkleAppcastUrl({ updateBaseUrl: 'https://updates.example.com/staging/' }),
    'https://updates.example.com/staging/appcast.xml'
  )
  assert.equal(
    resolveCloudSparkleAppcastUrl({
      updateBaseUrl: 'https://updates.example.com/production',
      architecture: 'arm64'
    }),
    'https://updates.example.com/production/arm64/appcast.xml'
  )
  assert.equal(
    resolveCloudSparkleAppcastUrl({
      updateBaseUrl: 'https://updates.example.com/production',
      architecture: 'x64'
    }),
    'https://updates.example.com/production/x64/appcast.xml'
  )
  assert.throws(() => resolveCloudSparkleAppcastUrl(), /VITE_ELECTRON_UPDATE_URL is required/u)
  assert.equal(
    resolveCloudSparkleAppcastUrl({ updateBaseUrl: 'http://127.0.0.1:4371/staging' }),
    'http://127.0.0.1:4371/staging/appcast.xml'
  )
  assert.throws(
    () => resolveCloudSparkleAppcastUrl({ updateBaseUrl: 'http://updates.example.com/staging' }),
    /must use HTTPS/u
  )
  assert.throws(
    () =>
      resolveCloudSparkleAppcastUrl({
        updateBaseUrl: 'https://updates.example.com/production',
        architecture: 'universal'
      }),
    /requires an arm64 or x64 target/u
  )
})

void test('selects the packaged Sparkle feed from the actual builder architecture', () => {
  assert.equal(
    resolvePackagedSparkleAppcastUrl({
      environment: 'production',
      updateBaseUrl: 'https://updates.example.com/production',
      arch: 'arm64'
    }),
    'https://updates.example.com/production/arm64/appcast.xml'
  )
  assert.equal(
    resolvePackagedSparkleAppcastUrl({
      environment: 'production',
      updateBaseUrl: 'https://updates.example.com/production',
      arch: 'x64'
    }),
    'https://updates.example.com/production/x64/appcast.xml'
  )
  assert.equal(
    resolvePackagedSparkleAppcastUrl({
      environment: 'staging',
      updateBaseUrl: 'https://updates.example.com/staging',
      arch: 'arm64'
    }),
    'https://updates.example.com/staging/appcast.xml'
  )
  assert.throws(
    () =>
      resolvePackagedSparkleAppcastUrl({
        environment: 'production',
        updateBaseUrl: 'https://updates.example.com/production',
        arch: 'universal'
      }),
    /requires an arm64 or x64 target/u
  )
})

void test('resolveLinuxNightlyArtifactArch selects canonical installer labels', () => {
  assert.equal(resolveLinuxNightlyArtifactArch([]), 'x64')
  assert.equal(resolveLinuxNightlyArtifactArch(['--x64']), 'x64')
  assert.equal(resolveLinuxNightlyArtifactArch(['--linux', '--arm64']), 'arm64')
  assert.equal(resolveLinuxNightlyArtifactArch(['--linux', '--x64']), 'x64')
  assert.equal(resolveLinuxNightlyArtifactArch(['--mac', '--arm64', '--x64']), 'x64')
  assert.throws(
    () => resolveLinuxNightlyArtifactArch(['--linux', '--arm64', '--x64']),
    /one architecture/u
  )
  const profile = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.89.4',
    env: nightlyEnv
  })
  assert.match(
    nightlyBuilderOverrides(profile, { linuxArtifactArch: 'arm64' }).appImage.artifactName,
    /-arm64-nightly\.\$\{ext\}$/u
  )
  assert.match(nightlyBuilderOverrides(profile).appImage.artifactName, /-x64-nightly\.\$\{ext\}$/u)
})
