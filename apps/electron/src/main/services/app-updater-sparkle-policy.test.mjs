import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_SPARKLE_APPCAST_URL,
  resolveSparkleAddonPath,
  resolveSparkleAppcastUrl,
  shouldConstructUpdaterEnabled,
  shouldUseSparkleUpdater,
  sparklePackageJsonPathFromModuleEntry
} from './app-updater-sparkle-policy.ts'

void test('keeps OSS local updater off unless explicitly force-enabled', () => {
  assert.equal(
    shouldConstructUpdaterEnabled({ localPlatform: true, forceEnable: false }),
    false
  )
  assert.equal(
    shouldConstructUpdaterEnabled({ localPlatform: true, forceEnable: true }),
    true
  )
  assert.equal(
    shouldConstructUpdaterEnabled({ localPlatform: false, forceEnable: false }),
    true
  )
})

void test('uses Sparkle only for packaged macOS when the native bridge is available', () => {
  assert.equal(
    shouldUseSparkleUpdater({
      platform: 'darwin',
      isPackaged: true,
      sparkleAvailable: true
    }),
    true
  )
  assert.equal(
    shouldUseSparkleUpdater({
      platform: 'darwin',
      isPackaged: true,
      sparkleAvailable: false
    }),
    false
  )
  assert.equal(
    shouldUseSparkleUpdater({
      platform: 'darwin',
      isPackaged: false,
      sparkleAvailable: true
    }),
    false
  )
  assert.equal(
    shouldUseSparkleUpdater({
      platform: 'win32',
      isPackaged: true,
      sparkleAvailable: true
    }),
    false
  )
  assert.equal(
    shouldUseSparkleUpdater({
      platform: 'linux',
      isPackaged: true,
      sparkleAvailable: true
    }),
    false
  )
})

void test('resolves the GitHub Releases appcast and ignores blank overrides', () => {
  assert.equal(
    resolveSparkleAppcastUrl({}),
    'https://github.com/LodyAI/Lody/releases/latest/download/appcast.xml'
  )
  assert.equal(
    resolveSparkleAppcastUrl({ configuredAppcastUrl: '  https://example.com/appcast.xml  ' }),
    'https://example.com/appcast.xml'
  )
  assert.equal(
    resolveSparkleAppcastUrl({ configuredAppcastUrl: '   ' }),
    DEFAULT_SPARKLE_APPCAST_URL
  )
})

void test('electron-builder SUFeedURL matches the runtime Sparkle appcast', async () => {
  const yml = await readFile(new URL('../../../electron-builder.yml', import.meta.url), 'utf8')
  const packaging = await readFile(
    new URL('../../../scripts/sparkle-packaging.mjs', import.meta.url),
    'utf8'
  )
  assert.equal(
    yml.includes(`SUFeedURL: ${DEFAULT_SPARKLE_APPCAST_URL}`),
    true,
    'electron-builder.yml SUFeedURL must match DEFAULT_SPARKLE_APPCAST_URL'
  )
  assert.equal(
    packaging.includes(`'${DEFAULT_SPARKLE_APPCAST_URL}'`),
    true,
    'sparkle-packaging.mjs must keep the same appcast URL'
  )
  assert.equal(yml.includes('SUPublicEDKey: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'), true)
})

void test('prefers the unpacked native addon next to the resolved package', () => {
  const exists = new Set([
    '/App.app/Contents/Resources/app.asar.unpacked/node_modules/electron-sparkle-updater/native/build/Release/sparkle_bridge.node'
  ])
  assert.equal(
    resolveSparkleAddonPath({
      isPackaged: true,
      resourcesPath: '/App.app/Contents/Resources',
      resolvedPackageJsonPath:
        '/App.app/Contents/Resources/app.asar/node_modules/electron-sparkle-updater/package.json',
      exists: (candidate) => exists.has(candidate)
    }),
    '/App.app/Contents/Resources/app.asar.unpacked/node_modules/electron-sparkle-updater/native/build/Release/sparkle_bridge.node'
  )
})

void test('maps the Sparkle package entry to package.json for asar rewriting', () => {
  assert.equal(
    sparklePackageJsonPathFromModuleEntry(
      '/App.app/Contents/Resources/app.asar/node_modules/electron-sparkle-updater/dist/index.js'
    ),
    path.join(
      '/App.app/Contents/Resources/app.asar/node_modules/electron-sparkle-updater',
      'package.json'
    )
  )
})

void test('falls back to the conventional unpacked node_modules path', () => {
  const addon = path.join(
    '/Resources',
    'app.asar.unpacked',
    'node_modules',
    'electron-sparkle-updater',
    'native',
    'build',
    'Release',
    'sparkle_bridge.node'
  )
  assert.equal(
    resolveSparkleAddonPath({
      isPackaged: true,
      resourcesPath: '/Resources',
      exists: (candidate) => candidate === addon
    }),
    addon
  )
  assert.equal(
    resolveSparkleAddonPath({
      isPackaged: true,
      resourcesPath: '/Resources',
      exists: () => false
    }),
    null
  )
})
