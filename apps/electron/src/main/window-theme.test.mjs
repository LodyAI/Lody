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

void test('forces onboarding window chrome light until the product takes over', () => {
  assert.equal(getInitialMainWindowThemeSource('/onboarding'), 'light')
  // Even a user on an explicit dark theme sees Light onboarding chrome.
  assert.equal(getInitialMainWindowThemeSource('/onboarding', 'dark'), 'light')
})

void test('opens a product window on the theme the renderer last committed', () => {
  assert.equal(getInitialMainWindowThemeSource('/', 'dark'), 'dark')
  assert.equal(getInitialMainWindowThemeSource('/', 'light'), 'light')
  assert.equal(getInitialMainWindowThemeSource('/', 'system'), 'system')
})

void test('falls back to the OS appearance when nothing has been committed', () => {
  assert.equal(getInitialMainWindowThemeSource('/', null), 'system')
  assert.equal(getInitialMainWindowThemeSource('/'), 'system')
  assert.equal(getInitialMainWindowThemeSource(), 'system')
})

void test('accepts only the three native theme sources', () => {
  assert.equal(isNativeWindowThemeSource('light'), true)
  assert.equal(isNativeWindowThemeSource('dark'), true)
  assert.equal(isNativeWindowThemeSource('system'), true)
  for (const value of ['', 'Dark', 'vesper', null, undefined, 0, {}]) {
    assert.equal(isNativeWindowThemeSource(value), false)
  }
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
