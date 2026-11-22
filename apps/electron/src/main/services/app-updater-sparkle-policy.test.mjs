import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  hasCodeSigningCredentials,
  isMacPackaging,
  resolvePackagedSparkleFeedUrl,
  resolveSparkleRebuildArch,
  shouldAdHocSignSparkleApp,
  shouldInjectSparklePublicKey,
  sparkleInfoPlistPath
} from '../../../scripts/sparkle-packaging.mjs'
import { readUpdaterReleaseMetadata } from './app-updater-metadata.ts'
import { sparkleEventToStatePatch } from './app-updater-sparkle-events.ts'
import {
  DEFAULT_SPARKLE_APPCAST_URL,
  resolveSparkleAddonPath,
  resolveSparkleAppcastUrl,
  shouldConstructUpdaterEnabled,
  shouldUseSparkleUpdater,
  sparklePackageJsonPathFromModuleEntry
} from './app-updater-sparkle-policy.ts'

void test('keeps OSS local updater off unless explicitly force-enabled', () => {
  assert.equal(shouldConstructUpdaterEnabled({ localPlatform: true, forceEnable: false }), false)
  assert.equal(shouldConstructUpdaterEnabled({ localPlatform: true, forceEnable: true }), true)
  assert.equal(shouldConstructUpdaterEnabled({ localPlatform: false, forceEnable: false }), true)
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

void test('reads standard and localized release notes from update metadata', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseName: 'Lody 1.2.3',
        releaseDate: '2026-08-10',
        releaseNotes: 'English fallback',
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.3',
            locales: {
              en: 'English notes',
              zh_CN: '中文更新内容'
            }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: 'Lody 1.2.3',
      releaseDate: '2026-08-10',
      releaseNotes: 'English fallback',
      releaseNotesByLocale: {
        en: 'English notes',
        zh_CN: '中文更新内容'
      }
    }
  )
})

void test('keeps compatibility with array-shaped release notes', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseNotes: [{ version: '1.2.3', note: 'Newest release' }]
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: 'Newest release',
      releaseNotesByLocale: undefined
    }
  )
})

void test('ignores malformed, empty, and oversized remote metadata', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseName: [],
        releaseDate: '   ',
        releaseNotes: 'x'.repeat(64 * 1024 + 1),
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.3',
            locales: { en: 42, zh_CN: '' }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      releaseNotesByLocale: undefined
    }
  )
})

void test('rejects localized notes whose content version does not match the update', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseNotes: 'Standard fallback',
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.2',
            locales: { en: 'Stale localized notes', zh_CN: '过期说明' }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: 'Standard fallback',
      releaseNotesByLocale: undefined
    }
  )
})

const NOW = 1_700_000_000_000

void test('maps a user-initiated check onto the checking phase and clears progress', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'checking' }, NOW), {
    phase: 'checking',
    error: undefined,
    checkedAtMs: NOW,
    percent: undefined,
    bytesPerSecond: undefined,
    transferred: undefined,
    total: undefined
  })
})

void test('maps an available update onto downloading so the sidebar banner can appear', () => {
  assert.deepEqual(
    sparkleEventToStatePatch(
      {
        type: 'update-available',
        version: '1.2.3',
        releaseName: 'Lody 1.2.3',
        releaseDate: '2026-08-30T00:00:00Z',
        releaseNotes: 'Fixes the updater banner'
      },
      NOW
    ),
    {
      phase: 'downloading',
      availableVersion: '1.2.3',
      downloadedVersion: undefined,
      releaseName: 'Lody 1.2.3',
      releaseDate: '2026-08-30T00:00:00Z',
      releaseNotes: 'Fixes the updater banner',
      releaseNotesByLocale: undefined,
      checkedAtMs: NOW,
      error: undefined
    }
  )
})

void test('maps download progress onto percent and byte counts', () => {
  assert.deepEqual(
    sparkleEventToStatePatch(
      {
        type: 'download-progress',
        percent: 42.6,
        transferred: 426,
        total: 1000
      },
      NOW
    ),
    {
      phase: 'downloading',
      percent: 42.6,
      bytesPerSecond: undefined,
      transferred: 426,
      total: 1000
    }
  )
})

void test('derives percent from transferred/total when Sparkle omits it', () => {
  assert.equal(
    sparkleEventToStatePatch(
      {
        type: 'download-progress',
        transferred: 25,
        total: 50
      },
      NOW
    )?.percent,
    50
  )
})

void test('maps a finished download onto the downloaded phase for Restart', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'update-downloaded', version: '1.2.4' }, NOW), {
    phase: 'downloaded',
    downloadedVersion: '1.2.4',
    availableVersion: '1.2.4',
    checkedAtMs: NOW,
    error: undefined
  })
})

void test('maps no-update onto up_to_date and clears the banner fields', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'update-not-available' }, NOW), {
    phase: 'up_to_date',
    availableVersion: undefined,
    downloadedVersion: undefined,
    percent: undefined,
    bytesPerSecond: undefined,
    transferred: undefined,
    total: undefined,
    checkedAtMs: NOW,
    error: undefined
  })
})

void test('maps a Sparkle failure onto the error phase', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'error', message: 'feed unreachable' }, NOW), {
    phase: 'error',
    error: 'feed unreachable',
    checkedAtMs: NOW
  })
})

void test('ignores unknown or malformed Sparkle events', () => {
  assert.equal(sparkleEventToStatePatch({ type: 'nope' }, NOW), null)
  assert.equal(sparkleEventToStatePatch(null, NOW), null)
  assert.equal(sparkleEventToStatePatch('checking', NOW), null)
  assert.equal(sparkleEventToStatePatch({ type: 'error' }, NOW), null)
})
