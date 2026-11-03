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
