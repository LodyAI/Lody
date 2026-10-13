import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyResolvedWindowTheme,
  getInitialMainWindowThemeSource,
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

void test('keeps Windows caption backgrounds transparent through theme changes', () => {
  const window = {
    backgroundColor: null,
    overlay: getMainWindowTitleBarOverlay('light'),
    setBackgroundColor(color) {
      this.backgroundColor = color
    },
    setTitleBarOverlay(overlay) {
      this.overlay = overlay
    }
  }

  assert.deepEqual(window.overlay, {
    color: '#00000000',
    symbolColor: '#3C4048',
    height: 36
  })

  applyResolvedWindowTheme(window, 'dark', 'win32')
  assert.equal(window.backgroundColor, '#131416')
  assert.deepEqual(window.overlay, {
    color: '#00000000',
    symbolColor: '#7A7D82',
    height: 36
  })

  applyResolvedWindowTheme(window, 'light', 'win32')
  assert.equal(window.backgroundColor, '#FFFFFF')
  assert.deepEqual(window.overlay, {
    color: '#00000000',
    symbolColor: '#3C4048',
    height: 36
  })

  applyResolvedWindowTheme(window, 'dark', 'darwin')
  assert.equal(window.backgroundColor, '#131416')
  assert.equal(window.overlay.symbolColor, '#3C4048')
})
