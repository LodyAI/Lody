import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Conf from 'conf'
import { createSettingsStoreWithFallback } from './settings-store-core.ts'

const THEME_SETTINGS = {
  configName: 'theme-settings',
  defaults: { startupThemeSource: 'system' },
  schema: {
    startupThemeSource: { type: 'string', enum: ['light', 'dark', 'system'] }
  }
}

async function withConfigFile(contents, run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lody-settings-store-'))
  try {
    await writeFile(path.join(cwd, `${THEME_SETTINGS.configName}.json`), contents)
    // The real `conf`, against a real file on disk: this asserts what actually
    // reaches a launching main process, not a stubbed failure.
    await run(() =>
      createSettingsStoreWithFallback(() => new Conf({ ...THEME_SETTINGS, cwd }), THEME_SETTINGS)
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

// `conf` reads and validates inside its constructor and, with
// `clearInvalidConfig` at its default, rethrows. Every store here is built at
// module scope, so without the fallback these two files stop the main process
// from importing at all — the app would not launch because a preference file
// is malformed.
void test('a truncated settings file does not stop the launch', async () => {
  await withConfigFile('{"startupThemeSource": "da', (open) => {
    assert.equal(open().get('startupThemeSource'), 'system')
  })
})

void test('a settings value outside the schema does not stop the launch', async () => {
  await withConfigFile('{"startupThemeSource": "vesper"}', (open) => {
    assert.equal(open().get('startupThemeSource'), 'system')
  })
})

void test('a readable settings file is still read from disk', async () => {
  await withConfigFile('{"startupThemeSource": "dark"}', (open) => {
    const store = open()
    assert.equal(store.get('startupThemeSource'), 'dark')

    store.set('startupThemeSource', 'light')
    assert.equal(store.get('startupThemeSource'), 'light')
    // A second open proves the write reached the file rather than memory.
    assert.equal(open().get('startupThemeSource'), 'light')
  })
})
