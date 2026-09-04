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
 *
 * Opening the file cannot fail fatally — `createMainSettingsStore` degrades to
 * defaults for the launch — so the guards below only cover a file that breaks
 * AFTER construction, which `conf` notices because it re-reads on every `get`.
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
    // `null` reproduces the pre-persistence behavior: this window opens on the
    // OS appearance rather than not opening at all.
    console.warn('[Electron] Failed to read the stored startup theme', error)
    return null
  }
}

export function writeStartupThemeSource(source: NativeWindowThemeSource): void {
  try {
    themeSettingsStore.set('startupThemeSource', source)
  } catch (error) {
    // Losing the mirror costs the next launch its pre-paint color; it must
    // never turn a theme toggle into a crash.
    console.warn('[Electron] Failed to persist the startup theme', error)
  }
}
