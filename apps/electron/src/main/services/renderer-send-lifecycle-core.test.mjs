import assert from 'node:assert/strict'
import test from 'node:test'
import { runRendererSendExit } from './renderer-send-lifecycle-core.ts'

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

void test('Stay preserves every live renderer and its dependencies', async () => {
  const windows = [{ live: true }, { live: true }]
  const allowed = await runRendererSendExit(windows, {
    check: async () => ({ ready: true, pending: true }),
    unavailable: async () => {},
    confirm: async () => false,
    drain: async (window) => {
      window.live = false
      return { ready: true, pending: false }
    }
  })
  assert.equal(allowed, false)
  assert.deepEqual(windows, [{ live: true }, { live: true }])
})

void test('one unresponsive renderer cannot authorize stopping the CLI', async () => {
  let cliStopped = false
  const allowed = await runRendererSendExit([1, 2], {
    check: async (window) => ({ ready: window === 1, pending: false }),
    unavailable: async () => {},
    confirm: async () => true,
    drain: async () => ({ ready: true, pending: false })
  })
  if (allowed) cliStopped = true
  assert.equal(cliStopped, false)
})

void test('all renderer cleanup must settle before stopping dependencies', async () => {
  const started = [gate(), gate()]
  const finish = [gate(), gate()]
  const live = [true, true]
  let cliStopped = false
  const exit = runRendererSendExit([0, 1], {
    check: async () => ({ ready: true, pending: true }),
    unavailable: async () => {},
    confirm: async () => true,
    drain: async (index) => {
      started[index].resolve()
      await finish[index].promise
      live[index] = false
      return { ready: true, pending: false }
    }
  }).then((allowed) => {
    if (allowed) cliStopped = true
  })
  await Promise.all(started.map((item) => item.promise))
  finish[0].resolve()
  assert.equal(cliStopped, false)
  assert.equal(live[1], true)
  finish[1].resolve()
  await exit
  assert.deepEqual(live, [false, false])
  assert.equal(cliStopped, true)
})
