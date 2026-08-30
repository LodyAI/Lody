import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKGROUND_AUTO_LAUNCH_ARG,
  shouldStartMainWindowInBackground
} from './auto-launch-policy.ts'

const baseInput = {
  preferenceEnabled: true,
  wasOpenedAtLogin: true,
  wasOpenedAsHidden: false,
  argv: [],
  initialPath: '/',
  hasInitialDeepLink: false
}

void test('starts a normal login launch in the background when enabled', () => {
  assert.equal(shouldStartMainWindowInBackground(baseInput), true)
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      wasOpenedAtLogin: false,
      wasOpenedAsHidden: true
    }),
    true
  )
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      wasOpenedAtLogin: false,
      argv: [BACKGROUND_AUTO_LAUNCH_ARG]
    }),
    true
  )
})

void test('shows ordinary user launches and disabled background launches', () => {
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      wasOpenedAtLogin: false
    }),
    false
  )
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      preferenceEnabled: false
    }),
    false
  )
})

void test('always shows onboarding and deep-link launches', () => {
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      initialPath: '/onboarding'
    }),
    false
  )
  assert.equal(
    shouldStartMainWindowInBackground({
      ...baseInput,
      hasInitialDeepLink: true
    }),
    false
  )
})
