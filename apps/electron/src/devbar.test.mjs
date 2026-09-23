/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node runs this JavaScript test module without TypeScript annotations. */
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

void test('chat capture separates cold reveal from re-hide, row loss and remount', async () => {
  const { createConversationCapture } =
    await import('./renderer/src/devbar/conversation-capture.ts')
  const capture = createConversationCapture(100)
  const frame = {
    route: 1,
    pane: 1,
    visible: false,
    scrollTop: 100,
    scrollHeight: 1000,
    viewportHeight: 400,
    mountedRows: 1,
    rowsTruncated: false,
    rows: []
  }
  capture.sample(100, frame)
  capture.sample(110, { ...frame, visible: true, rows: [{ id: 1, top: -10, height: 80 }] })
  assert.equal(capture.report().summary.observations.rehidden, undefined)
  capture.sample(120, frame)
  capture.sample(130, { ...frame, visible: true, rows: [{ id: 1, top: -10, height: 80 }] })
  capture.sample(140, { ...frame, visible: true })
  capture.sample(150, { ...frame, pane: null })
  capture.sample(160, { ...frame, pane: 2 })
  assert.deepEqual(capture.report().summary.observations, {
    route: 1,
    rehidden: 1,
    'rows-empty': 1,
    'pane-removed': 1,
    'pane-replaced': 1
  })
  capture.sample(170, { ...frame, route: 2, pane: 3 })
  assert.equal(capture.report().summary.observations['pane-replaced'], 1)
  assert.equal(capture.report().summary.observations.rehidden, 1)
})

void test('chat capture distinguishes retained anchor displacement from ordinary scroll', async () => {
  const { createConversationCapture } =
    await import('./renderer/src/devbar/conversation-capture.ts')
  const capture = createConversationCapture(0)
  const frame = {
    route: 1,
    pane: 1,
    visible: true,
    scrollTop: 6400,
    scrollHeight: 20848,
    viewportHeight: 500,
    mountedRows: 10,
    rowsTruncated: false,
    rows: [{ id: 61, top: -20, height: 104 }]
  }
  capture.sample(0, frame)
  capture.sample(16, {
    ...frame,
    scrollHeight: 20952,
    rows: [
      { id: 60, top: -20, height: 104 },
      { id: 61, top: 84, height: 104 }
    ]
  })
  assert.equal(capture.report().summary.observations['anchor-shift'], 1)
  capture.sample(32, { ...frame, scrollTop: 6504 })
  assert.equal(capture.report().summary.observations['anchor-shift'], 1)
  capture.stop(40, 'manual')
  assert.equal(capture.sample(50, frame), false)
  assert.equal(capture.report().samples.length, 3)
  assert.deepEqual(capture.report().ended, { atMs: 40, reason: 'manual' })
})

void test('chat capture bounds changing frames and event data without growing on unchanged frames', async () => {
  const { createConversationCapture } =
    await import('./renderer/src/devbar/conversation-capture.ts')
  const capture = createConversationCapture(0)
  const frame = {
    route: 1,
    pane: null,
    visible: false,
    scrollTop: 0,
    scrollHeight: 0,
    viewportHeight: 0,
    mountedRows: 0,
    rowsTruncated: false,
    rows: []
  }
  for (let i = 0; i < 100; i++) capture.sample(i, frame)
  assert.equal(capture.report().samples.length, 1)
  for (let i = 1; i < 1800; i++)
    assert.equal(capture.sample(i + 100, { ...frame, scrollTop: i }), true)
  assert.equal(capture.sample(2000, { ...frame, scrollTop: 2000 }), false)
  for (let i = 0; i < 300; i++) {
    capture.input(i, 'wheel')
    capture.longTask(i, 60)
  }
  assert.equal(capture.report().samples.length, 1800)
  assert.equal(capture.report().inputs.length, 200)
  assert.equal(capture.report().longTasks.length, 100)
  const timeout = createConversationCapture(0)
  assert.equal(timeout.sample(60_000, frame), false)
})

void test('runtime capture aliases DOM identities and releases observers, frames and listeners on stop or failure', async (t) => {
  const { startConversationCapture } = await import('./renderer/src/devbar/conversation-capture.ts')
  const pendingFrames = new Map()
  const timers = new Map()
  const listeners = new Map()
  let nextId = 1
  let now = 100
  let fail = false
  let observerConnected = false
  const reports = []
  const pane = {
    scrollTop: 100,
    scrollHeight: 1000,
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, width: 500, height: 400 }),
    querySelectorAll: () => [
      {
        dataset: { conversationRowKey: 'private-turn-id' },
        getBoundingClientRect: () => ({ top: -10, bottom: 90, height: 100 })
      }
    ]
  }
  const document = {
    hidden: false,
    querySelector() {
      if (fail) throw new Error('unavailable')
      return pane
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type)
  }
  const replacements = {
    document,
    window: { location: { hash: '#/sessions/private-session-id', pathname: '/' } },
    requestAnimationFrame: (callback) => {
      const id = nextId++
      pendingFrames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id) => pendingFrames.delete(id),
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    PerformanceObserver: class {
      static supportedEntryTypes = ['longtask']
      observe() {
        observerConnected = true
      }
      disconnect() {
        observerConnected = false
      }
    }
  }
  const originals = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  )
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    const id = nextId++
    timers.set(id, callback)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id))
  const stopped = () => {
    assert.equal(pendingFrames.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
    assert.equal(observerConnected, false)
  }
  const capture = startConversationCapture((report) => reports.push(report))
  now = 116
  capture.stop()
  capture.stop()
  stopped()
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0].samples[0].frame.rows, [{ id: 1, top: -10, height: 100 }])
  assert.equal(JSON.stringify(reports).includes('private-'), false)
  assert.equal(reports[0].ended.reason, 'manual')

  startConversationCapture((report) => reports.push(report))
  fail = true
  const [id, callback] = pendingFrames.entries().next().value
  pendingFrames.delete(id)
  callback()
  stopped()
  assert.equal(reports.at(-1).ended.reason, 'error')
  fail = false
  startConversationCapture((report) => reports.push(report))
  document.hidden = true
  listeners.get('visibilitychange')()
  stopped()
  assert.equal(reports.at(-1).ended.reason, 'hidden')
  document.hidden = false
  startConversationCapture((report) => reports.push(report))
  now += 60_000
  timers.values().next().value()
  stopped()
  assert.equal(reports.at(-1).ended.reason, 'timeout')
})
