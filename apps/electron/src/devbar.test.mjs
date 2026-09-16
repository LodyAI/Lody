import assert from 'node:assert/strict'
import test from 'node:test'
import { isDevbarEnabled, summarizeDevbarMetrics } from './main/services/devbar-metrics.ts'
import { createDevbarViewState } from './main/services/devbar-json-render.ts'
import { DevbarRecording } from './main/services/devbar-recording.ts'
import { createClsTracker } from './renderer/src/devbar-cls.ts'
import { createLongTaskBuffer } from './renderer/src/devbar-long-tasks.ts'
import { isDevbarDeepLink } from './renderer/src/devbar-deep-link.ts'

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

void test('long-task buffer preserves bounded recent history and drains interval samples', () => {
  const tasks = createLongTaskBuffer(2)
  const entry = (startTime, duration, containerName = '') => ({
    startTime,
    duration,
    name: 'self',
    attribution: [{ containerName }]
  })
  tasks.record(entry(10, 55), 1_000)
  tasks.record(entry(20, 75, 'preview'), 1_000)
  tasks.record(entry(30, 95), 1_000)

  assert.deepEqual(
    tasks.recent().map(({ observedAtMs, durationMs }) => ({ observedAtMs, durationMs })),
    [
      { observedAtMs: 1_020, durationMs: 75 },
      { observedAtMs: 1_030, durationMs: 95 }
    ]
  )
  assert.equal(tasks.recent()[0].attribution.containerName, 'preview')
  assert.equal(tasks.drain().length, 2)
  assert.deepEqual(tasks.drain(), [])
})

void test('devbar recording bounds sample history while retaining aggregate long-task totals', () => {
  const recording = new DevbarRecording()
  for (let index = 0; index < 125; index++) {
    recording.record({
      recordedAtMs: index,
      route: '/sessions/test',
      fps: 60,
      cls: 0,
      heapBytes: 1,
      cpu: 2,
      rssBytes: 3,
      gpuCpu: 4,
      gpuRssBytes: 5,
      longTasks:
        index % 25 === 0
          ? [
              {
                observedAtMs: index,
                startTimeMs: index,
                durationMs: 60 + index,
                name: 'self',
                attribution: null
              }
            ]
          : []
    })
  }

  const snapshot = recording.snapshot()
  assert.equal(snapshot.samples.length, 120)
  assert.equal(snapshot.samples[0].recordedAtMs, 5)
  assert.equal(snapshot.latest.recordedAtMs, 124)
  assert.equal(snapshot.summary.longTaskCount, 5)
  assert.equal(snapshot.summary.maxLongTaskDurationMs, 160)
})

void test('devbar JSON-render state presents live metrics and bounded task rows', () => {
  const latest = {
    recordedAtMs: 2_000,
    route: '/sessions/example',
    fps: 48,
    cls: 0.0123,
    heapBytes: 20 * 1024 * 1024,
    cpu: 12.5,
    rssBytes: 300 * 1024 * 1024,
    gpuCpu: 4,
    gpuRssBytes: 50 * 1024 * 1024,
    longTasks: [
      {
        observedAtMs: 2_000,
        startTimeMs: 10,
        durationMs: 72.25,
        name: 'self',
        attribution: null
      }
    ]
  }
  const state = createDevbarViewState({
    updatedAtMs: 2_000,
    latest,
    samples: [
      {
        ...latest,
        recordedAtMs: 1_000,
        fps: 60,
        cpu: 8,
        heapBytes: 18 * 1024 * 1024,
        rssBytes: 280 * 1024 * 1024,
        longTasks: []
      },
      latest
    ],
    longTasks: [
      {
        observedAtMs: Date.UTC(2026, 0, 1, 12, 34, 56),
        startTimeMs: 10,
        durationMs: 72.25,
        name: 'self',
        attribution: null
      }
    ],
    summary: {
      sampleCount: 12,
      longTaskCount: 1,
      totalLongTaskDurationMs: 72.25,
      maxLongTaskDurationMs: 72.25
    }
  })

  assert.equal(state.statusText, 'Needs attention')
  assert.deepEqual(state.headline, {
    fps: '48',
    cpu: '12.5%',
    heap: '20 MiB',
    blocked: '72 ms'
  })
  assert.equal(state.metrics['Electron CPU'], '12.5%')
  assert.equal(state.metrics['JavaScript heap'], '20 MiB')
  assert.deepEqual(state.trends[0], {
    signal: 'FPS',
    trend: '█▁',
    current: '48',
    range: '48 – 60'
  })
  assert.deepEqual(state.trends[4], {
    signal: 'Blocked / sample',
    trend: '▁█',
    current: '72 ms',
    range: '0 ms – 72 ms'
  })
  assert.deepEqual(state.longTasks, [
    { observed: '12:34:56', duration: '72.3 ms', attribution: 'self' }
  ])
})

void test('devbar deep links select only the main-thread diagnostics view', () => {
  assert.equal(isDevbarDeepLink('lody://devbar?view=main-thread'), true)
  assert.equal(isDevbarDeepLink('lody://devbar?view=other'), false)
  assert.equal(isDevbarDeepLink('not a URL'), false)
})
