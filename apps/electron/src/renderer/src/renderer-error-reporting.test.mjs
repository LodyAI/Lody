import assert from 'node:assert/strict'
import test from 'node:test'
import { createRendererErrorReporting } from './renderer-error-reporting.ts'

function createHarness(initiallyCommitted = false) {
  let committed = initiallyCommitted
  const scheduled = []
  const fatalReports = []
  const bootFailures = []
  const reporting = createRendererErrorReporting({
    hasCommitted: () => committed,
    reportFatal: (error, scope) => fatalReports.push({ error, scope }),
    showBootFailure: (error, scope) => bootFailures.push({ error, scope }),
    schedule: (callback) => scheduled.push(callback)
  })

  return {
    reporting,
    fatalReports,
    bootFailures,
    commit: () => {
      committed = true
    },
    flush: () => {
      while (scheduled.length > 0) scheduled.shift()()
    }
  }
}

void test('routes a caught initial render through fatal IPC after the boundary commits', () => {
  const harness = createHarness()
  const error = new Error('caught during initial render')

  harness.reporting.onReactCaughtError(error)
  harness.commit()
  harness.flush()

  assert.deepEqual(harness.fatalReports, [{ error, scope: 'react:caught' }])
  assert.deepEqual(harness.bootFailures, [])
})

void test('shows the boot fallback for an uncaught initial render with no commit', () => {
  const harness = createHarness()
  const error = new Error('uncaught during initial render')

  harness.reporting.onReactUncaughtError(error)
  harness.flush()

  assert.deepEqual(harness.fatalReports, [])
  assert.deepEqual(harness.bootFailures, [{ error, scope: 'react:uncaught' }])
})

void test('persists caught and uncaught post-mount render errors without replacing the UI', () => {
  const harness = createHarness(true)
  const caught = new Error('caught after mount')
  const uncaught = new Error('uncaught after mount')

  harness.reporting.onReactCaughtError(caught)
  harness.reporting.onReactUncaughtError(uncaught)
  harness.flush()

  assert.deepEqual(harness.fatalReports, [
    { error: caught, scope: 'react:caught' },
    { error: uncaught, scope: 'react:uncaught' }
  ])
  assert.deepEqual(harness.bootFailures, [])
})

void test('routes unhandled rejections according to actual commit state', () => {
  const initial = createHarness()
  const initialError = new Error('initial rejection')
  initial.reporting.onUnhandledRejection({ reason: initialError })
  initial.flush()

  assert.deepEqual(initial.bootFailures, [{ error: initialError, scope: 'unhandledrejection' }])
  assert.deepEqual(initial.fatalReports, [])

  const mounted = createHarness(true)
  const mountedError = new Error('mounted rejection')
  mounted.reporting.onUnhandledRejection({ reason: mountedError })
  mounted.flush()

  assert.deepEqual(mounted.fatalReports, [{ error: mountedError, scope: 'unhandledrejection' }])
  assert.deepEqual(mounted.bootFailures, [])
})

void test('deduplicates the same Error across React and window reporting paths', () => {
  const harness = createHarness(true)
  const error = new Error('reported twice')

  harness.reporting.onReactCaughtError(error)
  harness.reporting.onWindowError({ error, message: error.message })
  harness.flush()

  assert.deepEqual(harness.fatalReports, [{ error, scope: 'react:caught' }])
  assert.deepEqual(harness.bootFailures, [])
})

void test('routes a synchronous pre-commit failure to the boot fallback', () => {
  const harness = createHarness()
  const error = new Error('router setup failed')

  harness.reporting.reportSynchronousError(error)
  harness.flush()

  assert.deepEqual(harness.bootFailures, [{ error, scope: 'boot:synchronous' }])
})
