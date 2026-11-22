import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyIrohPackaging, irohPackagingPlan, irohTargetPlatform } from './iroh-packaging.mjs'

test('builds without relays read no module and leave packaging unchanged', () => {
  for (const relays of [undefined, '', '  ']) {
    const plan = irohPackagingPlan({ relays, platform: 'darwin', architectures: ['arm64'] })
    const config = { extraResources: [{ from: 'a', to: 'b' }] }
    const before = structuredClone(config)
    applyIrohPackaging({ config, plan })
    assert.deepEqual(config, before)
  }
})

test('relay builds ship the module for every selected architecture into resources', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'iroh-packaging-'))
  try {
    const selection = {
      relays: 'https://relay-us.example.invalid',
      addonDirectory: directory,
      platform: 'darwin',
      architectures: ['arm64', 'x64']
    }
    for (const change of [
      { addonDirectory: undefined },
      { architectures: ['universal'] },
      { architectures: [] },
      { platform: 'freebsd' }
    ])
      assert.throws(() => irohPackagingPlan({ ...selection, ...change }))
    const plan = irohPackagingPlan(selection)
    const config = {}
    mkdirSync(path.join(directory, 'arm64'))
    writeFileSync(path.join(directory, 'arm64', 'lody-iroh.darwin-arm64.node'), '')
    assert.throws(() => applyIrohPackaging({ config, plan }), /x64/)
    mkdirSync(path.join(directory, 'x64'))
    writeFileSync(path.join(directory, 'x64', 'lody-iroh.darwin-x64.node'), '')
    applyIrohPackaging({ config, plan })
    assert.deepEqual(config.extraResources, [
      {
        from: path.join(directory, '${arch}', 'lody-iroh.darwin-${arch}.node'),
        to: 'lody-iroh.darwin-${arch}.node'
      }
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the target platform follows the builder flag', () => {
  assert.equal(irohTargetPlatform(['--mac', '--arm64'], 'linux'), 'darwin')
  assert.equal(irohTargetPlatform(['--x64'], 'win32'), 'win32')
  assert.throws(() => irohTargetPlatform(['--mac', '--win']))
})
