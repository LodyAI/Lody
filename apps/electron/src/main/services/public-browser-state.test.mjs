import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { observePublicBrowserInteraction } from './public-browser-interaction.ts'
import { mergePublicBrowserState } from './public-browser-state.ts'

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
  contents.emit('before-mouse-event', {}, { type: 'mouseWheel', deltaX: 0, deltaY: 0 })
  contents.emit(
    'before-mouse-event',
    {},
    { type: 'mouseWheel', deltaX: 0, deltaY: 20, modifiers: ['control'] }
  )
  contents.emit('before-mouse-event', {}, { type: 'mouseWheel', deltaX: 0, deltaY: 20 })
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'c', meta: true })
  contents.emit('before-mouse-event', {}, { type: 'mouseLeave' })
  assert.deepEqual(signals, [
    'pointer',
    'keyboard',
    'pointerdown',
    'wheel',
    'keyboard',
    'pointerleave'
  ])
  dispose()
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'y' })
  contents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 9, y: 9 })
  assert.deepEqual(signals, [
    'pointer',
    'keyboard',
    'pointerdown',
    'wheel',
    'keyboard',
    'pointerleave'
  ])
})
