import assert from 'node:assert/strict'
import test from 'node:test'
import { createTodayWindowLifecycle } from './today-window-lifecycle.ts'

const CHANNEL = 'app.todayWindowTarget'

function fakeWindow() {
  const listeners = new Map()
  const window = {
    destroyed: false,
    visible: true,
    fullScreen: false,
    sent: [],
    isDestroyed: () => window.destroyed,
    isFullScreen: () => window.fullScreen,
    setFullScreen(flag) {
      window.fullScreen = flag
      if (!flag) window.emit('leave-full-screen')
    },
    hide() {
      window.visible = false
    },
    destroy() {
      window.destroyed = true
      window.emit('closed')
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    once(event, listener) {
      const wrapped = (...args) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped)
        )
        listener(...args)
      }
      window.on(event, wrapped)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** What the window button does: emit close, then close unless prevented. */
    close() {
      let prevented = false
      window.emit('close', { preventDefault: () => (prevented = true) })
      if (!prevented) window.destroy()
    },
    webContents: {
      send: (channel, payload) => window.sent.push({ channel, payload }),
      on: (event, listener) => window.on(`webContents:${event}`, listener)
    }
  }
  return window
}

function setup({ otherWindow = true } = {}) {
  const created = []
  const parked = new Set()
  const timers = []
  const reopened = []
  const state = { quitting: false, otherWindow }
  const lifecycle = createTodayWindowLifecycle({
    create: () => {
      const window = fakeWindow()
      created.push(window)
      return window
    },
    focus: (window) => (window.visible = true),
    bindChannel: CHANNEL,
    canPark: () => !state.quitting && state.otherWindow,
    setParked: (window, value) => (value ? parked.add(window) : parked.delete(window)),
    setTimer: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => (timer.cancelled = true)
    },
    revealDeadlineMs: 1500,
    onReopened: (window) => reopened.push(window)
  })
  const fireTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback()
  }
  return { lifecycle, created, parked, state, reopened, fireTimers }
}

void test('closing parks the window and reopening binds the day before showing it', () => {
  const { lifecycle, created, parked, reopened } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.close()
  assert.equal(window.destroyed, false)
  assert.equal(window.visible, false)
  assert.equal(parked.has(window), true)
  assert.deepEqual(window.sent.at(-1), { channel: CHANNEL, payload: null })

  assert.equal(lifecycle.open({ workspace: 'w', date: '2026-11-25' }), window)
  assert.equal(created.length, 1)
  assert.equal(parked.has(window), true)
  assert.deepEqual(window.sent.at(-1), {
    channel: CHANNEL,
    payload: { member: undefined, date: '2026-11-25', bindingId: 1 }
  })
  assert.equal(window.visible, false, 'stays hidden until the day has painted')

  lifecycle.committed(window, 0)
  assert.equal(window.visible, false, 'a previous binding cannot reveal the window')
  lifecycle.committed(window, 1)
  assert.equal(window.visible, true)
  assert.equal(parked.has(window), false)
  assert.deepEqual(reopened, [window])
})

void test('an unresponsive renderer is replaced by a cold window for the requested day', () => {
  const { lifecycle, created, reopened, fireTimers } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.close()
  lifecycle.open({ workspace: 'w', date: '2026-11-25' })
  fireTimers()
  assert.equal(window.destroyed, true)
  assert.equal(created.length, 2)
  assert.deepEqual(reopened, [])
})

void test('only the most recently closed Today window is retained', () => {
  const { lifecycle } = setup()
  const first = lifecycle.open({ workspace: 'first' })
  const second = lifecycle.open({ workspace: 'second' })
  lifecycle.committed(first, 0)
  lifecycle.committed(second, 0)
  first.close()
  second.close()
  assert.equal(first.destroyed, true)
  assert.equal(second.visible, false)
})

void test('closing the last visible window or quitting skips parking', () => {
  const last = setup({ otherWindow: false })
  const alone = last.lifecycle.open({ workspace: 'w' })
  last.lifecycle.committed(alone, 0)
  alone.close()
  assert.equal(alone.destroyed, true)
  assert.notEqual(last.lifecycle.open({ workspace: 'w' }), alone)

  const quitting = setup()
  const window = quitting.lifecycle.open({ workspace: 'w' })
  quitting.lifecycle.committed(window, 0)
  quitting.state.quitting = true
  window.close()
  assert.equal(window.destroyed, true)
  assert.equal(quitting.lifecycle.has(window), false)
})

void test('a parked renderer that crashes is destroyed instead of reloading hidden', () => {
  const { lifecycle } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.close()
  window.emit('webContents:render-process-gone')
  assert.equal(window.destroyed, true)
  assert.equal(lifecycle.has(window), false)
})

void test('parking a fullscreen window leaves fullscreen before hiding', () => {
  const { lifecycle } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.fullScreen = true
  window.close()
  assert.equal(window.fullScreen, false)
  assert.equal(window.visible, false)
})

void test('disabling Today closes a visible or parked window for good', () => {
  const { lifecycle } = setup()
  for (const parked of [false, true]) {
    const window = lifecycle.open({ workspace: 'w' })
    lifecycle.committed(window, 0)
    if (parked) window.close()
    lifecycle.close(window)
    assert.equal(window.destroyed, true)
    assert.equal(lifecycle.has(window), false)
  }
})

void test('a reloaded Today window can park again', () => {
  const { lifecycle } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.close()
  lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 1)

  window.emit('webContents:did-start-navigation', null, '', false, true)
  lifecycle.committed(window, 0)
  window.close()
  assert.equal(window.destroyed, false)
  assert.equal(window.visible, false)
})

void test('closing during a pending reveal cancels the cold fallback', () => {
  const { lifecycle, created, fireTimers } = setup()
  const window = lifecycle.open({ workspace: 'w' })
  lifecycle.committed(window, 0)
  window.close()
  lifecycle.open({ workspace: 'w' })
  window.close()
  fireTimers()
  assert.equal(window.destroyed, true)
  assert.equal(created.length, 1)
})
