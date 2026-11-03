import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMainWindowRuntimePolicy } from './window-runtime-policy.ts'

void test('ignores E2E window flags in packaged applications', () => {
  assert.deepEqual(
    resolveMainWindowRuntimePolicy({
      isPackaged: true,
      e2eFlag: '1'
    }),
    {
      backgroundThrottling: true,
      showWhenReady: true
    }
  )
})
