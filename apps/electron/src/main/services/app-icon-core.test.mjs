import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppIconController } from './app-icon-core.ts'
import { createAppIconPreferences } from './app-icon-preferences.ts'

void test('damaged cosmetic preferences recover without affecting unsupported hosts or startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-icon-preferences-'))
  const path = join(directory, 'app-icon.json')
  try {
    for (const invalid of ['{broken', '{"name":"removed-icon"}']) {
      await writeFile(path, invalid)
      const preferences = createAppIconPreferences(directory)
      const unsupported = createAppIconController({
        supported: false,
        ...preferences,
        apply: async () => {}
      })
      assert.equal((await unsupported.getState()).supported, false)
      assert.equal(await readFile(path, 'utf8'), invalid, 'unsupported hosts do not open storage')
      assert.equal(preferences.read(), 'default')
      preferences.write('aqua')
      assert.equal(createAppIconPreferences(directory).read(), 'aqua')
    }
    // A non-directory simulates a storage failure without depending on OS permissions.
    const preferences = createAppIconPreferences(path)
    const controller = createAppIconController({
      supported: true,
      ...preferences,
      apply: async () => {}
    })
    await assert.rejects(controller.getState())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function fixture(overrides = {}) {
  const state = { saved: 'default', installed: 'default' }
  const deps = {
    supported: true,
    read: () => state.saved,
    write: (name) => {
      state.saved = name
    },
    apply: async (name) => {
      state.installed = name
    },
    ...overrides
  }
  return { state, deps, controller: createAppIconController(deps) }
}

void test('selection persists across restart, repairs an update, and restores default', async () => {
  const { state, deps, controller } = fixture()
  assert.deepEqual(await controller.setIcon('aqua'), { supported: true, name: 'aqua' })
  assert.deepEqual(state, { saved: 'aqua', installed: 'aqua' })
  state.installed = 'default' // Updated app bundle has its original icon.
  const restarted = createAppIconController(deps)
  assert.deepEqual(await restarted.getState(), { supported: true, name: 'aqua' })
  assert.equal(state.installed, 'aqua')
  await restarted.setIcon('default')
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
})

void test('a native failure retains the saved selection and can be retried', async () => {
  const { state, deps, controller } = fixture()
  const apply = deps.apply
  deps.apply = async () => {
    throw new Error('Permission denied')
  }
  await assert.rejects(controller.setIcon('aqua'), /Permission denied/)
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
  deps.apply = apply
  await controller.setIcon('aqua')
  assert.deepEqual(state, { saved: 'aqua', installed: 'aqua' })
})

void test('a preference write failure rolls the native icon back', async () => {
  const { state, controller } = fixture({
    write: () => {
      throw new Error('Disk full')
    }
  })
  await assert.rejects(controller.setIcon('aqua'), /Disk full/)
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
})

void test('a refresh failure after changing the native icon restores the previous choice', async () => {
  const { state, deps, controller } = fixture()
  deps.apply = async (name) => {
    state.installed = name
    if (name === 'aqua') throw new Error('Unable to refresh application icon')
  }
  await assert.rejects(controller.setIcon('aqua'), /Unable to refresh/)
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
  await controller.setIcon('default')
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
})

void test('startup and competing windows cannot reorder changes', async () => {
  const { state, deps, controller } = fixture()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  deps.apply = async (name) => {
    if (name === 'aqua') {
      entered.resolve()
      await release.promise
    }
    state.installed = name
  }
  const first = controller.setIcon('aqua')
  await entered.promise
  const read = controller.getState()
  const last = controller.setIcon('default')
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
  release.resolve()
  await first
  assert.equal((await read).name, 'aqua')
  await last
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
})

void test('unsupported hosts and arbitrary paths never reach native application', async () => {
  const { state, controller } = fixture()
  for (const name of ['../../other.app', null, {}, '__proto__']) {
    await assert.rejects(controller.setIcon(name), /Unknown app icon/)
  }
  assert.deepEqual(state, { saved: 'default', installed: 'default' })
  const unsupported = fixture({
    supported: false,
    apply: async () => {
      throw new Error('Must not run')
    }
  })
  assert.deepEqual(await unsupported.controller.getState(), { supported: false, name: 'default' })
  await assert.rejects(unsupported.controller.setIcon('aqua'), /unsupported/)
})
