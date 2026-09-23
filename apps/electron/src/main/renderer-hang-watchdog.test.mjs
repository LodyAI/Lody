import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRendererHangWatchdog } from './renderer-hang-watchdog.ts'
import { createRendererHangLog, withDiagnosticTimeout } from './renderer-hang-log.ts'

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

void test('stack collection times out even when the renderer never responds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const outcome = assert.rejects(withDiagnosticTimeout(pending, 5000), /Timed out after 5000ms/)
  t.mock.timers.tick(5000)
  await outcome
  finish('late stack')
  await Promise.resolve()
})

void test('stack collection propagates results and errors before the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(
    await withDiagnosticTimeout(Promise.resolve('busyLoop at app.js:10'), 5000),
    'busyLoop at app.js:10'
  )
  await assert.rejects(
    withDiagnosticTimeout(Promise.reject(new Error('frame gone')), 5000),
    /frame gone/
  )
  t.mock.timers.tick(5000)
})

void test('concurrent incident, stack and recovery writes remain intact across bounded rotation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-hang-log-'))
  try {
    const file = path.join(directory, 'renderer-hang.jsonl')
    const write = createRendererHangLog(file, 100)
    const entries = [
      { event: 'unresponsive', id: 1 },
      { event: 'stack', id: 1, stack: '阻塞函数 app.js:10' },
      { event: 'responsive', id: 1 }
    ]
    await Promise.all(entries.map(write))
    const actual = ((await readFile(`${file}.1`, 'utf8')) + (await readFile(file, 'utf8')))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.deepEqual(actual, entries)
    for (let i = 0; i < 20; i++) await write({ event: 'later', id: i })
    assert.deepEqual((await readdir(directory)).sort(), [
      'renderer-hang.jsonl',
      'renderer-hang.jsonl.1'
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
