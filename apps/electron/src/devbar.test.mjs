import assert from 'node:assert/strict'
import test from 'node:test'
import { isDevbarEnabled, summarizeDevbarMetrics } from './main/services/devbar-metrics.ts'
import { createClsTracker } from './renderer/src/devbar-cls.ts'

void test('devbar is enabled only by the explicit runtime boolean', () => {
  assert.equal(isDevbarEnabled('true'), true)
  for (const value of [undefined, '', 'false', '0', '1', 'dev', 'staging', 'prod']) {
    assert.equal(isDevbarEnabled(value), false)
  }
})

void test('process metrics sum Electron working sets and report GPU process separately', () => {
  const rows = [
    { type: 'Browser', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 1024 } },
    { type: 'Tab', cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 2048 } },
    { type: 'GPU', cpu: { percentCPUUsage: 4 }, memory: { workingSetSize: 512 } }
  ]
  assert.deepEqual(summarizeDevbarMetrics(rows, true), {
    cpu: 9,
    rss: 3584 * 1024,
    gpuCpu: 4,
    gpuRss: 512 * 1024
  })
  assert.equal(summarizeDevbarMetrics(rows, false).cpu, null)
  assert.equal(summarizeDevbarMetrics(rows.slice(0, 2), true).gpuCpu, null)
  assert.equal(
    summarizeDevbarMetrics([{ type: 'Tab', cpu: { percentCPUUsage: 0 } }], true).rss,
    null
  )
  assert.deepEqual(summarizeDevbarMetrics([], true), {
    cpu: null,
    rss: null,
    gpuCpu: null,
    gpuRss: null
  })
})

void test('CLS excludes recent input and retains the largest session across a one-second gap', () => {
  const track = createClsTracker()
  const shift = (startTime, value, hadRecentInput = false) =>
    track({ startTime, value, hadRecentInput })
  assert.equal(shift(100, 0.1), 0.1)
  assert.equal(shift(500, 0.2, true), 0.1)
  assert.equal(shift(900, 0.1), 0.2)
  assert.equal(shift(1900, 0.1), 0.2)
  assert.equal(shift(2000, 0.3), 0.4)
})

void test('CLS caps a continuous session at five seconds from its first shift', () => {
  const track = createClsTracker()
  for (const startTime of [500, 1400, 2300, 3200, 4100, 5000]) {
    track({ startTime, value: 1, hadRecentInput: false })
  }
  // 5 s after the first entry starts a new window even without a 1 s gap.
  assert.equal(track({ startTime: 5500, value: 2, hadRecentInput: false }), 6)
})
