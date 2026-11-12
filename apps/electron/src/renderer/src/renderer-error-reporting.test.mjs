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

void test('recovery reload awaits IPC rejection and falls back to document reload', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const source = await readFile(new URL('./recovery-entry.ts', import.meta.url), 'utf8')
  for (const mode of ['rejected', 'unavailable', 'accepted']) {
    let options
    let page = 'recovery'
    const deps = {
      '@lody/components/lib/boot-failure': {
        renderBootFailure: (_root, _error, value) => {
          options = value
        }
      },
      '@lody/components/lib/electron-ipc-client': {
        getIpcServices: () =>
          mode === 'unavailable'
            ? null
            : {
                app: {
                  requestRendererReload: async () => {
                    if (mode === 'rejected') throw new Error('IPC refused')
                    page = 'product'
                  },
                  reportRendererFatalError: async () => {
                    throw new Error('report refused')
                  }
                }
              }
      }
    }
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
      }).outputText,
      {
        exports: {},
        URLSearchParams,
        document: { getElementById: () => ({}) },
        window: {
          location: {
            hash: '#source=did-fail-load',
            reload: () => {
              page = 'document-reloaded'
            }
          }
        },
        console: { warn() {} },
        require: (id) => {
          if (!(id in deps)) throw new Error(id)
          return deps[id]
        }
      }
    )
    await options.onReload()
    assert.equal(page, mode === 'accepted' ? 'product' : 'document-reloaded')
    // Report rejection is observed rather than becoming an unhandled rejection.
    await options.onCopy()
  }
})
