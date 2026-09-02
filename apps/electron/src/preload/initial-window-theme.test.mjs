import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyInitialWindowThemeClass,
  installInitialWindowThemeClass
} from './initial-window-theme.ts'

function createRoot(initialClasses = []) {
  const classes = new Set(initialClasses)
  return {
    style: {},
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name)
    },
    get classNames() {
      return [...classes]
    }
  }
}

/** A document whose `<html>` the parser has not produced yet. */
function createParsingDocument() {
  return {
    documentElement: null,
    finishParsing(root) {
      this.documentElement = root
    }
  }
}

void test('marks the document element with the theme main already resolved', () => {
  const root = createRoot()
  const document = { documentElement: root }

  assert.equal(applyInitialWindowThemeClass(document, 'dark'), true)
  assert.deepEqual(root.classNames, ['dark'])
  assert.equal(root.style.colorScheme, 'dark')
})

void test('leaves a theme class that is already on the document alone', () => {
  // The renderer may have mounted before this runs on a reload. Its choice is
  // newer than the launch argument and must win.
  const root = createRoot(['light'])
  const document = { documentElement: root }

  assert.equal(applyInitialWindowThemeClass(document, 'dark'), true)
  assert.deepEqual(root.classNames, ['light'])
  assert.equal(root.style.colorScheme, undefined)
})

void test('applies synchronously when the document element already exists', () => {
  const root = createRoot()
  let observed = false

  installInitialWindowThemeClass({ documentElement: root }, 'dark', () => {
    observed = true
    return { observe: () => {}, disconnect: () => {} }
  })

  assert.deepEqual(root.classNames, ['dark'])
  assert.equal(observed, false, 'no observer is needed once <html> exists')
})

void test('waits for the parser to insert <html>, then stops observing', () => {
  const document = createParsingDocument()
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
  assert.equal(disconnects, 0)

  // A mutation that is not yet the document element must not end the watch.
  notify()
  assert.equal(disconnects, 0)

  const root = createRoot()
  document.finishParsing(root)
  notify()

  assert.deepEqual(root.classNames, ['dark'])
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(disconnects, 1)
})
