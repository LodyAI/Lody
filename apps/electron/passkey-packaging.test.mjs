import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  passkeyPackagingPlan,
  applyPasskeyPackaging,
  passkeyProfileFindings,
  readProvisioningProfile
} from './passkey-packaging.mjs'
import {
  parseBuildArgs,
  resolveElectronVersion,
  resolveNodeGypBin
} from './scripts/build-passkey-addons.mjs'

const selection = {
  enabled: '1',
  macPackaging: true,
  architectures: ['arm64', 'x64'],
  addonDirectory: '/tmp/addons',
  provisioningProfile: '/tmp/profile'
}
test('ordinary desktop builds do not read native inputs or change packaging', () => {
  for (const enabled of [undefined, '', '0', 'true']) {
    const plan = passkeyPackagingPlan({ enabled, macPackaging: false })
    const config = { mac: { entitlements: 'original', entitlementsInherit: 'inherit' } }
    const before = structuredClone(config)
    applyPasskeyPackaging({ config, plan })
    assert.deepEqual(config, before)
  }
})
test('passkey packages target only the associated cloud app and require every selected architecture', () => {
  for (const change of [
    { macPackaging: false },
    { appId: 'ai.lody.desktop.nightly' },
    { architectures: ['universal'] },
    { addonDirectory: undefined },
    { provisioningProfile: undefined }
  ]) {
    assert.throws(() => passkeyPackagingPlan({ ...selection, ...change }))
  }
  const plan = passkeyPackagingPlan(selection)
  assert.deepEqual(
    plan.addons.map(({ arch }) => arch),
    ['arm64', 'x64']
  )
  assert.equal(plan.resource.to, 'passkey_bridge.node')
  assert.equal(plan.resource.from, '/tmp/addons/${arch}/passkey_bridge.node')
})
for (const arch of ['arm64', 'x64'])
  test(
    `opted-in ${arch} packaging preserves main safety entitlements and keeps vault rights out of Helpers`,
    { skip: process.platform !== 'darwin' },
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'passkey-package-test-'))
      try {
        const header = Buffer.alloc(32)
        header.writeUInt32LE(0xfeedfacf, 0)
        header.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
        header.writeUInt32LE(arch === 'arm64' ? 0 : 3, 8)
        header.writeUInt32LE(8, 12)
        mkdirSync(path.join(directory, arch))
        writeFileSync(path.join(directory, arch, 'passkey_bridge.node'), header)
        writeFileSync(path.join(directory, 'profile'), 'synthetic profile placeholder')
        const plan = passkeyPackagingPlan({
          ...selection,
          architectures: [arch],
          addonDirectory: directory,
          provisioningProfile: path.join(directory, 'profile')
        })
        const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
        const inherit = path.join(repoRoot, 'apps/electron/build/entitlements.mac.inherit.plist')
        const originalInherit = readFileSync(inherit)
        const config = {
          mac: {
            entitlementsInherit: inherit,
            extraResources: [{ from: 'existing', to: 'existing' }]
          }
        }
        applyPasskeyPackaging({ config, plan, repoRoot, generatedDirectory: directory })
        const parsed = JSON.parse(
          execFileSync('plutil', ['-convert', 'json', '-o', '-', config.mac.entitlements], {
            encoding: 'utf8'
          })
        )
        assert.equal(parsed['com.apple.security.cs.allow-jit'], true)
        assert.equal(parsed['com.apple.security.cs.disable-library-validation'], undefined)
        assert.deepEqual(parsed['com.apple.developer.associated-domains'], [
          'webcredentials:lody.ai'
        ])
        assert.equal(parsed['com.apple.application-identifier'], 'YTRMX32C99.ai.lody.desktop')
        assert.equal(parsed['com.apple.developer.team-identifier'], 'YTRMX32C99')
        assert.deepEqual(readFileSync(inherit), originalInherit)
        assert.equal(config.mac.entitlementsInherit, inherit)
        assert.equal(config.mac.provisioningProfile, plan.provisioningProfile)
        assert.deepEqual(config.mac.extraResources, [
          { from: 'existing', to: 'existing' },
          plan.resource
        ])
        assert.throws(() =>
          applyPasskeyPackaging({
            config: {},
            plan: {
              ...plan,
              addons: [{ arch: arch === 'arm64' ? 'x64' : 'arm64', file: plan.addons[0].file }]
            },
            repoRoot,
            generatedDirectory: directory
          })
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
const signature = {
  profile: {
    name: 'Synthetic Developer ID Passkey',
    expirationDate: '2044-11-19T04:01:46Z',
    provisionsAllDevices: true,
    certificateSha256: ['aa'.repeat(32)],
    entitlements: {
      'com.apple.application-identifier': 'YTRMX32C99.ai.lody.desktop',
      'com.apple.developer.team-identifier': 'YTRMX32C99',
      'com.apple.developer.associated-domains': '*',
      'keychain-access-groups': ['YTRMX32C99.*']
    }
  },
  signingCertificateSha256: 'aa'.repeat(32),
  entitlements: {
    'com.apple.application-identifier': 'YTRMX32C99.ai.lody.desktop',
    'com.apple.developer.team-identifier': 'YTRMX32C99',
    'com.apple.developer.associated-domains': ['webcredentials:lody.ai'],
    'com.apple.security.cs.allow-jit': true
  },
  now: new Date('2026-11-25T00:00:00Z')
}
test('a signed passkey app is releasable only when its embedded profile authorizes the signature', () => {
  assert.deepEqual(passkeyProfileFindings(signature), [])
  const rejected = (change, profile = {}) =>
    passkeyProfileFindings({
      ...signature,
      ...change,
      profile: { ...signature.profile, ...profile }
    })
  // 0.116.0: the profile was issued for another Developer ID certificate of the same team.
  assert.match(rejected({ signingCertificateSha256: 'bb'.repeat(32) })[0], /signing certificate bb/)
  assert.match(rejected({}, { expirationDate: '2026-11-24T00:00:00Z' })[0], /expired/)
  assert.match(rejected({}, { provisionsAllDevices: false })[0], /registered devices/)
  assert.deepEqual(rejected({}, { entitlements: {} }), [
    'profile does not grant com.apple.application-identifier',
    'profile does not grant com.apple.developer.team-identifier',
    'profile does not grant com.apple.developer.associated-domains'
  ])
  const groups = (...values) => rejected({ entitlements: { 'keychain-access-groups': values } })
  assert.deepEqual(groups('YTRMX32C99.ai.lody.desktop'), [])
  assert.deepEqual(groups('YTRMX32C99.ai.lody.desktop', 'OTHERTEAM1.shared'), [
    'profile does not grant keychain-access-groups'
  ])
})
test(
  'decoded provisioning profiles yield certificate digests, expiry and granted entitlements',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'passkey-profile-test-'))
    try {
      const plist = path.join(directory, 'profile.plist')
      const data = (text) => `<data>${Buffer.from(text).toString('base64')}</data>`
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Name</key><string>Synthetic Developer ID Passkey</string>
<key>ExpirationDate</key><date>2044-11-19T04:01:46Z</date>
<key>ProvisionsAllDevices</key><true/>
<key>DeveloperCertificates</key><array>${data('first certificate')}${data('second certificate')}</array>
<key>Entitlements</key><dict>
<key>com.apple.developer.associated-domains</key><string>*</string>
<key>keychain-access-groups</key><array><string>YTRMX32C99.*</string></array>
</dict></dict></plist>`
      )
      const digest = (text) => createHash('sha256').update(text).digest('hex')
      assert.deepEqual(readProvisioningProfile(plist), {
        name: 'Synthetic Developer ID Passkey',
        expirationDate: '2044-11-19T04:01:46Z',
        provisionsAllDevices: true,
        certificateSha256: [digest('first certificate'), digest('second certificate')],
        entitlements: {
          'com.apple.developer.associated-domains': '*',
          'keychain-access-groups': ['YTRMX32C99.*']
        }
      })
      writeFileSync(plist, '<plist version="1.0"><dict/></plist>')
      assert.deepEqual(readProvisioningProfile(plist).certificateSha256, [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
test('build-passkey-addons resolves the pinned Electron version and local node-gyp binary without network installs', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
  )
  assert.equal(resolveElectronVersion(), pkg.devDependencies.electron)
  const gypBin = resolveNodeGypBin()
  assert.equal(existsSync(gypBin), true, `Missing resolved node-gyp binary: ${gypBin}`)

  const parsed = parseBuildArgs(['--out', '/tmp/passkey-out', '--arches', 'arm64,x64'])
  assert.equal(parsed.outDir, path.resolve('/tmp/passkey-out'))
  assert.deepEqual(parsed.arches, ['arm64', 'x64'])

  assert.throws(() => parseBuildArgs([]))
  assert.throws(() => parseBuildArgs(['--out', '/tmp/passkey-out', '--arches', 'universal']))
  assert.throws(() => parseBuildArgs(['--out', '/tmp/passkey-out', '--arches', 'arm64,arm64']))
})
