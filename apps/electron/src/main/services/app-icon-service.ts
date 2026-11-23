import { app } from 'electron'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createAppIconController } from './app-icon-core'
import { createAppIconPreferences } from './app-icon-preferences'
import { setMacApplicationIcon } from './app-icon-native'

export function createElectronAppIconService(defaultIcon: string, aquaIcon: string) {
  // Never modify the shared Electron development executable.
  const supported = process.platform === 'darwin' && app.isPackaged
  const preferences = createAppIconPreferences(app.getPath('userData'))
  return createAppIconController({
    supported,
    ...preferences,
    apply: async (name) => {
      const bundlePath = join(app.getPath('exe'), '../../..')
      if (name === 'default') {
        await setMacApplicationIcon(bundlePath, null)
      } else {
        // Electron reads ASAR assets, but AppKit needs a real file for alternate icons.
        const directory = await mkdtemp(join(app.getPath('temp'), 'lody-app-icon-'))
        try {
          const imagePath = join(directory, 'icon.png')
          await writeFile(imagePath, await readFile(aquaIcon))
          await setMacApplicationIcon(bundlePath, imagePath)
        } finally {
          await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
            console.warn('[Electron] Failed to remove temporary app icon', error)
          })
        }
      }
      app.dock?.setIcon(name === 'default' ? defaultIcon : aquaIcon)
    }
  })
}
