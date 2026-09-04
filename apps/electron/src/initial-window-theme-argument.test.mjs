import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readInitialWindowThemeArgument,
  serializeInitialWindowThemeArgument
} from './initial-window-theme-argument.ts'

void test('reads a resolved theme out of argv, and never guesses one', () => {
  assert.equal(
    readInitialWindowThemeArgument([
      'electron',
      '--lody-preferred-system-languages=%5B%22en-US%22%5D',
      serializeInitialWindowThemeArgument('dark')
    ]),
    'dark'
  )

  // An older window, or one whose argument was mangled, must fall through to
  // the renderer applying the class on mount — never to an invented theme that
  // could paint the opposite of what the user chose.
  for (const argv of [
    [],
    ['--lody-initial-window-theme='],
    ['--lody-initial-window-theme=system']
  ]) {
    assert.equal(readInitialWindowThemeArgument(argv), null)
  }
})
