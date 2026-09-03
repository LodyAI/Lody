import assert from 'node:assert/strict'
import test from 'node:test'
import { installInitialWindowThemeClass } from './initial-window-theme.ts'

function createRoot() {
  const classes = new Set()
  return {
    style: {},
    classList: { add: (name) => classes.add(name) },
    get classNames() {
      return [...classes]
    }
  }
}

void test('marks <html> with the resolved theme once the parser inserts it', () => {
  // Preload runs at document start, so `documentElement` is null on the first
  // line and only the observer path ever fires.
  const document = { documentElement: null }
  const observeCalls = []
  let disconnects = 0
  let notify = () => {}

  installInitialWindowThemeClass(document, 'dark', (onMutation) => {
    notify = onMutation
    return {
      observe: (target, options) => observeCalls.push([target, options]),
      disconnect: () => {
        disconnects += 1
      }
    }
  })

  assert.deepEqual(observeCalls, [[document, { childList: true, subtree: true }]])

  // A mutation before `<html>` exists must not end the watch.
  notify()
  assert.equal(disconnects, 0)

  const root = createRoot()
  document.documentElement = root
  notify()

  assert.deepEqual(root.classNames, ['dark'])
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(disconnects, 1)
})
