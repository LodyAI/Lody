import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireDesktopLease, handOffDesktopDeepLink } from './desktop-exclusion.ts'

import { createDesktopLaunchAdmission } from './desktop-launch-admission.ts'

import {
  createDesktopQuitBarrier,
  finishUnconfirmedDesktopQuit,
  recordUnconfirmedDesktopQuit,
  reportPreviousUnconfirmedDesktopQuit,
  waitForQuitRecovery
} from './desktop-shutdown.ts'

const loopback = { host: '127.0.0.1', port: 0 }

void test('unconfirmed quit terminates unattended even when warning marker I/O never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = Promise.withResolvers()
  let exitCode
  const quitting = finishUnconfirmedDesktopQuit({
    record: () => {
      entered.resolve()
      return new Promise(() => {})
    },
    exit: (code) => {
      exitCode = code
    }
  })
  await entered.promise
  t.mock.timers.tick(999)
  assert.equal(exitCode, undefined)
  t.mock.timers.tick(1)
  await quitting
  assert.equal(exitCode, 1)
})

void test('unconfirmed quit exits after marker failure without needing a warning acknowledgement', async () => {
  let exitCode
  await finishUnconfirmedDesktopQuit({
    record: async () => {
      throw new Error('synthetic disk failure')
    },
    exit: (code) => {
      exitCode = code
    }
  })
  assert.equal(exitCode, 1)
})

void test('quit warning survives notification failure and delivery cannot erase a subsequent quit marker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-quit-warning-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const marker = join(directory, 'quit-unconfirmed')
  const previous = `${marker}.previous`
  let exited = false
  await finishUnconfirmedDesktopQuit({
    record: () => recordUnconfirmedDesktopQuit(directory),
    exit: () => {
      exited = true
    }
  })
  assert.equal(exited, true)
  assert.equal(await readFile(marker, 'utf8'), '')
  await reportPreviousUnconfirmedDesktopQuit(directory, async () => ({ shown: false }))
  assert.equal(await readFile(previous, 'utf8'), '')
  const entered = Promise.withResolvers(),
    delivered = Promise.withResolvers()
  const notification = reportPreviousUnconfirmedDesktopQuit(directory, () => {
    entered.resolve()
    return delivered.promise
  })
  await entered.promise
  // A pending startup notification never owns shutdown, nor its newly written marker.
  await finishUnconfirmedDesktopQuit({
    record: () => recordUnconfirmedDesktopQuit(directory),
    exit: () => {}
  })
  delivered.resolve({ shown: true })
  await notification
  await assert.rejects(readFile(previous), { code: 'ENOENT' })
  assert.equal(await readFile(marker, 'utf8'), '')
  await reportPreviousUnconfirmedDesktopQuit(directory, async () => ({ shown: true }))
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await assert.rejects(readFile(previous), { code: 'ENOENT' })
  await reportPreviousUnconfirmedDesktopQuit(directory, async () => {
    throw new Error('an ordinary launch without a marker must not notify')
  })
})

void test('desktop ownership excludes a second owner and can be handed off after close', async (t) => {
  const stable = await acquireDesktopLease(loopback)
  assert.ok(stable)
  t.after(() => stable.close())
  const endpoint = { ...loopback, port: stable.port }
  assert.equal(await acquireDesktopLease(endpoint), null)
  await stable.close()
  const nightly = await acquireDesktopLease(endpoint)
  assert.ok(nightly)
  t.after(() => nightly.close())
  assert.equal(await acquireDesktopLease(endpoint), null)
})

void test('crashing an owner releases the OS lease without deleting a lock file', async (t) => {
  const moduleUrl = new URL('./desktop-exclusion.ts', import.meta.url).href
  const resolveHookUrl = new URL('../../../scripts/node-test-ts-resolve.mjs', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      resolveHookUrl,
      '--input-type=module',
      '-e',
      `
    const { acquireDesktopLease } = await import(${JSON.stringify(moduleUrl)});
    const lease = await acquireDesktopLease({ host: '127.0.0.1', port: 0 });
    process.on('message', () => {});
    process.send({ port: lease.port });
  `
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  )
  t.after(() => child.kill('SIGKILL'))
  const [{ port }] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('Lease owner exited before ready')
    })
  ])
  const endpoint = { ...loopback, port }
  assert.equal(await acquireDesktopLease(endpoint), null)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const replacement = await acquireDesktopLease(endpoint)
  assert.ok(replacement)
  t.after(() => replacement.close())
})

void test('a lease never accepts cloud callbacks or unsupported routes', async (t) => {
  let received
  const owner = await acquireDesktopLease(loopback, {
    onDeepLink: (url) => {
      received = url
      return true
    }
  })
  assert.ok(owner)
  t.after(() => owner.close())
  const endpoint = { host: '127.0.0.1', port: owner.port }

  assert.equal(
    await handOffDesktopDeepLink(
      'ai.lody.nightly://auth/callback#token=synthetic-attempt',
      endpoint
    ),
    false
  )
  assert.equal(
    await handOffDesktopDeepLink('lody://invite/open?invitation=synthetic', endpoint),
    false
  )
  assert.equal(received, undefined)

  assert.equal(
    await handOffDesktopDeepLink('lody://chat/new?machine=machine-1&project=project-1', endpoint),
    true
  )
  assert.equal(received, 'lody://chat/new?machine=machine-1&project=project-1')
})

void test('concurrent pending handoffs are delivered in arrival order after ready', async () => {
  const delivered = []
  const admission = createDesktopLaunchAdmission((url) => delivered.push(url))
  const first = admission.accept('lody://session/first')
  const second = admission.accept('lody://session/second')

  admission.markReady()
  const third = admission.accept('lody://session/third')
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(await third, true)
  assert.deepEqual(delivered, [
    'lody://session/first',
    'lody://session/second',
    'lody://session/third'
  ])
})

void test('quit waits for execution exit, retains ownership on failure, and allows retry', async () => {
  const stopped = Promise.withResolvers()
  const failed = Promise.withResolvers()
  const quit = Promise.withResolvers()
  let stopping = stopped.promise
  let stopCalls = 0
  let finalQuitPrevented
  const handler = createDesktopQuitBarrier({
    stop: () => {
      stopCalls++
      return stopping
    },
    quit: () => {
      finalQuitPrevented = false
      void handler({
        preventDefault() {
          finalQuitPrevented = true
        }
      })
      quit.resolve()
    },
    reportFailure: (error) => failed.resolve(error)
  })
  let prevented = false
  void handler({
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  // Repeated quit must share the pending shutdown instead of running it twice.
  void handler({ preventDefault() {} })
  const error = new Error('CLI still alive')
  stopped.reject(error)
  assert.equal(await failed.promise, error)
  assert.equal(finalQuitPrevented, undefined)
  assert.equal(stopCalls, 1)
  stopping = Promise.resolve()
  void handler({ preventDefault() {} })
  await quit.promise
  assert.equal(finalQuitPrevented, false)
})

void test('quit cancellation preserves services and a later attempt closes renderers before stopping', async () => {
  const decision = Promise.withResolvers()
  const ready = Promise.withResolvers()
  const quit = Promise.withResolvers()
  const order = []
  let allow = false
  const handler = createDesktopQuitBarrier({
    prepare: async () => {
      order.push('prepare')
      ready.resolve()
      return allow ? true : decision.promise
    },
    stop: async () => {
      order.push('stop')
    },
    quit: () => {
      order.push('quit')
      quit.resolve()
    },
    reportFailure: (error) => {
      throw error
    }
  })
  const attempt = handler({ preventDefault() {} })
  await ready.promise
  assert.deepEqual(order, ['prepare'])
  decision.resolve(false)
  await attempt
  assert.deepEqual(order, ['prepare'])
  allow = true
  void handler({ preventDefault() {} })
  await quit.promise
  assert.deepEqual(order, ['prepare', 'prepare', 'stop', 'quit'])
})

void test('failed quit restores services before reporting and later quit still completes', async () => {
  const events = []
  let failed = true
  const handler = createDesktopQuitBarrier({
    stop: async () => {
      events.push('stop')
      if (failed) throw new Error('local failure')
    },
    recover: async () => {
      events.push('restore relay', 'restore shell')
      return true
    },
    reportFailure: (_error, recovered) => {
      assert.equal(recovered, true)
      events.push('reopen')
    },
    quit: () => events.push('quit')
  })
  await handler({ preventDefault() {} })
  assert.deepEqual(events, ['stop', 'restore relay', 'restore shell', 'reopen'])
  failed = false
  await handler({ preventDefault() {} })
  assert.equal(events.at(-1), 'quit')
})

void test('unreleased owner keeps quit retryable without reopening ordinary windows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = Promise.withResolvers()
  const recovering = Promise.withResolvers()
  let failed = true
  const surfaces = []
  const handler = createDesktopQuitBarrier({
    stop: async () => {
      if (failed) throw new Error('owner still alive')
    },
    recover: async () => {
      recovering.resolve()
      return (await waitForQuitRecovery(pending.promise)) !== null
    },
    reportFailure: (_error, recovered) => surfaces.push(recovered ? 'ordinary' : 'restart dialog'),
    quit: () => surfaces.push('quit')
  })
  const attempt = handler({ preventDefault() {} })
  await recovering.promise
  t.mock.timers.tick(30_000)
  await attempt
  pending.resolve(true)
  await pending.promise
  assert.deepEqual(surfaces, ['restart dialog'])
  failed = false
  await handler({ preventDefault() {} })
  assert.deepEqual(surfaces, ['restart dialog', 'quit'])
})
