import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialDevbarControl,
  devbarRendererEntry,
  createDevbarAuth,
  isAllowedDevbarRequestOrigin,
  parseDevbarControlInput
} from './main/services/devbar/control.ts'
import { summarizeDevbarMetrics } from './main/services/devbar/metrics.ts'
import { createDevbarViewState } from './main/services/devbar/json-render.ts'
import {
  createDevbarRequestListener,
  handleDevbarLocalRoute
} from './main/services/devbar/local-routes.ts'
import { DevbarRecording } from './main/services/devbar/recording.ts'
import { createClsTracker } from './renderer/src/devbar/cls.ts'
import { createLongTaskBuffer } from './renderer/src/devbar/long-tasks.ts'
import { isDevbarDeepLink } from './renderer/src/devbar/deep-link.ts'
import { devbarSampleRoute } from './renderer/src/devbar/route.ts'

void test('environment activation remains an explicit automation override', () => {
  assert.deepEqual(initialDevbarControl('true'), {
    enabled: true,
    agentAccess: true,
    warmupEnabled: false
  })
  for (const value of [undefined, '', 'false', '0', '1', 'dev', 'staging', 'prod']) {
    assert.deepEqual(initialDevbarControl(value), {
      enabled: false,
      agentAccess: false,
      warmupEnabled: false
    })
  }
})

void test('runtime control validates the secondary agent capability gate', () => {
  assert.deepEqual(
    parseDevbarControlInput({ enabled: true, agentAccess: false, warmupEnabled: false }),
    {
      enabled: true,
      agentAccess: false,
      warmupEnabled: false
    }
  )
  assert.deepEqual(
    parseDevbarControlInput({ enabled: true, agentAccess: true, warmupEnabled: true }),
    {
      enabled: true,
      agentAccess: true,
      warmupEnabled: true
    }
  )
  assert.throws(() =>
    parseDevbarControlInput({ enabled: false, agentAccess: true, warmupEnabled: false })
  )
  assert.throws(() =>
    parseDevbarControlInput({ enabled: 'true', agentAccess: false, warmupEnabled: false })
  )
  assert.throws(() => parseDevbarControlInput({ enabled: true, agentAccess: false }))
})

void test('runtime activation selects the Devbar entry only for the primary product window', () => {
  assert.equal(devbarRendererEntry(false, false), 'index.html')
  assert.equal(devbarRendererEntry(true, false), 'devbar.html')
  assert.equal(devbarRendererEntry(true, true), 'index.html')
})

void test('loopback Hub accepts only its own and the packaged file renderer origins', () => {
  const hubOrigin = 'http://127.0.0.1:9765'
  assert.equal(isAllowedDevbarRequestOrigin(undefined, hubOrigin), true)
  assert.equal(isAllowedDevbarRequestOrigin('null', hubOrigin), true)
  assert.equal(isAllowedDevbarRequestOrigin('file://', hubOrigin), true)
  assert.equal(isAllowedDevbarRequestOrigin(hubOrigin, hubOrigin), true)
  assert.equal(
    isAllowedDevbarRequestOrigin('http://localhost:5173', hubOrigin, 'http://localhost:5173'),
    true
  )
  assert.equal(isAllowedDevbarRequestOrigin('https://example.test', hubOrigin), false)
  assert.equal(isAllowedDevbarRequestOrigin('http://localhost:3000', hubOrigin), false)
})

void test('devbar auth trusts loopback callers but requires the token for opaque origins', () => {
  const hub = 'http://127.0.0.1:9765'
  const auth = createDevbarAuth('launch-token', () => ({
    hub,
    renderer: 'http://localhost:5173'
  }))
  const connect = (url, origin) => {
    const session = { meta: {} }
    auth.onConnect(
      { request: { url, headers: { get: (name) => (name === 'origin' ? origin : null) } } },
      session
    )
    return session
  }

  // The packaged file:// renderer and the embedded dock carry the per-process token.
  const tokenSession = connect(`${hub}/ws?devframe_auth_token=launch-token`, 'null')
  assert.equal(tokenSession.meta.isTrusted, true)
  assert.equal(tokenSession.meta.clientAuthToken, 'launch-token')
  // Hub pages, the dev renderer, and non-browser local clients stay inside the boundary.
  assert.equal(connect(`${hub}/ws`, hub).meta.isTrusted, true)
  assert.equal(connect(`${hub}/ws`, 'http://localhost:5173').meta.isTrusted, true)
  assert.equal(connect(`${hub}/ws`, null).meta.isTrusted, true)
  // A sandboxed frame presents `null` too but cannot know the token.
  const sandboxed = connect(`${hub}/ws`, 'null')
  assert.equal(sandboxed.meta.isTrusted, undefined)
  assert.equal(connect(`${hub}/ws?devframe_auth_token=wrong`, 'null').meta.isTrusted, undefined)

  assert.equal(auth.authorize('anonymous:devframe:auth', sandboxed), true)
  assert.equal(auth.authorize('lody-devbar:record-sample', sandboxed), false)
  assert.equal(auth.authorize('lody-devbar:record-sample', tokenSession), true)
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
      heapPrecise: true,
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
    heapPrecise: false,
    cpu: 12.5,
    rssBytes: 300 * 1024 * 1024,
    gpuCpu: 4,
    gpuRssBytes: 50 * 1024 * 1024,
    warmPool: {
      enabled: true,
      phase: 'ready',
      spareRssBytes: 180 * 1024 * 1024,
      spareCount: 1,
      claimCount: 2
    },
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
    heap: '~20 MiB',
    blocked: '72 ms'
  })
  assert.equal(state.metrics['Electron CPU'], '12.5%')
  assert.equal(state.metrics['JavaScript heap'], '~20 MiB')
  assert.equal(state.metrics['Warm pool'], 'ready (1 spare)')
  assert.equal(state.metrics['Warm spare RSS'], '180 MiB')
  assert.deepEqual(state.longTasks, [
    { observed: '12:34:56', duration: '72.3 ms', attribution: 'self' }
  ])

  // A healthy main thread with a shifting layout is not "Responsive" either.
  assert.equal(
    createDevbarViewState({
      updatedAtMs: 2_000,
      latest: { ...latest, fps: 60, cls: 0.3, longTasks: [] },
      samples: [{ ...latest, fps: 60, cls: 0.3, longTasks: [] }],
      longTasks: [],
      summary: {
        sampleCount: 1,
        longTaskCount: 0,
        totalLongTaskDurationMs: 0,
        maxLongTaskDurationMs: 0
      }
    }).statusText,
    'Needs attention'
  )
})

void test('devbar deep links select only the main-thread diagnostics view', () => {
  assert.equal(isDevbarDeepLink('lody://devbar?view=main-thread'), true)
  assert.equal(isDevbarDeepLink('lody-dev://devbar?view=main-thread'), true)
  assert.equal(isDevbarDeepLink('lody://devbar?view=other'), false)
  assert.equal(isDevbarDeepLink('https://devbar?view=main-thread'), false)
  assert.equal(isDevbarDeepLink('not a URL'), false)
})

void test('lody loopback routes serve the dock renderer module and the live snapshot', () => {
  const snapshot = {
    updatedAtMs: 1_000,
    latest: null,
    samples: [],
    longTasks: [],
    summary: {
      sampleCount: 0,
      longTaskCount: 0,
      totalLongTaskDurationMs: 0,
      maxLongTaskDurationMs: 0
    }
  }
  const respond = () => {
    const response = {
      statusCode: 0,
      headers: {},
      body: undefined,
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value
      },
      writeHead(status) {
        this.statusCode = status
        return this
      },
      end(body) {
        this.body = body
      }
    }
    return response
  }
  const get = (url, method = 'GET', origin) => {
    const response = respond()
    const handled = handleDevbarLocalRoute(
      { method, url, headers: origin === undefined ? {} : { origin } },
      response,
      () => snapshot
    )
    return { handled, response }
  }

  const renderer = get('/__lody/dock-renderer.mjs')
  assert.equal(renderer.handled, true)
  assert.match(renderer.response.headers['content-type'], /text\/javascript/)
  assert.match(renderer.response.body, /export default async function main/)

  const json = get('/__lody/snapshot.json')
  assert.equal(json.handled, true)
  assert.deepEqual(JSON.parse(json.response.body), snapshot)

  assert.equal(get('/__lody/unknown').handled, false)
  assert.equal(get('/__lody/snapshot.json', 'POST').handled, false)
  // Opaque origins cannot tell a packaged file:// page from a sandboxed frame,
  // so local routes refuse `Origin: null` outright.
  const opaque = get('/__lody/snapshot.json', 'GET', 'null')
  assert.equal(opaque.handled, true)
  assert.equal(opaque.response.statusCode, 403)
  assert.equal(get('/__lody/dock-renderer.mjs', 'GET', 'http://127.0.0.1:9765').handled, true)
})

void test('devbar request listener isolates Hub middleware failures as 500', () => {
  const respond = () => ({
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    }
  })
  const request = () => ({ method: 'GET', url: '/devframe/unknown', headers: {} })
  const base = { isAllowedOrigin: () => true, snapshot: () => ({}) }

  // While the Hub is still starting, non-local requests wait politely.
  const pending = createDevbarRequestListener({ ...base, forward: () => undefined })
  const warming = respond()
  pending(request(), warming)
  assert.equal(warming.statusCode, 503)

  // A synchronously throwing middleware is an HTTP 500, never a process crash.
  const throwing = createDevbarRequestListener({
    ...base,
    forward: () => () => {
      throw new Error('hub exploded')
    }
  })
  const crashed = respond()
  throwing(request(), crashed)
  assert.equal(crashed.statusCode, 500)
  const afterCrash = respond()
  throwing(request(), afterCrash)
  assert.equal(afterCrash.statusCode, 500)

  const missing = createDevbarRequestListener({
    ...base,
    forward: () => (_req, _res, next) => next()
  })
  const notFound = respond()
  missing(request(), notFound)
  assert.equal(notFound.statusCode, 404)

  const denied = createDevbarRequestListener({
    ...base,
    isAllowedOrigin: () => false,
    forward: () => undefined
  })
  const forbidden = respond()
  denied(request(), forbidden)
  assert.equal(forbidden.statusCode, 403)
})

void test('devbar samples record the hash-history route, not the HTML entry path', () => {
  assert.equal(
    devbarSampleRoute({
      pathname: '/devbar.html',
      search: '',
      hash: '#/sessions/abc?focus=1'
    }),
    '/sessions/abc?focus=1'
  )
  assert.equal(
    devbarSampleRoute({
      pathname: '/Applications/Lody.app/Contents/Resources/app.asar/out/renderer/devbar.html',
      search: '',
      hash: '#/settings'
    }),
    '/settings'
  )
  assert.equal(
    devbarSampleRoute({ pathname: '/devbar.html', search: '', hash: '' }),
    '/devbar.html'
  )
})
