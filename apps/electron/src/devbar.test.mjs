/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node runs this JavaScript test module without TypeScript annotations. */
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node runs this JavaScript test module without TypeScript annotations. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialDevbarControl,
  devbarRendererEntry,
  createDevbarAuth
} from './main/services/devbar/control.ts'

import { handleDevbarLocalRoute } from './main/services/devbar/local-routes.ts'

void test('environment activation remains an explicit automation override', () => {
  assert.deepEqual(initialDevbarControl('true'), { enabled: true })
  for (const value of [undefined, '', 'false', '0', '1', 'dev', 'staging', 'prod']) {
    assert.deepEqual(initialDevbarControl(value), { enabled: false })
  }
})

void test('runtime activation selects the Devbar entry only for the primary product window', () => {
  assert.equal(devbarRendererEntry(false, false), 'index.html')
  assert.equal(devbarRendererEntry(true, false), 'devbar.html')
  assert.equal(devbarRendererEntry(true, true), 'index.html')
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
