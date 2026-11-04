import assert from 'node:assert/strict'
import test from 'node:test'

import { createRendererHangWatchdog } from './renderer-hang-watchdog.ts'

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const records = []
  const dialogs = []
  const actions = []
  const watchdog = createRendererHangWatchdog({
    now: Date.now,
    schedule(callback, delay) {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    record: (event, incident, details) => records.push({ event, incident, ...details }),
    showDialog: () => new Promise((resolve) => dialogs.push(resolve)),
    reload: () => actions.push('reload'),
    quit: () => actions.push('quit')
  })
  return { watchdog, records, dialogs, actions }
}

void test('recovery while the dialog is open followed by Wait never opens another dialog', async (t) => {
  const { watchdog, records, dialogs } = fixture(t)
  watchdog.unresponsive()
  t.mock.timers.tick(10_000)
  watchdog.responsive()
  dialogs[0](0)
  await Promise.resolve()
  t.mock.timers.tick(60_000)
  assert.equal(dialogs.length, 1)
  assert.deepEqual(
    records.map((r) => r.event),
    ['unresponsive', 'dialog-opened', 'responsive', 'dialog-result']
  )
  assert.equal(records.at(-1).stillUnresponsive, false)
})

void test('a real continuing stall repeats after Wait, but recovery cancels that retry', async (t) => {
  const { watchdog, dialogs } = fixture(t)
  watchdog.unresponsive()
  watchdog.unresponsive()
  t.mock.timers.tick(10_000)
  dialogs[0](0)
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  assert.equal(dialogs.length, 2)
  dialogs[1](0)
  await Promise.resolve()
  watchdog.responsive()
  t.mock.timers.tick(10_000)
  assert.equal(dialogs.length, 2)
})

void test('a new stall during an old dialog stays distinct and does not stack dialogs', async (t) => {
  const { watchdog, records, dialogs } = fixture(t)
  watchdog.unresponsive()
  t.mock.timers.tick(10_000)
  watchdog.responsive()
  watchdog.unresponsive()
  t.mock.timers.tick(20_000)
  assert.equal(dialogs.length, 1)
  dialogs[0](0)
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  assert.equal(dialogs.length, 2)
  const opened = records.filter((r) => r.event === 'dialog-opened')
  assert.notEqual(opened[0].incident.id, opened[1].incident.id)
})

for (const reset of ['responsive', 'navigation', 'dispose']) {
  void test(`${reset} cancels a pending dialog`, (t) => {
    const { watchdog, dialogs } = fixture(t)
    watchdog.unresponsive()
    watchdog[reset]()
    t.mock.timers.tick(10_000)
    assert.equal(dialogs.length, 0)
  })
}

for (const [response, action] of [
  [1, 'reload'],
  [2, 'quit']
]) {
  void test(`${action} is user initiated and invalidates the active stall`, async (t) => {
    const { watchdog, dialogs, actions } = fixture(t)
    watchdog.unresponsive()
    t.mock.timers.tick(10_000)
    assert.deepEqual(actions, [])
    dialogs[0](response)
    await Promise.resolve()
    t.mock.timers.tick(60_000)
    assert.deepEqual(actions, [action])
    assert.equal(dialogs.length, 1)
  })
}

void test('closing a window with an open dialog ignores its late result', async (t) => {
  const { watchdog, dialogs, actions } = fixture(t)
  watchdog.unresponsive()
  t.mock.timers.tick(10_000)
  watchdog.dispose()
  dialogs[0](1)
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  assert.deepEqual(actions, [])
  assert.equal(dialogs.length, 1)
})
