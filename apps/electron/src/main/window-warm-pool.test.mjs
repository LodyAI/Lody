import assert from 'node:assert/strict'
import test from 'node:test'
import { WindowWarmPool } from './window-warm-pool.ts'
import { isWindowWarmupEnabled, setWindowWarmupSetting } from './window-warm-settings.ts'

void test('warmup stays disabled until the developer setting is enabled', () => {
  setWindowWarmupSetting(false)
  assert.equal(isWindowWarmupEnabled(), false)

  const environmentAllowsWarmup =
    process.env['LODY_E2E'] !== '1' && process.env['LODY_DISABLE_WINDOW_WARMUP'] !== '1'
  setWindowWarmupSetting(true)
  assert.equal(isWindowWarmupEnabled(), environmentAllowsWarmup)
  setWindowWarmupSetting(false)
})

function createPool(dead = new Set()) {
  return new WindowWarmPool((entry) => !dead.has(entry.windowId))
}

void test('starts idle with no spare', () => {
  const pool = createPool()
  assert.equal(pool.phase, 'idle')
  assert.equal(pool.hasSpare(), false)
  assert.equal(pool.claimReady(), null)
})

void test('promotes a warming window only for its own renderer signal', () => {
  const pool = createPool()
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  assert.equal(pool.phase, 'warming')

  assert.equal(pool.markReady(99), false)
  assert.equal(pool.phase, 'warming')

  assert.equal(pool.markReady(11), true)
  assert.equal(pool.phase, 'ready')
  assert.deepEqual(pool.claimReady(), { windowId: 1, webContentsId: 11 })
  assert.equal(pool.phase, 'idle')
})

void test('claims a ready spare exactly once', () => {
  const pool = createPool()
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  pool.markReady(11)

  assert.deepEqual(pool.claimReady(), { windowId: 1, webContentsId: 11 })
  assert.equal(pool.claimReady(), null)
})

void test('keeps at most one spare', () => {
  const pool = createPool()
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  pool.beginWarming({ windowId: 2, webContentsId: 22 })
  assert.equal(pool.phase, 'warming')
  assert.equal(pool.markReady(11), true)
  assert.equal(pool.markReady(22), false)
  assert.deepEqual(pool.claimReady(), { windowId: 1, webContentsId: 11 })
})

void test('drops a dead spare instead of handing it out', () => {
  const dead = new Set([1])
  const pool = createPool(dead)
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  pool.markReady(11)

  assert.equal(pool.phase, 'idle')
  assert.equal(pool.claimReady(), null)
})

void test('rejects a ready signal from a window that already died', () => {
  const dead = new Set([1])
  const pool = createPool(dead)
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  assert.equal(pool.markReady(11), false)
  assert.equal(pool.phase, 'idle')
})

void test('forget removes a spare from either phase', () => {
  const pool = createPool()
  pool.beginWarming({ windowId: 1, webContentsId: 11 })
  pool.forget({ windowId: 1, webContentsId: 11 })
  assert.equal(pool.phase, 'idle')

  pool.beginWarming({ windowId: 2, webContentsId: 22 })
  pool.markReady(22)
  pool.forgetWebContents(22)
  assert.equal(pool.phase, 'idle')
})
