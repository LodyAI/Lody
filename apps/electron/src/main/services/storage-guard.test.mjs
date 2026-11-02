import assert from 'node:assert/strict'
import test from 'node:test'
import { createStorageGuard, requiredFreeBytes } from './storage-guard.ts'

const GIB = 1024 ** 3

/** A guard over named volumes whose free space the test sets directly. */
function createHarness(volumes) {
  const broadcasts = []
  const relaunches = []
  let quits = 0
  let clock = 0
  const reads = []
  const guard = createStorageGuard({
    dataDirs: Object.keys(volumes),
    readVolume: async (dir) => {
      reads.push(dir)
      const volume = volumes[dir]
      if (volume instanceof Error) throw volume
      return volume
    },
    broadcast: (state) => broadcasts.push(state),
    quitAndRelaunch: async () => {
      relaunches.push(clock)
      return 'quitting'
    },
    quit: () => {
      quits += 1
    },
    log: () => {},
    now: () => clock
  })
  return {
    guard,
    broadcasts,
    relaunches,
    reads,
    quits: () => quits,
    advance: (ms) => {
      clock += ms
    }
  }
}

void test('requires 2% of the volume free, kept within 5-20 GiB', () => {
  assert.equal(requiredFreeBytes(100 * GIB), 5 * GIB)
  assert.equal(requiredFreeBytes(500 * GIB), 10 * GIB)
  assert.equal(requiredFreeBytes(4096 * GIB), 20 * GIB)
})

void test('blocks after a write failure on a volume short of space', async () => {
  // The reported incident: 99% full, 3.6 GiB free.
  const h = createHarness({ '/profile': { freeBytes: 3.6 * GIB, totalBytes: 360 * GIB } })
  await h.guard.reportWriteFailure('renderer')
  assert.deepEqual(h.guard.getState(), {
    blocked: true,
    source: 'renderer',
    volume: {
      freeBytes: 3.6 * GIB,
      totalBytes: 360 * GIB,
      resumeFreeBytes: requiredFreeBytes(360 * GIB) + GIB
    }
  })
  assert.equal(h.broadcasts.length, 1)
})

void test('a write failure with enough free space does not block', async () => {
  const h = createHarness({ '/profile': { freeBytes: 200 * GIB, totalBytes: 500 * GIB } })
  await h.guard.reportWriteFailure('renderer')
  assert.deepEqual(h.guard.getState(), { blocked: false })
  assert.equal(h.broadcasts.length, 0)
})

void test('judges by the most constrained volume holding Lody data', async () => {
  const h = createHarness({
    '/profile': { freeBytes: 300 * GIB, totalBytes: 500 * GIB },
    '/cli-data': { freeBytes: 1 * GIB, totalBytes: 250 * GIB }
  })
  await h.guard.reportWriteFailure('cli')
  assert.equal(h.guard.getState().blocked, true)
  assert.equal(h.guard.getState().source, 'cli')
  assert.equal(h.guard.getState().volume?.freeBytes, 1 * GIB)
})

void test('an unreadable volume is skipped, and no reading at all never blocks', async () => {
  const partial = createHarness({
    '/gone': new Error('ENOENT'),
    '/profile': { freeBytes: 1 * GIB, totalBytes: 250 * GIB }
  })
  await partial.guard.reportWriteFailure('renderer')
  assert.equal(partial.guard.getState().blocked, true)

  const none = createHarness({ '/gone': new Error('ENOENT') })
  await none.guard.reportWriteFailure('renderer')
  assert.deepEqual(none.guard.getState(), { blocked: false })
})

void test('one disk check answers a burst of write failures', async () => {
  const h = createHarness({ '/profile': { freeBytes: 200 * GIB, totalBytes: 500 * GIB } })
  await Promise.all([
    h.guard.reportWriteFailure('renderer'),
    h.guard.reportWriteFailure('renderer'),
    h.guard.reportWriteFailure('cli')
  ])
  await h.guard.reportWriteFailure('renderer')
  assert.equal(h.reads.length, 1)
  h.advance(10_000)
  await h.guard.reportWriteFailure('renderer')
  assert.equal(h.reads.length, 2)
})

void test('relaunch refuses while the volume is still short, then relaunches once freed', async () => {
  const profile = { freeBytes: 3.6 * GIB, totalBytes: 360 * GIB }
  const h = createHarness({ '/profile': profile })
  await h.guard.reportWriteFailure('renderer')

  // Just over the requirement is not enough: resuming needs 1 GiB of slack.
  profile.freeBytes = 7.5 * GIB
  assert.equal(await h.guard.relaunchIfSpaceFreed(), 'still_low')
  assert.equal(h.relaunches.length, 0)
  assert.equal(h.guard.getState().blocked, true)
  assert.equal(h.guard.getState().volume?.freeBytes, 7.5 * GIB)

  profile.freeBytes = 30 * GIB
  assert.equal(await h.guard.relaunchIfSpaceFreed(), 'quitting')
  assert.equal(h.relaunches.length, 1)
})

void test('stays blocked once blocked, even if a later failure finds room', async () => {
  const profile = { freeBytes: 1 * GIB, totalBytes: 250 * GIB }
  const h = createHarness({ '/profile': profile })
  await h.guard.reportWriteFailure('renderer')
  profile.freeBytes = 100 * GIB
  h.advance(60_000)
  await h.guard.reportWriteFailure('renderer')
  assert.equal(h.guard.getState().blocked, true)
  assert.equal(h.broadcasts.length, 1)
})

void test('does not treat an unreadable disk as recovery', async () => {
  const volumes = {
    '/cli-data': { freeBytes: 100 * GIB, totalBytes: 250 * GIB },
    '/profile': { freeBytes: 1 * GIB, totalBytes: 250 * GIB }
  }
  const h = createHarness(volumes)
  await h.guard.reportWriteFailure('renderer')
  volumes['/profile'] = new Error('EIO')
  assert.equal(await h.guard.relaunchIfSpaceFreed(), 'check_failed')
  assert.equal(h.relaunches.length, 0)
  assert.equal(h.guard.getState().blocked, true)
  h.guard.quit()
  assert.equal(h.quits(), 1)
})

void test('quit is delegated', () => {
  const h = createHarness({ '/profile': { freeBytes: 1 * GIB, totalBytes: 250 * GIB } })
  h.guard.quit()
  assert.equal(h.quits(), 1)
})
