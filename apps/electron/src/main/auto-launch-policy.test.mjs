import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_LAUNCH_ARG,
  getAutoLaunchQueryOptions,
  getAutoLaunchRegistrationSettings,
  resolveAutoLaunchEnabled,
  resolveAutoLaunchInvocation,
  shouldHideMainWindowOnAutoLaunch
} from './auto-launch-policy.ts'

void test('uses one stable identity to register and query each login item', () => {
  assert.deepEqual(getAutoLaunchQueryOptions('darwin'), { type: 'mainAppService' })
  assert.deepEqual(getAutoLaunchRegistrationSettings('darwin', true), {
    openAtLogin: true,
    type: 'mainAppService'
  })

  const windowsQuery = { args: [AUTO_LAUNCH_ARG] }
  assert.deepEqual(getAutoLaunchQueryOptions('win32'), windowsQuery)
  assert.deepEqual(getAutoLaunchRegistrationSettings('win32', true), {
    openAtLogin: true,
    ...windowsQuery
  })
  assert.deepEqual(getAutoLaunchRegistrationSettings('win32', false), {
    openAtLogin: false,
    ...windowsQuery
  })
})

void test('recognizes both current and legacy Windows login entries', () => {
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: true,
      executableWillLaunchAtLogin: true
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: false,
      executableWillLaunchAtLogin: true
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: false,
      executableWillLaunchAtLogin: false
    }),
    false
  )
})

void test('detects login launches from the platform-specific signal', () => {
  assert.equal(
    resolveAutoLaunchInvocation({
      platform: 'darwin',
      wasOpenedAtLogin: true,
      argv: []
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchInvocation({
      platform: 'win32',
      wasOpenedAtLogin: false,
      argv: [AUTO_LAUNCH_ARG]
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchInvocation({
      platform: 'linux',
      wasOpenedAtLogin: true,
      argv: [AUTO_LAUNCH_ARG]
    }),
    false
  )
})

const baseVisibilityInput = {
  preferenceEnabled: true,
  launchedAtLogin: true,
  initialPath: '/',
  hasInitialDeepLink: false
}

void test('hides only ordinary login launches with an explicit preference', () => {
  assert.equal(shouldHideMainWindowOnAutoLaunch(baseVisibilityInput), true)
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      preferenceEnabled: false
    }),
    false
  )
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      launchedAtLogin: false
    }),
    false
  )
})

void test('always shows onboarding and deep-link launches', () => {
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      initialPath: '/onboarding'
    }),
    false
  )
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      hasInitialDeepLink: true
    }),
    false
  )
})
