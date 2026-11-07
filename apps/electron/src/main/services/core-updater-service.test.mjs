import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, readdir, realpath, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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

test('admitted health persistence excludes timeout and duplicate ACK writes', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const state = { healthy: false, failed: false }
  const service = new CoreUpdaterService(
    {},
    {
      async acknowledge() {
        await pending
        state.healthy = true
      },
      async fail() {
        state.failed = true
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await service.markMainReady()
  const first = service.acknowledgeHealthy()
  const second = service.acknowledgeHealthy()
  await service.failInitialHealth()
  release()
  await Promise.all([first, second])
  assert.deepEqual(state, { healthy: true, failed: false })
})

test('timeout admission excludes a late renderer ACK', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const state = { healthy: false, failed: false }
  const service = new CoreUpdaterService(
    {},
    {
      async acknowledge() {
        state.healthy = true
      },
      async fail() {
        await pending
        state.failed = true
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await service.markMainReady()
  const timeout = service.failInitialHealth()
  await service.acknowledgeHealthy()
  release()
  await timeout
  assert.deepEqual(state, { healthy: false, failed: true })
})

test('health, rescue and graceful shutdown persist distinct attempt outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-health-state-'))
  const installed = {
    product: 'lody',
    channel: 'test',
    platform: process.platform,
    arch: process.arch,
    hostAbi: 'test'
  }
  const options = { root, installed, lease: { assertHeld() {} } }
  try {
    const initial = await openActivation(options)
    const pointer = join(initial.directory, 'pointer.json')
    for (const outcome of ['ack', 'fail', 'abandon']) {
      await writeFile(
        pointer,
        JSON.stringify({
          current: 'candidate',
          previous: 'good',
          staged: null,
          attempt: { releaseId: 'candidate', attemptId: '00000000-0000-0000-0000-000000000001' },
          rejected: [],
          seq: 1
        })
      )
      const activation = await openActivation(options)
      const service = new CoreUpdaterService({}, activation)
      service.selection = {
        builtin: false,
        releaseId: 'candidate',
        attemptId: '00000000-0000-0000-0000-000000000001'
      }
      if (outcome === 'ack') {
        await service.markMainReady()
        await service.acknowledgeHealthy()
      } else if (outcome === 'fail') {
        await service.failInitialHealth()
        await service.acknowledgeHealthy()
      } else await service.abandonHealthAttempt()
      const saved = JSON.parse(await readFile(pointer, 'utf8'))
      assert.equal(saved.attempt, null)
      assert.equal(saved.current, outcome === 'fail' ? 'good' : 'candidate')
      assert.deepEqual(saved.rejected, outcome === 'fail' ? ['candidate'] : [])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed health persistence still hands recovery to the quit owner', async () => {
  let rescued = false
  const service = new CoreUpdaterService(
    {},
    {
      async fail() {
        throw new Error('disk unavailable')
      }
    }
  )
  service.setHealthRescue(() => {
    rescued = true
  })
  await service.failInitialHealth()
  assert.equal(rescued, true)
})

test('oversized manifest cancels the response and releases its reader without staging', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1))
    },
    cancel() {
      cancelled = true
    }
  })
  const service = new CoreUpdaterService(
    { feedUrl: 'https://updates.example/manifest.json' },
    {},
    async () => new Response(body)
  )
  const states = []
  const result = await service.check((state) => states.push(state))
  assert.equal(result.error, 'Core manifest exceeds limit')
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
  assert.equal(states.at(-1).phase, 'error')
  assert.equal(service.ready, false)
})

test('startup failure shares recovery admission with timeout and late ACK', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  let rescued = 0
  let rejected = false
  const service = new CoreUpdaterService(
    {},
    {
      async fail() {
        await pending
        rejected = true
      },
      async acknowledge() {
        throw new Error('late ACK admitted')
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  service.setHealthRescue(() => {
    rescued++
  })
  const first = service.recoverInitialFailure()
  assert.equal(await service.recoverInitialFailure(), true)
  await service.failInitialHealth()
  await service.acknowledgeHealthy()
  release()
  assert.equal(await first, true)
  assert.equal(rejected, true)
  assert.equal(rescued, 1)
})

test('builtin and confirmed healthy startup failures retain the ordinary failure path', async () => {
  const service = new CoreUpdaterService({}, { async acknowledge() {} })
  service.selection = { builtin: true }
  assert.equal(await service.recoverInitialFailure(), false)
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await service.markMainReady()
  await service.acknowledgeHealthy()
  assert.equal(await service.recoverInitialFailure(), false)
})

test('loaded external startup exceptions persist rollback before rescue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-startup-recovery-'))
  const installed = {
    product: 'lody',
    channel: 'test',
    platform: process.platform,
    arch: process.arch,
    hostAbi: 'test'
  }
  const options = { root, installed, lease: { assertHeld() {} } }
  try {
    const initial = await openActivation(options)
    const pointer = join(initial.directory, 'pointer.json')
    for (const asynchronous of [false, true]) {
      await writeFile(
        pointer,
        JSON.stringify({
          current: 'candidate',
          previous: 'good',
          staged: null,
          attempt: { releaseId: 'candidate', attemptId: '00000000-0000-0000-0000-000000000001' },
          rejected: [],
          seq: 1
        })
      )
      const entry = join(root, asynchronous ? 'async.mjs' : 'sync.mjs')
      await writeFile(
        entry,
        asynchronous
          ? 'export function startApplication() { return Promise.reject(new Error("appReady failed")) }'
          : 'export function startApplication() { throw new Error("startApplication failed") }'
      )
      const service = new CoreUpdaterService({}, await openActivation(options))
      service.entry = entry
      service.selection = {
        builtin: false,
        releaseId: 'candidate',
        attemptId: '00000000-0000-0000-0000-000000000001'
      }
      let recovered
      service.setHealthRescue(async () => {
        recovered = JSON.parse(await readFile(pointer, 'utf8'))
      })
      const application = await service.loadApplication(() => {
        throw new Error('unsafe builtin evaluation')
      })
      await assert.rejects(
        async () => application.startApplication(),
        asynchronous ? /appReady failed/ : /startApplication failed/
      )
      assert.equal(await service.recoverInitialFailure(), true)
      assert.equal(recovered.current, 'good')
      assert.equal(recovered.attempt, null)
      assert.deepEqual(recovered.rejected, ['candidate'])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup failure joins an admitted ACK and cannot replace graceful shutdown', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const service = new CoreUpdaterService(
    {},
    {
      async acknowledge() {
        await pending
      },
      async fail() {
        throw new Error('must not replace ACK')
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await service.markMainReady()
  const ack = service.acknowledgeHealthy()
  const failure = service.recoverInitialFailure()
  release()
  await ack
  assert.equal(await failure, false)
  const quitting = new CoreUpdaterService(
    {},
    {
      async abandon() {},
      async fail() {
        throw new Error('must not replace shutdown')
      }
    }
  )
  quitting.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  await quitting.abandonHealthAttempt()
  assert.equal(await quitting.recoverInitialFailure(), true)
})

test('early startup failure stops launch admission before activation I/O and joins both owners', async () => {
  const write = Promise.withResolvers()
  const launch = Promise.withResolvers()
  const cliClosed = Promise.withResolvers()
  const shellClosed = Promise.withResolvers()
  const events = []
  let admitted = true
  const launching = launch.promise.then(() => {
    if (admitted) events.push('launched')
  })
  const service = new CoreUpdaterService(
    {},
    {
      async fail() {
        events.push('write')
        await write.promise
      }
    }
  )
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  service.setInitialFailureCleanup(async () => {
    admitted = false
    events.push('stop-admission')
    await Promise.all([cliClosed.promise, shellClosed.promise])
    events.push('owners-released')
  })
  service.setHealthRescue(() => {
    events.push('relaunch-exit')
  })
  const recovery = service.recoverInitialFailure()
  assert.deepEqual(events, ['stop-admission', 'write'])
  launch.resolve()
  await launching
  write.resolve()
  cliClosed.resolve()
  await cliClosed.promise
  assert.equal(events.includes('relaunch-exit'), false)
  shellClosed.resolve()
  await recovery
  assert.deepEqual(events, ['stop-admission', 'write', 'owners-released', 'relaunch-exit'])
})

test('unconfirmed early startup owner never hands recovery to Host exit', async () => {
  const service = new CoreUpdaterService({}, { async fail() {} })
  service.selection = { builtin: false, releaseId: 'candidate', attemptId: 'attempt' }
  let exited = false
  service.setInitialFailureCleanup(async () => {
    throw new Error('CLI still owned')
  })
  service.setHealthRescue(() => {
    exited = true
  })
  assert.equal(await service.recoverInitialFailure(), true)
  assert.equal(exited, false)
})
