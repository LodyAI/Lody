import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyResolvedWindowTheme,
  getInitialMainWindowThemeSource,
  getMainWindowBackgroundColor,
  getMainWindowTitleBarOverlay,
  isNativeWindowThemeSource,
  resolveNativeWindowTheme
} from './window-theme.ts'

void test('opens a product window on the committed theme, onboarding always light', () => {
  assert.equal(getInitialMainWindowThemeSource('/', 'dark'), 'dark')
  // Nothing committed yet (first launch) keeps the pre-persistence behavior.
  assert.equal(getInitialMainWindowThemeSource('/', null), 'system')
  assert.equal(getInitialMainWindowThemeSource('/onboarding', 'dark'), 'light')
})

void test('rejects a theme source that did not come from the product', () => {
  assert.equal(isNativeWindowThemeSource('dark'), true)
  assert.equal(isNativeWindowThemeSource('Dark'), false)
  assert.equal(isNativeWindowThemeSource(null), false)
})

void test('maps Electron shouldUseDarkColors onto the resolved window theme', () => {
  assert.equal(resolveNativeWindowTheme(true), 'dark')
  assert.equal(resolveNativeWindowTheme(false), 'light')
})

void test('retints window chrome when the OS appearance changes', () => {
  const calls = []
  const window = {
    setBackgroundColor: (color) => {
      calls.push(['background', color])
    },
    setTitleBarOverlay: (overlay) => {
      calls.push(['overlay', overlay])
    }
  }

  applyResolvedWindowTheme(window, 'dark', 'darwin')
  assert.deepEqual(calls, [['background', getMainWindowBackgroundColor('dark')]])

  calls.length = 0
  applyResolvedWindowTheme(window, 'light', 'win32')
  assert.deepEqual(calls, [
    ['background', getMainWindowBackgroundColor('light')],
    ['overlay', getMainWindowTitleBarOverlay('light')]
  ])
})
