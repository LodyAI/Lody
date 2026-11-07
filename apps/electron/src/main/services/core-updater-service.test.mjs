import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readdir, realpath, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { CoreUpdaterService } from './core-updater-service.ts'
import { buildRelease } from '../../../scripts/core-ota/build.mjs'
import { openActivation } from '../../../scripts/core-ota/activation.mjs'

test('public feed stages a signed executable Core and confirms its matching attempt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lody-core-consumer-')))
  try {
    const input = join(root, 'input')
    await mkdir(join(input, 'out/main'), { recursive: true })
    await writeFile(
      join(input, 'out/main/application.js'),
      'exports.marker = require("./child.cjs")'
    )
    await writeFile(join(input, 'out/main/child.cjs'), 'module.exports = require("host-fixture")')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const metadata = {
      product: 'lody',
      channel: 'stable',
      platform: process.platform,
      arch: process.arch,
      hostAbi: 'abi1',
      publicKey,
      feedUrl: 'https://updates.example/manifest.json'
    }
    let { manifest, packs } = await buildRelease({
      input,
      output: join(root, 'published'),
      release: 'r1',
      seq: 1,
      ...metadata,
      privateKey
    })
    let packRequests = 0
    let receivedBytes = 0
    const fetchImpl = async (url) => {
      if (String(url).endsWith('manifest.json')) return new Response(JSON.stringify(manifest))
      const pack = packs.find((p) => String(url).endsWith(p.path))
      assert.ok(pack)
      packRequests++
      receivedBytes += pack.bytes.length
      return new Response(pack.bytes)
    }
    const activation = await openActivation({
      root: join(root, 'store'),
      installed: metadata,
      publicKey,
      lease: { assertHeld() {} }
    })
    const service = new CoreUpdaterService(metadata, activation, fetchImpl)
    await service.loadApplication(async () => ({ marker: 0 }))
    const states = []
    assert.deepEqual(await service.check((s) => states.push(s)), { handled: true, started: true })
    assert.equal(states.at(-1).phase, 'downloaded')
    const retainedState = states.at(-1)
    assert.deepEqual(await service.check((s) => states.push(s)), { handled: true, started: true })
    assert.equal(
      states.at(-1),
      retainedState,
      'rechecking preserves the downloaded candidate state'
    )

    assert.ok(receivedBytes > 0)
    const firstRequests = packRequests
    const firstBytes = receivedBytes
    ;({ manifest, packs } = await buildRelease({
      input,
      output: join(root, 'published-r3'),
      release: 'r3',
      seq: 3,
      ...metadata,
      privateKey
    }))
    const nextService = new CoreUpdaterService(metadata, activation, fetchImpl)
    assert.deepEqual(await nextService.check(() => {}), { handled: true, started: true })
    assert.equal(packRequests, firstRequests, 'retained verified objects avoid all pack requests')
    assert.equal(
      receivedBytes,
      firstBytes,
      'skipping r2 requires no intermediate manifest or content'
    )

    const resources = join(root, 'resources')
    await mkdir(resources)
    const hostPackage = join(resources, 'app.asar/node_modules/host-fixture')
    await mkdir(hostPackage, { recursive: true })
    await writeFile(join(hostPackage, 'package.json'), JSON.stringify({ main: 'index.cjs' }))
    await writeFile(join(hostPackage, 'index.cjs'), 'module.exports = 42')
    await writeFile(
      join(resources, 'core-ota-host.json'),
      JSON.stringify({
        schemaVersion: 1,
        ...metadata,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' })
      })
    )
    const restarted = await CoreUpdaterService.open(resources, join(root, 'store'), () => true)
    assert.ok(restarted)
    assert.equal(
      (
        await restarted.loadApplication(async () => {
          throw Error('unexpected builtin')
        })
      ).marker,
      42
    )
    const probe = `import { CoreUpdaterService } from ${JSON.stringify(new URL('./core-updater-service.ts', import.meta.url).href)};
      const service = await CoreUpdaterService.open(${JSON.stringify(resources)}, ${JSON.stringify(join(root, 'store'))}, () => true);
      const application = await service.loadApplication(() => { throw Error('unexpected builtin') });
      if (application.marker !== 42) throw Error('CJS external resolution failed');
      await service.markMainReady(); await service.acknowledgeHealthy();`
    // Confirm this process before the independent restart begins its own attempt.
    await restarted.markMainReady()
    await restarted.acknowledgeHealthy()
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'pipe' })
    await restarted.markMainReady()
    await restarted.acknowledgeHealthy()
    await restarted.markMainReady()
    await restarted.acknowledgeHealthy()
  } finally {
    async function unlock(directory) {
      await chmod(directory, 0o700)
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await unlock(join(directory, entry.name))
    }
    await unlock(root)
    await rm(root, { recursive: true, force: true })
  }
})

test('missing installed metadata leaves the full updater available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-core-missing-'))
  try {
    assert.equal(await CoreUpdaterService.open(root, join(root, 'store'), () => true), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('duplicate manifest keys are rejected before interpretation', async () => {
  const { parseCoreManifest } = await import('./core-updater-service.ts')
  assert.throws(() => parseCoreManifest('{"hostAbi":"a","hostAbi":"b"}'), /Duplicate/)
  assert.throws(() => parseCoreManifest('{"objects":{"a":1,"\\u0061":2}}'), /Duplicate/)
})

test('missing or incompatible public Core candidates defer to native updater', async () => {
  const metadata = { feedUrl: 'https://updates.example/manifest.json', hostAbi: 'installed' }
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(JSON.stringify({ hostAbi: 'other' }))
  ]) {
    const service = new CoreUpdaterService(metadata, {}, async () => response)
    assert.equal((await service.check(() => {})).handled, false)
    assert.equal(service.ready, false)
  }
})

test('health waits for main initialization even when renderer IPC completes first', async () => {
  let acknowledged = false
  const service = new CoreUpdaterService(
    {},
    {
      async acknowledge() {
        acknowledged = true
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await service.acknowledgeHealthy()
  assert.equal(acknowledged, false)
  await service.markMainReady()
  assert.equal(acknowledged, true)
})

test('health timeout rescues an unconfirmed Core without abandoning the failed attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let rescued = false
  let abandoned = false
  let resolveRescue
  const rescueDone = new Promise((resolve) => {
    resolveRescue = resolve
  })
  const service = new CoreUpdaterService(
    {},
    {
      async fail() {},
      async abandon() {
        abandoned = true
      }
    }
  )
  service.entry = new URL(import.meta.url).pathname
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  service.rescue = () => {
    rescued = true
    resolveRescue?.()
  }
  // Importing this cached test module avoids evaluating application code in the fixture.
  await service.loadApplication(async () => ({}))
  t.mock.timers.tick(60_000)
  await rescueDone
  assert.equal(rescued, true)
  await service.abandonHealthAttempt()
  assert.equal(abandoned, false)
})

test('external evaluation failure requests clean rescue without evaluating builtin in the process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-core-failure-'))
  try {
    const entry = join(root, 'broken.mjs')
    await writeFile(entry, 'throw new Error("partial Core evaluation")')
    const service = new CoreUpdaterService({}, { async fail() {} })
    service.entry = entry
    let rescued = false
    let builtinLoaded = false
    service.rescue = () => {
      rescued = true
    }
    await assert.rejects(
      service.loadApplication(async () => {
        builtinLoaded = true
      }),
      /partial Core evaluation/
    )
    assert.equal(rescued, true)
    assert.equal(builtinLoaded, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('graceful quit cancels initial health rescue and retains candidate eligibility', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let abandoned = false
  let rescued = false
  const service = new CoreUpdaterService(
    {},
    {
      async abandon() {
        abandoned = true
      },
      async fail() {
        throw new Error('must not reject graceful quit')
      }
    }
  )
  service.entry = new URL(import.meta.url).pathname
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  service.setHealthRescue(() => {
    rescued = true
  })
  await service.loadApplication(async () => ({}))
  await service.abandonHealthAttempt()
  t.mock.timers.tick(120_000)
  assert.equal(abandoned, true)
  assert.equal(rescued, false)
})

test('successful initial health never triggers rescue for later renderer notifications', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let rescued = false
  const service = new CoreUpdaterService({}, { async acknowledge() {} })
  service.entry = new URL(import.meta.url).pathname
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  service.setHealthRescue(() => {
    rescued = true
  })
  await service.loadApplication(async () => ({}))
  await service.markMainReady()
  await service.acknowledgeHealthy()
  t.mock.timers.tick(120_000)
  await service.acknowledgeHealthy()
  assert.equal(rescued, false)
})

test('recovery wait is bounded without forcing an unconfirmed quit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signalStarted
  const started = new Promise((resolve) => {
    signalStarted = resolve
  })
  const service = new CoreUpdaterService({}, { async fail() {} })
  service.setHealthRescue(() => {
    signalStarted()
    return new Promise(() => {})
  })
  const outcome = assert.rejects(service.failInitialHealth(), /quit remains unconfirmed/)
  await started
  t.mock.timers.tick(15_000)
  await outcome
})

test('activation shutdown write failure does not prevent independent teardown', async () => {
  const service = new CoreUpdaterService(
    {},
    {
      async abandon() {
        throw new Error('disk unavailable')
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  let released = false
  await service.abandonHealthAttempt()
  released = true
  assert.equal(released, true)
})
