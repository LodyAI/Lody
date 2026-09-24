import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { desktopInstallationProfile } from './platform'
import { enableRendererHangStacks } from './renderer-hang-diagnostics'
import { registerLocalFileResourceScheme } from './services/local-file-resource-protocol'
import { initialDevbarControl } from './services/devbar/control'

// This module must be the first main entry import: auth/onboarding modules open
// stores during module evaluation, before index.ts's own statements execute.
if (desktopInstallationProfile.desktopUserDataName) {
  app.setName(desktopInstallationProfile.desktopProductName)
  const userData = join(app.getPath('appData'), desktopInstallationProfile.desktopUserDataName)
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
}

// On Linux, Electron/Chromium auto-detects the keyring backend for GNOME and KDE
// desktops, but falls back to basic-text (unencrypted) on other desktops like
// Sway, Hyprland, Niri, etc. — even when gnome-keyring-daemon is running and the
// org.freedesktop.secrets D-Bus service is available.
// Default to gnome-libsecret only when no --password-store flag was explicitly
// provided AND the desktop is not one Chromium already handles.
// Chromium auto-selects gnome-libsecret for: GNOME, Unity, Cinnamon, XFCE,
// Pantheon, Deepin, UKUI; and kwallet for KDE.
if (
  process.platform === 'linux' &&
  !process.argv.some((arg) => arg.startsWith('--password-store'))
) {
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase()
  const chromiumHandled = [
    'GNOME',
    'KDE',
    'UNITY',
    'CINNAMON',
    'XFCE',
    'PANTHEON',
    'DEEPIN',
    'UKUI'
  ]
  const isAutoDetected = chromiumHandled.some((d) => desktop.includes(d))
  if (!isAutoDetected) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
}

enableRendererHangStacks()
if (initialDevbarControl(process.env.LODY_DEVBAR).enabled) {
  app.commandLine.appendSwitch('enable-precise-memory-info')
}
registerLocalFileResourceScheme()

app.setName(desktopInstallationProfile.desktopProductName)
if (process.platform === 'linux') {
  // KDE resolves task-manager icons through the desktop file whose basename
  // matches the Wayland app_id / X11 WM_CLASS. Keep this dynamic because the
  // cloud and local desktop compositions intentionally use different IDs.
  // Electron 39 implements this API, but its bundled declaration omits it.
  const linuxApp = app as typeof app & { setDesktopName(name: string): void }
  linuxApp.setDesktopName(`${desktopInstallationProfile.desktopAppId}.desktop`)
}
