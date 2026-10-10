import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  roostPrebuildFileName,
  stageRoostBinding,
  stageLoroRuntimePackage
} from './cli-native-deps.mjs'
import { probeRoostRuntime } from './roost-runtime-probe.mjs'

const publishedSource = path.resolve(
  import.meta.dirname,
  '../../cli/node_modules/@loro-dev/roost-node'
)

test('staged Loro supports CommonJS resolution and ESM worker snapshot round trips without browser distributions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-loro-stage-'))
  try {
    const destination = path.join(directory, 'node_modules/loro-crdt')
    stageLoroRuntimePackage(
      path.resolve(import.meta.dirname, '../../cli/node_modules/loro-crdt'),
      destination
    )
    assert.deepEqual((await readdir(destination)).sort(), ['LICENSE', 'nodejs', 'package.json'])
    const require = createRequire(path.join(directory, 'probe.cjs'))
    const { LoroDoc } = require('loro-crdt')
    assert.equal(require.resolve('loro-crdt'), require.resolve('loro-crdt/nodejs'))
    const doc = new LoroDoc()
    doc.getText('text').insert(0, 'staged runtime')
    const workerPath = path.join(directory, 'worker.mjs')
    await writeFile(
      workerPath,
      `
      import { parentPort, workerData } from 'node:worker_threads'
      import { LoroDoc } from 'loro-crdt'
      const doc = new LoroDoc()
      doc.import(workerData)
      doc.getText('text').insert(14, ' works')
      parentPort.postMessage(doc.export({ mode: 'snapshot' }))
    `
    )
    const worker = new Worker(workerPath, { workerData: doc.export({ mode: 'snapshot' }) })
    try {
      const snapshot = await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', (code) => reject(new Error(`Loro worker exited before reply: ${code}`)))
      })
      const restored = new LoroDoc()
      restored.import(snapshot)
      assert.equal(restored.getText('text').toString(), 'staged runtime works')
    } finally {
      await worker.terminate()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function packageFixture(directory, layout = 'split') {
  const source = path.join(directory, 'source')
  const destination = path.join(directory, 'staged')
  await cp(publishedSource, source, { recursive: true, dereference: true })
  await cp(publishedSource, destination, { recursive: true, dereference: true })
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  const require = createRequire(path.join(await realpath(publishedSource), 'package.json'))
  const binaries = new Map()
  metadata.optionalDependencies = {}
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      const binary = roostPrebuildFileName({ platform, arch })
      const name = `@loro-dev/roost-node-${binary.slice('roost.'.length, -'.node'.length)}`
      // Only the host binding executes. Foreign targets use distinct selection fixtures.
      const bytes =
        platform === process.platform && arch === process.arch
          ? await readFile(require.resolve(name))
          : Buffer.from(`synthetic Roost binding for ${platform}-${arch}`)
      binaries.set(binary, bytes)
      if (layout === 'adjacent') {
        await writeFile(path.join(source, binary), bytes)
        continue
      }
      const child = path.join(source, 'node_modules', ...name.split('/'))
      await mkdir(child, { recursive: true })
      await writeFile(path.join(child, binary), bytes)
      await writeFile(
        path.join(child, 'package.json'),
        JSON.stringify({
          name,
          version: metadata.version,
          main: binary,
          os: [platform],
          cpu: [arch]
        })
      )
      metadata.optionalDependencies[name] = metadata.version
    }
  }
  await writeFile(path.join(source, 'package.json'), JSON.stringify(metadata))
  return { source, destination, metadata, binaries }
}

test('stages adjacent target fixtures and the installed host package, preserves Worker paths and reopens SQLite', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-roost-stage-'))
  try {
    const { source, destination, binaries } = await packageFixture(directory, 'adjacent')
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['arm64', 'x64']) {
        const target = { platform, arch }
        stageRoostBinding(source, destination, target)
        assert.deepEqual(
          (await readdir(destination)).filter((name) => name.endsWith('.node')),
          [roostPrebuildFileName(target)]
        )
        assert.deepEqual(
          await readFile(path.join(destination, roostPrebuildFileName(target))),
          binaries.get(roostPrebuildFileName(target))
        )
      }
    }
    const target = { platform: process.platform, arch: process.arch }
    stageRoostBinding(publishedSource, destination, target)
    await probeRoostRuntime(destination)
    assert.throws(
      () => stageRoostBinding(publishedSource, destination, { platform: 'linux', arch: 'armv7l' }),
      /No Roost native binding/
    )
    assert.throws(() => stageRoostBinding(directory, destination, target), /is missing/)
    // A rejected target cannot destroy the previously staged working runtime.
    await probeRoostRuntime(destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stages installed split platform packages for all targets and retains a working runtime on version drift', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-roost-split-stage-'))
  try {
    const { source, destination, binaries } = await packageFixture(directory)
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['arm64', 'x64']) {
        const target = { platform, arch }
        stageRoostBinding(source, destination, target)
        assert.deepEqual(
          (await readdir(destination)).filter((file) => file.endsWith('.node')),
          [roostPrebuildFileName(target)]
        )
        assert.deepEqual(
          await readFile(path.join(destination, roostPrebuildFileName(target))),
          binaries.get(roostPrebuildFileName(target))
        )
      }
    }
    const target = { platform: process.platform, arch: process.arch }
    stageRoostBinding(source, destination, target)
    await probeRoostRuntime(destination)
    const name = `@loro-dev/roost-node-${roostPrebuildFileName(target).slice('roost.'.length, -'.node'.length)}`
    const metadata = path.join(source, 'node_modules', ...name.split('/'), 'package.json')
    const child = JSON.parse(await readFile(metadata, 'utf8'))
    child.version = '0.0.0'
    await writeFile(metadata, JSON.stringify(child))
    assert.throws(() => stageRoostBinding(source, destination, target), /version mismatch/)
    await probeRoostRuntime(destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stages an exact downloaded split package and preserves the previous binding after a fetch failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-roost-split-download-'))
  try {
    const { source, destination, metadata } = await packageFixture(directory)
    const target = { platform: process.platform, arch: process.arch }
    const name = `@loro-dev/roost-node-${roostPrebuildFileName(target).slice('roost.'.length, -'.node'.length)}`
    const downloaded = path.join(directory, 'downloaded')
    await cp(path.join(source, 'node_modules', ...name.split('/')), downloaded, { recursive: true })
    await rm(path.join(source, 'node_modules'), { recursive: true, force: true })
    stageRoostBinding(source, destination, target, {
      fetchBinaryPackage: (packageName, version) => {
        assert.equal(packageName, name)
        assert.equal(version, metadata.version)
        return { packageDir: downloaded, cleanup: () => {} }
      }
    })
    await probeRoostRuntime(destination)
    const binary = path.join(destination, roostPrebuildFileName(target))
    const before = await readFile(binary)
    assert.throws(
      () =>
        stageRoostBinding(source, destination, target, {
          fetchBinaryPackage: () => {
            throw new Error('fixture download unavailable')
          }
        }),
      /download unavailable/
    )
    assert.deepEqual(await readFile(binary), before)
    await probeRoostRuntime(destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
