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
      const iconPath = name === 'default' ? defaultIcon : aquaIcon
      // Electron reads assets from ASAR, but AppKit needs a real filesystem path.
      const directory = await mkdtemp(join(app.getPath('temp'), 'lody-app-icon-'))
      try {
        const imagePath = join(directory, 'icon.png')
        await writeFile(imagePath, await readFile(iconPath))
        const bundlePath = join(app.getPath('exe'), '../../..')
        await setMacApplicationIcon(bundlePath, name === 'default' ? null : imagePath)
        app.dock?.setIcon(iconPath)
      } finally {
        await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
          console.warn('[Electron] Failed to remove temporary app icon', error)
        })
      }
    }
  })
}
