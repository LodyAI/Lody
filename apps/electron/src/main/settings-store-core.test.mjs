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

// `conf` reads and validates inside its CONSTRUCTOR and, with
// `clearInvalidConfig` at its default, rethrows. Every store is built at module
// scope, so without the fallback either of these files stops the main process
// from importing at all — the app fails to launch because a preference file is
// malformed. Driven against the real `conf` and a real file for that reason.
void test('an unreadable settings file does not stop the launch', async () => {
  for (const contents of ['{"startupThemeSource": "da', '{"startupThemeSource": "vesper"}']) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'lody-settings-store-'))
    try {
      await writeFile(path.join(cwd, `${THEME_SETTINGS.configName}.json`), contents)
      const store = createSettingsStoreWithFallback(
        () => new Conf({ ...THEME_SETTINGS, cwd }),
        THEME_SETTINGS
      )
      assert.equal(store.get('startupThemeSource'), 'system')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
})
