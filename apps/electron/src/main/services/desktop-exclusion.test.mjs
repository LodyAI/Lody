import { Cause, Deferred, Effect, Layer } from 'effect'
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { acquireDesktopLease } from './desktop-exclusion.ts'
import { createDesktopLaunchBuffer } from './desktop-launch-buffer.ts'
import { createDesktopQuitBarrier } from './desktop-shutdown.ts'

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
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
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
