import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { passkeyPackagingPlan, applyPasskeyPackaging } from './passkey-packaging.mjs'

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
