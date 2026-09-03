import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readInitialWindowThemeArgument,
  serializeInitialWindowThemeArgument
} from './initial-window-theme-argument.ts'

void test('round-trips the resolved window theme from main to preload', () => {
  for (const theme of ['light', 'dark']) {
    assert.equal(
      readInitialWindowThemeArgument([
        'electron',
        '--lody-preferred-system-languages=%5B%22en-US%22%5D',
        serializeInitialWindowThemeArgument(theme)
      ]),
      theme
    )
  }
})

void test('reports no theme rather than guessing one', () => {
  // An older window, or one whose argument was mangled, must fall through to
  // the renderer applying the class on mount — never to an invented theme that
  // could paint the opposite of what the user chose.
  assert.equal(readInitialWindowThemeArgument(['electron']), null)
  assert.equal(readInitialWindowThemeArgument(['--lody-initial-window-theme=']), null)
  assert.equal(readInitialWindowThemeArgument(['--lody-initial-window-theme=system']), null)
  assert.equal(readInitialWindowThemeArgument(['--lody-initial-window-theme=Dark']), null)
})
