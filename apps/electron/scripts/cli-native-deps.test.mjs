import assert from 'node:assert/strict'
import { mkdtemp, cp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { roostPrebuildFileName, stageRoostBinding } from './cli-native-deps.mjs'
import { probeRoostRuntime } from './roost-runtime-probe.mjs'

test('stages all six published Roost targets, preserves relative Worker paths and reopens SQLite', async () => {
  const source = path.resolve(import.meta.dirname, '../../cli/node_modules/@loro-dev/roost-node')
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-roost-stage-'))
  const destination = path.join(
    directory,
    'resources',
    'cli',
    'node_modules',
    '@loro-dev',
    'roost-node'
  )
  try {
    await cp(source, destination, { recursive: true, dereference: true })
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['arm64', 'x64']) {
        const target = { platform, arch }
        stageRoostBinding(source, destination, target)
        assert.deepEqual(
          (await readdir(destination)).filter((name) => name.endsWith('.node')),
          [roostPrebuildFileName(target)]
        )
      }
    }
    const target = { platform: process.platform, arch: process.arch }
    stageRoostBinding(source, destination, target)
    await probeRoostRuntime(destination)
    assert.throws(
      () => stageRoostBinding(source, destination, { platform: 'linux', arch: 'armv7l' }),
      /No Roost native binding/
    )
    assert.throws(() => stageRoostBinding(directory, destination, target), /is missing/)
    // A rejected target cannot destroy the previously staged working runtime.
    await probeRoostRuntime(destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
