import assert from 'node:assert/strict'
import test from 'node:test'
import { isRendererReloadShortcut } from './reload-shortcut.ts'

const input = {
  type: 'keyDown',
  code: 'KeyR',
  meta: false,
  control: false,
  alt: false,
  shift: false,
  isAutoRepeat: false
}

void test('matches Command+R on macOS and Ctrl+R elsewhere', () => {
  assert.equal(isRendererReloadShortcut({ ...input, meta: true }, 'darwin'), true)
  assert.equal(isRendererReloadShortcut({ ...input, control: true }, 'darwin'), false)
  assert.equal(isRendererReloadShortcut({ ...input, control: true }, 'linux'), true)
  assert.equal(isRendererReloadShortcut({ ...input, control: true }, 'win32'), true)
})

void test('routes force reload through the same guard but ignores other modified events', () => {
  assert.equal(isRendererReloadShortcut({ ...input, meta: true, shift: true }, 'darwin'), true)
  assert.equal(isRendererReloadShortcut({ ...input, meta: true, control: true }, 'darwin'), false)
  assert.equal(
    isRendererReloadShortcut({ ...input, meta: true, isAutoRepeat: true }, 'darwin'),
    false
  )
  assert.equal(isRendererReloadShortcut({ ...input, meta: true, type: 'keyUp' }, 'darwin'), false)
})
