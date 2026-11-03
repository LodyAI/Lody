import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInitialDesktopPath } from './onboarding-launch-policy.ts'

void test('opens onboarding for incomplete packaged installs', () => {
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: true,
      onboardingCompleted: false,
      forceOnboarding: false
    }),
    '/onboarding'
  )
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: true,
      onboardingCompleted: true,
      forceOnboarding: false
    }),
    '/'
  )
})
