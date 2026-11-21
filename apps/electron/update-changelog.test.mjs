import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveElectronReleaseProfile } from './release-profile.mjs'
import {
  createElectronBuilderConfig,
  loadElectronUpdateReleaseInfo,
  parseChangelogMdx,
  validateChangelogVersion
} from './update-changelog.mjs'

void test('the effective Nightly builder config registers only Nightly and preserves signing', async () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const electronRequire = createRequire(path.join(repoRoot, 'apps/electron/package.json'))
  const builderRequire = createRequire(electronRequire.resolve('electron-builder'))
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js')
  const profile = resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion: '0.89.4',
    env: {
      LODY_RELEASE_CHANNEL: 'nightly',
      LODY_NIGHTLY_BUILD_NUMBER: '42',
      LODY_NIGHTLY_VERSION: '0.90.0-nightly.0',
      LODY_SOURCE_SHA: 'a'.repeat(40),
      LODY_SOURCE_SHA: 'b'.repeat(40),
      LODY_BUILD_TIMESTAMP: '2026-09-23T00:00:00.000Z',
      LODY_BUILD_RUN_ID: '123'
    }
  })
  const config = createElectronBuilderConfig({
    baseConfigPath: path.join(repoRoot, 'apps/electron/electron-builder.yml'),
    repoRoot,
    version: profile.version,
    releaseProfile: profile,
    updateBaseUrl: 'https://updates.example.com/production/nightly',
    updateChannel: 'nightly'
  })
  await validateConfiguration(config, { isEnabled: false })
  assert.equal(config.extends, undefined)
  assert.deepEqual(
    config.protocols.flatMap((entry) => entry.schemes),
    ['ai.lody.nightly']
  )
  assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist')
  assert.equal(config.mac.notarize, true)
  assert.equal(config.extraMetadata.version, profile.version)
  assert.equal(config.extraMetadata.desktopName, 'ai.lody.desktop.nightly.desktop')
  assert.equal(config.publish.channel, 'nightly')
  assert.equal(config.win.icon, path.join(repoRoot, 'apps/electron/resources/icon-nightly-win.png'))
  assert.ok(existsSync(config.win.icon))
  assert.equal(config.mac.icon, 'resources/icon-nightly.png')
  assert.equal(config.linux.icon, 'resources/icon-nightly.png')
  assert.deepEqual(config.linux.target, ['AppImage', 'snap', 'deb'])
  const { expandMacro } = builderRequire('app-builder-lib/out/util/macroExpander.js')
  for (const [target, nativeArch, extension] of [
    ['appImage', 'x86_64', 'AppImage'],
    ['deb', 'amd64', 'deb'],
    ['snap', 'amd64', 'snap']
  ]) {
    assert.equal(
      expandMacro(
        config[target].artifactName,
        nativeArch,
        { version: profile.version },
        { ext: extension }
      ),
      `Lody-${profile.version}-x64-nightly.${extension}`
    )
  }

  const arm64Config = createElectronBuilderConfig({
    baseConfigPath: path.join(repoRoot, 'apps/electron/electron-builder.yml'),
    repoRoot,
    version: profile.version,
    releaseProfile: profile,
    updateBaseUrl: 'https://updates.example.com/production/nightly',
    updateChannel: 'nightly',
    linuxArtifactArch: 'arm64'
  })
  for (const [target, nativeArch, extension] of [
    ['appImage', 'arm64', 'AppImage'],
    ['deb', 'arm64', 'deb']
  ]) {
    assert.equal(
      expandMacro(
        arm64Config[target].artifactName,
        nativeArch,
        { version: profile.version },
        { ext: extension }
      ),
      `Lody-${profile.version}-arm64-nightly.${extension}`
    )
  }
})

function createFixture() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'lody-update-changelog-test-'))
  const changelogRoot = path.join(repoRoot, 'site-docs', 'content', 'changelog')
  mkdirSync(path.join(changelogRoot, 'en'), { recursive: true })
  mkdirSync(path.join(changelogRoot, 'zh'), { recursive: true })
  return { repoRoot, changelogRoot }
}

function writeChangelog(changelogRoot, locale, name, { version, date, body, draft = false }) {
  writeFileSync(
    path.join(changelogRoot, locale, `${name}.mdx`),
    `---\ntitle: '${name}'\nversion: ${version}\ndate: ${date}\ndraft: ${String(draft)}\n---\n\n${body}\n`,
    'utf8'
  )
}

void test('loads exact-version localized notes for a prerelease package', (t) => {
  const { repoRoot, changelogRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
  writeChangelog(changelogRoot, 'en', 'english', {
    version: '1.2.3-next.4',
    date: '2026-08-10',
    body: '### Fixes\n\n- Exact prerelease fix.'
  })
  writeChangelog(changelogRoot, 'zh', 'chinese', {
    version: '1.2.3-next.4',
    date: '2026-08-10',
    body: '### 修复\n\n- 精确的预发布修复。'
  })

  assert.deepEqual(loadElectronUpdateReleaseInfo({ repoRoot, version: '1.2.3-next.4' }), {
    releaseNotes: '### Fixes\n\n- Exact prerelease fix.',
    releaseDate: '2026-08-10',
    vendor: {
      lodyChangelog: {
        contentVersion: '1.2.3-next.4',
        locales: {
          en: '### Fixes\n\n- Exact prerelease fix.',
          zh_CN: '### 修复\n\n- 精确的预发布修复。'
        }
      }
    }
  })
})

void test('creates an extending builder config with localized stable notes', (t) => {
  const { repoRoot, changelogRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
  writeFileSync(path.join(changelogRoot, 'en', 'unrelated-broken.mdx'), 'not frontmatter', 'utf8')
  writeFileSync(
    path.join(changelogRoot, 'zh', 'unrelated-empty.mdx'),
    '---\nversion: 9.9.9\ndraft: true\n---\n',
    'utf8'
  )
  for (const locale of ['en', 'zh']) {
    writeChangelog(changelogRoot, locale, locale, {
      version: '1.2.3',
      date: '2026-08-10',
      body: `- ${locale} notes`
    })
  }

  const config = createElectronBuilderConfig({
    baseConfigPath: '/repo/apps/electron/electron-builder.yml',
    repoRoot,
    version: '1.2.3',
    updateBaseUrl: 'https://updates.example.com/production',
    updateChannel: 'latest',
    sparkleAppcastUrl: 'https://updates.example.com/production/appcast.xml'
  })
  assert.equal(config.extends, '/repo/apps/electron/electron-builder.yml')
  assert.deepEqual(config.extraMetadata, { version: '1.2.3', homepage: 'https://lody.ai' })
  assert.deepEqual(config.publish, {
    provider: 'generic',
    url: 'https://updates.example.com/production',
    channel: 'latest'
  })
  assert.deepEqual(config.mac, {
    extendInfo: { SUFeedURL: 'https://updates.example.com/production/appcast.xml' }
  })
  assert.equal(config.releaseInfo.releaseNotes, '- en notes')
  assert.equal(config.releaseInfo.vendor.lodyChangelog.locales.zh_CN, '- zh notes')
})

void test('creates a staging builder config without requiring changelogs', (t) => {
  const { repoRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))

  const config = createElectronBuilderConfig({
    baseConfigPath: '/repo/apps/electron/electron-builder.yml',
    repoRoot,
    version: '1.2.3-next.4',
    includeReleaseInfo: false,
    updateBaseUrl: 'https://updates.example.com/staging',
    updateChannel: 'next'
  })

  assert.deepEqual(config, {
    extends: '/repo/apps/electron/electron-builder.yml',
    extraMetadata: { version: '1.2.3-next.4', homepage: 'https://lody.ai' },
    publish: {
      provider: 'generic',
      url: 'https://updates.example.com/staging',
      channel: 'next'
    }
  })
})

void test('requires an explicit updater feed even when staging omits changelogs', (t) => {
  const { repoRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))

  assert.throws(
    () =>
      createElectronBuilderConfig({
        baseConfigPath: '/repo/apps/electron/electron-builder.yml',
        repoRoot,
        version: '1.2.3-next.4',
        includeReleaseInfo: false,
        updateChannel: 'next'
      }),
    /Missing Electron update base URL/u
  )
})

void test('rejects a release when one localized changelog is missing', (t) => {
  const { repoRoot, changelogRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
  writeChangelog(changelogRoot, 'en', 'english', {
    version: '1.2.3',
    date: '2026-08-10',
    body: '- Available in English only.'
  })

  assert.throws(
    () => loadElectronUpdateReleaseInfo({ repoRoot, version: '1.2.3' }),
    /exactly one published zh changelog/u
  )
})

void test('draft entries do not satisfy release metadata', (t) => {
  const { repoRoot, changelogRoot } = createFixture()
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
  for (const locale of ['en', 'zh']) {
    writeChangelog(changelogRoot, locale, 'draft', {
      version: '1.2.3',
      date: '2026-08-10',
      body: '- Not ready.',
      draft: true
    })
  }

  assert.throws(
    () => loadElectronUpdateReleaseInfo({ repoRoot, version: '1.2.3' }),
    /exactly one published en changelog/u
  )
})

void test('validates semver and changelog bodies', () => {
  assert.equal(validateChangelogVersion('2.4.0-beta.7+build.2'), '2.4.0-beta.7+build.2')
  assert.throws(() => validateChangelogVersion('next'), /not valid semver/u)
  assert.throws(() => validateChangelogVersion('01.2.3'), /not valid semver/u)
  assert.throws(() => validateChangelogVersion('1.2.3-..'), /not valid semver/u)
  assert.throws(
    () => parseChangelogMdx('---\nversion: 1.0.0\n---\n', 'empty.mdx'),
    /Missing changelog body/u
  )
  assert.throws(
    () =>
      parseChangelogMdx(
        '---\nversion: 1.0.0\ndate: 2026-02-30\n---\n\n- Impossible date.\n',
        'invalid-date.mdx'
      ),
    /Invalid date/u
  )
  assert.throws(
    () => parseChangelogMdx('---\nversion: 1.0.0\n---\n\n- Missing date.\n', 'missing-date.mdx'),
    /Missing date/u
  )
})
