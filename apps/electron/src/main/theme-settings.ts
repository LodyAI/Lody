import { createMainSettingsStore } from './settings-store'
import { isNativeWindowThemeSource, type NativeWindowThemeSource } from './window-theme'

type ThemeSettingsSchema = {
  startupThemeSource: NativeWindowThemeSource
}

/**
 * The theme the renderer last committed, mirrored into the main process.
 *
 * The renderer owns theme state in its own `localStorage`, which main cannot
 * read — and the window's `backgroundColor`, the Windows caption overlay, and
 * the pre-paint `.dark` class all have to be decided before any renderer code
 * runs. Without this mirror they can only follow the OS appearance, so a user
 * on an explicit dark theme under a light system opens a white window and
 * watches it turn black once React mounts.
 *
 * A preview (hovering a theme in Settings) deliberately does not land here:
 * only a committed choice describes how the next launch should look.
 */
const themeSettingsStore = createMainSettingsStore<ThemeSettingsSchema>({
  configName: 'theme-settings',
  defaults: { startupThemeSource: 'system' },
  schema: {
    startupThemeSource: { type: 'string', enum: ['light', 'dark', 'system'] }
  }
})

export function readStartupThemeSource(): NativeWindowThemeSource | null {
  try {
    const stored = themeSettingsStore.get('startupThemeSource')
    return isNativeWindowThemeSource(stored) ? stored : null
  } catch (error) {
    // A corrupt or unreadable settings file must not stop the window opening;
    // falling back to `null` reproduces the pre-persistence `system` behavior.
    console.warn('[Electron] Failed to read the stored startup theme', error)
    return null
  }
}

export function writeStartupThemeSource(source: NativeWindowThemeSource): void {
  try {
    themeSettingsStore.set('startupThemeSource', source)
  } catch (error) {
    console.warn('[Electron] Failed to persist the startup theme', error)
  }
}
