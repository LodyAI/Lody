import assert from 'node:assert/strict'
import test from 'node:test'
import { createRendererProcessGoneHandling } from './renderer-process-gone.ts'

void test('keeps an unexpected renderer crash on the recovery surface while main reports it', () => {
  const handling = createRendererProcessGoneHandling({ reason: 'crashed', exitCode: 139 })

  assert.deepEqual(handling?.report.component, 'electron-renderer')
  assert.deepEqual(handling?.report.extra, {
    source: 'render-process-gone',
    renderer_crash_reason: 'crashed',
    renderer_exit_code: 139
  })
  assert.equal(handling?.report.error.message, 'The Lody renderer process exited unexpectedly.')
  assert.deepEqual(handling?.recovery, {
    message: 'The Lody window crashed.',
    details: 'Reason: crashed\nExit code: 139',
    source: 'render-process-gone'
  })
})

void test('does not report or replace a clean renderer shutdown', () => {
  assert.equal(createRendererProcessGoneHandling({ reason: 'clean-exit', exitCode: 0 }), null)
})
