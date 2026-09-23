import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { observePublicBrowserInteraction } from './public-browser-interaction.ts'
import { isNavigationAbortError, mergePublicBrowserState } from './public-browser-state.ts'

void test('recognizes structured Electron navigation abort errors', () => {
  assert.equal(isNavigationAbortError({ code: 'ERR_ABORTED', errno: -3 }), true)
  assert.equal(isNavigationAbortError({ code: -3 }), true)
  assert.equal(isNavigationAbortError({ errno: -3 }), true)
})

void test('does not hide real or unstructured navigation failures', () => {
  assert.equal(isNavigationAbortError({ code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }), false)
  assert.equal(
    isNavigationAbortError(new Error("ERR_ABORTED (-3) loading 'https://example.com/'")),
    false
  )
})

void test('keeps a requested URL authoritative until Chromium commits the navigation', () => {
  const previous = {
    browserId: 'session-browser-1',
    phase: 'ready',
    url: 'https://old.example/',
    title: 'Old page',
    canGoBack: false,
    canGoForward: false
  }

  const requested = mergePublicBrowserState(
    previous,
    {
      committedUrl: 'https://old.example/',
      committedTitle: 'Old page',
      canGoBack: false,
      canGoForward: false
    },
    { phase: 'loading', url: 'https://new.example/' }
  )
  const loading = mergePublicBrowserState(requested, {
    committedUrl: 'https://old.example/',
    committedTitle: 'Old page',
    canGoBack: false,
    canGoForward: false
  })

  assert.equal(loading.url, 'https://new.example/')
  assert.equal(loading.phase, 'loading')
})

void test('accepts the committed URL from an explicit navigation event', () => {
  const loading = {
    browserId: 'session-browser-1',
    phase: 'loading',
    url: 'https://new.example/',
    title: 'Old page',
    canGoBack: false,
    canGoForward: false
  }

  const committed = mergePublicBrowserState(
    loading,
    {
      committedUrl: 'https://new.example/',
      committedTitle: 'New page',
      canGoBack: true,
      canGoForward: false
    },
    { phase: 'ready', url: 'https://new.example/', title: 'New page' }
  )

  assert.equal(committed.url, 'https://new.example/')
  assert.equal(committed.title, 'New page')
  assert.equal(committed.canGoBack, true)
})

void test('native browser forwards only deliberate ownership signals and cleans up listeners', () => {
  const contents = new EventEmitter()
  const signals = []
  const dispose = observePublicBrowserInteraction(contents, (source) => signals.push(source))
  contents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 1, y: 2 })
  contents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 1, y: 2 })
  contents.emit(
    'before-mouse-event',
    {},
    { type: 'mouseMove', x: 2, y: 2, modifiers: ['leftButtonDown'] }
  )
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'w', meta: true })
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'w', control: true })
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'Shift' })
  contents.emit('before-input-event', {}, { type: 'keyUp', key: 'x' })
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'x' })
  contents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 2, y: 2 })
  assert.deepEqual(signals, ['pointer', 'keyboard', 'pointer'])
  dispose()
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'y' })
  contents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 9, y: 9 })
  assert.deepEqual(signals, ['pointer', 'keyboard', 'pointer'])
  assert.equal(contents.listenerCount('before-input-event'), 0)
  assert.equal(contents.listenerCount('before-mouse-event'), 0)
})
