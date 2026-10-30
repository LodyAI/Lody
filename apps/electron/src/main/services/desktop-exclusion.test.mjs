import { Cause, Deferred, Effect, Layer } from 'effect'
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { acquireDesktopLease, handOffDesktopDeepLink } from './desktop-exclusion.ts'
import { toPortableDesktopDeepLink } from './desktop-deep-link-handoff.ts'
import { createDesktopLaunchAdmission } from './desktop-launch-admission.ts'
import { createDesktopLaunchBuffer } from './desktop-launch-buffer.ts'
import { createDesktopQuitBarrier, waitForQuitRecovery } from './desktop-shutdown.ts'

const loopback = { host: '127.0.0.1', port: 0 }

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

void test('lease setup errors fail rather than admitting an unprotected desktop', async () => {
  await assert.rejects(acquireDesktopLease({ host: '127.0.0.1', port: -1 }))
})

void test('a losing channel hands a portable link to the desktop that owns the lease', async (t) => {
  const received = Promise.withResolvers()
  const owner = await acquireDesktopLease(loopback, {
    onDeepLink: (url) => {
      received.resolve(url)
      return true
    }
  })
  assert.ok(owner)
  t.after(() => owner.close())

  const accepted = await handOffDesktopDeepLink(
    'ai.lody.nightly://session/session-1?workspace=workspace-1',
    { host: '127.0.0.1', port: owner.port }
  )
  assert.equal(accepted, true)
  assert.equal(await received.promise, 'lody://session/session-1?workspace=workspace-1')
})

void test('handoff waits for asynchronous startup admission before reporting success', async (t) => {
  const started = Promise.withResolvers()
  const decision = Promise.withResolvers()
  let received
  const owner = await acquireDesktopLease(loopback, {
    onDeepLink: async (url) => {
      received = url
      started.resolve()
      return await decision.promise
    }
  })
  assert.ok(owner)
  t.after(() => owner.close())
  const endpoint = { host: '127.0.0.1', port: owner.port }

  const accepted = handOffDesktopDeepLink('lody://session/slow-startup', endpoint)
  await started.promise
  assert.equal(received, 'lody://session/slow-startup')
  decision.resolve(true)
  assert.equal(await accepted, true)
})

void test('a rejected startup makes its pending handoff fail explicitly', async (t) => {
  const started = Promise.withResolvers()
  const decision = Promise.withResolvers()
  const owner = await acquireDesktopLease(loopback, {
    onDeepLink: async (url) => {
      assert.equal(url, 'lody://session/rejected-startup')
      started.resolve()
      return await decision.promise
    }
  })
  assert.ok(owner)
  t.after(() => owner.close())
  const endpoint = { host: '127.0.0.1', port: owner.port }

  const accepted = handOffDesktopDeepLink('lody://session/rejected-startup', endpoint)
  await started.promise
  decision.resolve(false)
  assert.equal(await accepted, false)
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

void test('slow startup holds handoffs until the launch handler is ready', async () => {
  const delivered = []
  const admission = createDesktopLaunchAdmission((url) => delivered.push(url))
  const accepted = admission.accept('lody://session/slow-startup')
  let settled = false
  void accepted.then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(delivered, [])

  admission.markReady()
  assert.equal(await accepted, true)
  assert.deepEqual(delivered, ['lody://session/slow-startup'])
})

void test('rejected startup refuses pending and later handoffs without delivery', async () => {
  const delivered = []
  const admission = createDesktopLaunchAdmission((url) => delivered.push(url))
  const pending = admission.accept('lody://session/pending')
  admission.markRejected()

  assert.equal(await pending, false)
  assert.equal(await admission.accept('lody://session/later'), false)
  assert.deepEqual(delivered, [])
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

void test('the first admission decision is final and later handoffs use it', async () => {
  const readyDelivered = []
  const ready = createDesktopLaunchAdmission((url) => readyDelivered.push(url))
  ready.markReady()
  ready.markRejected()
  assert.equal(await ready.accept('lody://session/ready-later'), true)
  assert.deepEqual(readyDelivered, ['lody://session/ready-later'])

  const rejectedDelivered = []
  const rejected = createDesktopLaunchAdmission((url) => rejectedDelivered.push(url))
  rejected.markRejected()
  rejected.markReady()
  assert.equal(await rejected.accept('lody://session/rejected-later'), false)
  assert.deepEqual(rejectedDelivered, [])
})

void test('a delivery failure preserves the original error and does not block later handoffs', async () => {
  const failure = new Error('synthetic delivery failure')
  const delivered = []
  const admission = createDesktopLaunchAdmission((url) => {
    delivered.push(url)
    if (url === 'lody://session/bad') throw failure
  })
  admission.markReady()

  await assert.rejects(admission.accept('lody://session/bad'), (error) => error === failure)
  assert.equal(await admission.accept('lody://session/good'), true)
  assert.deepEqual(delivered, ['lody://session/bad', 'lody://session/good'])
})

void test('portable destinations use the common resource scheme', () => {
  assert.equal(
    toPortableDesktopDeepLink('ai.lody.nightly://session/session-1?workspace=workspace-1'),
    'lody://session/session-1?workspace=workspace-1'
  )
  assert.equal(
    toPortableDesktopDeepLink('ai.lody.stable://provider/import?v=1&data=synthetic'),
    'lody://provider/import?v=1&data=synthetic'
  )
  assert.equal(toPortableDesktopDeepLink('session://legacy'), null)
  assert.equal(toPortableDesktopDeepLink('lody://session/session-1#fragment'), null)
  assert.equal(toPortableDesktopDeepLink('lody://auth/callback#token=synthetic'), null)
  assert.equal(toPortableDesktopDeepLink('https://lody.ai/session/session-1'), null)
})

void test('startup event buffer can hand its pending events to another installation', () => {
  const buffer = createDesktopLaunchBuffer()
  buffer.push({ url: 'lody://session/pending' })
  buffer.push({ activate: true })
  assert.deepEqual(buffer.takePending(), [{ url: 'lody://session/pending' }, { activate: true }])
  const received = []
  buffer.bind((event) => received.push(event))
  buffer.push({ url: 'lody://session/after-ready' })
  assert.deepEqual(received, [{ url: 'lody://session/after-ready' }])
})

void test('startup retains login and activation events until the application is loaded', () => {
  const buffer = createDesktopLaunchBuffer()
  const received = []
  buffer.push({ url: 'ai.lody.nightly://auth/callback#pending-attempt' })
  buffer.push({ activate: true })
  assert.deepEqual(received, [])
  buffer.bind((event) => received.push(event))
  buffer.push({ url: 'ai.lody.nightly://workspace/after-ready' })
  assert.deepEqual(received, [
    { url: 'ai.lody.nightly://auth/callback#pending-attempt' },
    { activate: true },
    { url: 'ai.lody.nightly://workspace/after-ready' }
  ])
  assert.throws(() => buffer.bind(() => {}), /already bound/)
})

void test('startup event buffer bounds memory and retains the most recent login', () => {
  const buffer = createDesktopLaunchBuffer()
  for (let i = 0; i < 40; i++) buffer.push({ url: `lody://workspace/${i}` })
  buffer.push({ url: 'lody://auth/callback#new-attempt' })
  const received = []
  buffer.bind((event) => received.push(event))
  assert.equal(received.length, 32)
  assert.deepEqual(received[0], { url: 'lody://workspace/9' })
  assert.deepEqual(received.at(-1), { url: 'lody://auth/callback#new-attempt' })
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

void test('quit awaits application Scope cleanup and retries transferred ownership after failed disposal', async () => {
  const cleaning = Deferred.makeUnsafe()
  const gate = Deferred.makeUnsafe()
  const resource = { held: false, denied: true }
  const leaseFailure = { resource }
  const owner = makeApplicationRuntime(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          resource.held = true
        }),
        () =>
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.die(leaseFailure))
          )
      )
    ),
    {
      recover: (cause) =>
        Effect.gen(function* () {
          assert.ok(
            cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === leaseFailure
            )
          )
          if (resource.denied) return yield* Effect.fail(new Error('resource still alive'))
          resource.held = false
          return undefined
        }),
      project: Cause.squash
    }
  )
  await owner.runtime.runPromise(Effect.void)
  const failure = Promise.withResolvers()
  const quit = Promise.withResolvers()
  const barrier = createDesktopQuitBarrier({
    stop: () => owner.closeLegacy(),
    quit: () => quit.resolve(),
    reportFailure: (error) => failure.resolve(error)
  })
  let quitCalled = false
  void quit.promise.then(() => {
    quitCalled = true
  })
  const first = barrier({ preventDefault() {} })
  await Effect.runPromise(Deferred.await(cleaning))
  await barrier({ preventDefault() {} })
  assert.equal(resource.held, true)
  assert.equal(quitCalled, false)
  Deferred.doneUnsafe(gate, Effect.void)
  await first
  assert.equal(await failure.promise, leaseFailure)
  assert.equal(quitCalled, false)
  await barrier({ preventDefault() {} })
  assert.equal(resource.held, true)
  assert.equal(quitCalled, false)
  resource.denied = false
  await barrier({ preventDefault() {} })
  await quit.promise
  assert.equal(resource.held, false)
})

void test('quit reports cancellation for Stay and for failed cleanup, but not for a quit', async () => {
  let cancelled = 0
  let allow = false
  let failStop = false
  const quit = Promise.withResolvers()
  const handler = createDesktopQuitBarrier({
    prepare: async () => allow,
    stop: async () => {
      if (failStop) throw new Error('CLI still alive')
    },
    quit: () => quit.resolve(),
    reportFailure: () => {},
    cancelled: () => {
      cancelled++
    }
  })
  await handler({ preventDefault() {} })
  assert.equal(cancelled, 1)
  allow = true
  failStop = true
  await handler({ preventDefault() {} })
  assert.equal(cancelled, 2)
  failStop = false
  await handler({ preventDefault() {} })
  await quit.promise
  assert.equal(cancelled, 2)
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
