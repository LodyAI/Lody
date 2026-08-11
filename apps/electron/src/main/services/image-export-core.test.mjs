import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSaveFileFilters, resolveSaveFileName } from './image-export-core.ts'

void test('reduces a renderer-supplied name to a base name', () => {
  assert.equal(resolveSaveFileName('screenshot.png'), 'screenshot.png')
  assert.equal(resolveSaveFileName('  spaced name.png  '), 'spaced name.png')
  assert.equal(resolveSaveFileName('docs/assets/diagram.png'), 'diagram.png')
  assert.equal(resolveSaveFileName('C:\\Users\\me\\diagram.png'), 'diagram.png')
  assert.equal(resolveSaveFileName('../../../etc/passwd'), 'passwd')
})

void test('falls back when a name carries no usable base', () => {
  assert.equal(resolveSaveFileName('.'), 'image.png')
  assert.equal(resolveSaveFileName('..'), 'image.png')
  assert.equal(resolveSaveFileName('   '), 'image.png')
  assert.equal(resolveSaveFileName('assets/'), 'assets')
})

void test('offers the file own extension first, then all files', () => {
  assert.deepEqual(buildSaveFileFilters('shot.PNG'), [
    { name: 'PNG', extensions: ['png'] },
    { name: 'All Files', extensions: ['*'] }
  ])
  assert.deepEqual(buildSaveFileFilters('photo.jpeg'), [
    { name: 'JPEG', extensions: ['jpeg'] },
    { name: 'All Files', extensions: ['*'] }
  ])
})

void test('does not invent an extension for a name without one', () => {
  assert.deepEqual(buildSaveFileFilters('clipboard'), [{ name: 'All Files', extensions: ['*'] }])
})
