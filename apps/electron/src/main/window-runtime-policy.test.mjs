import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMainWindowRuntimePolicy } from './window-runtime-policy.ts'

void test('shows normal desktop windows with Chromium background throttling enabled', () => {
  assert.deepEqual(
    resolveMainWindowRuntimePolicy({
      isPackaged: false
    }),
    {
      backgroundThrottling: true,
      showWhenReady: true
    }
  )
})

void test('keeps unpackaged E2E windows hidden without throttling their renderer', () => {
  assert.deepEqual(
    resolveMainWindowRuntimePolicy({
      isPackaged: false,
      e2eFlag: '1'
    }),
    {
      backgroundThrottling: false,
      showWhenReady: false
    }
  )
})

void test('requires exact E2E flag values', () => {
  assert.deepEqual(
    resolveMainWindowRuntimePolicy({
      isPackaged: false,
      e2eFlag: 'true',
      showE2EWindowFlag: '1'
    }),
    {
      backgroundThrottling: true,
      showWhenReady: true
    }
  )
})

void test('shows an unpackaged E2E window only when headed debugging is requested', () => {
  assert.deepEqual(
    resolveMainWindowRuntimePolicy({
      isPackaged: false,
      e2eFlag: '1',
      showE2EWindowFlag: '1'
    }),
    {
      backgroundThrottling: false,
      showWhenReady: true
    }
  )
})

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
