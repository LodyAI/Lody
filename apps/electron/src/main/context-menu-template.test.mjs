import assert from 'node:assert/strict'
import test from 'node:test'
import { buildContextMenuTemplate } from './context-menu-template.ts'

const LABELS = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All'
}

const ZH_LABELS = { ...LABELS, copy: '复制', paste: '粘贴' }

function params(overrides = {}) {
  const { editFlags = {}, ...rest } = overrides
  return {
    isEditable: false,
    selectionText: '',
    mediaType: 'none',
    editFlags: {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
      ...editFlags
    },
    ...rest
  }
}

void test('offers Copy for selected read-only text', () => {
  const template = buildContextMenuTemplate(
    params({ selectionText: 'hello from the agent' }),
    LABELS
  )
  assert.deepEqual(template, [{ role: 'copy', label: 'Copy', enabled: true }])
})

void test('draws no menu when the click has nothing to act on', () => {
  assert.deepEqual(buildContextMenuTemplate(params(), LABELS), [])
  assert.deepEqual(buildContextMenuTemplate(params({ selectionText: '   \n ' }), LABELS), [])
  // Chromium can report a selection it will not let us copy; a lone disabled
  // Copy reads as broken, so that draws nothing either.
  assert.deepEqual(
    buildContextMenuTemplate(params({ selectionText: 'x', editFlags: { canCopy: false } }), LABELS),
    []
  )
})

void test('leaves images to the renderer so one click draws one menu', () => {
  assert.deepEqual(
    buildContextMenuTemplate(params({ mediaType: 'image', selectionText: 'caption' }), LABELS),
    []
  )
})

void test('gives an editable field the full edit set', () => {
  const template = buildContextMenuTemplate(params({ isEditable: true }), LABELS)
  assert.deepEqual(
    template.map((entry) => ('type' in entry ? entry.type : entry.role)),
    ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']
  )
  assert.ok(template.every((entry) => 'type' in entry || entry.enabled))
})

void test('an editable field with nothing selected still offers Paste', () => {
  const template = buildContextMenuTemplate(
    params({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canUndo: false, canRedo: false }
    }),
    LABELS
  )
  const byRole = new Map(
    template.filter((entry) => 'role' in entry).map((entry) => [entry.role, entry.enabled])
  )
  assert.equal(byRole.get('paste'), true)
  assert.equal(byRole.get('cut'), false)
  assert.equal(byRole.get('copy'), false)
  assert.equal(byRole.get('undo'), false)
  assert.equal(byRole.get('selectAll'), true)
})

void test('labels follow the product language', () => {
  const template = buildContextMenuTemplate(params({ selectionText: '你好' }), ZH_LABELS)
  assert.deepEqual(template, [{ role: 'copy', label: '复制', enabled: true }])
})
