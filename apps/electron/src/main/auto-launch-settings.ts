import { app } from 'electron'
import {
  getAutoLaunchQueryOptions,
  getAutoLaunchRegistrationSettings,
  resolveAutoLaunchEnabled,
  resolveAutoLaunchInvocation,
  type AutoLaunchPlatform
} from './auto-launch-policy'
import { createMainSettingsStore } from './settings-store'

type AutoLaunchSettingsSchema = {
  hideWindowOnAutoLaunch: boolean
}

const autoLaunchSettingsStore = createMainSettingsStore<AutoLaunchSettingsSchema>({
  configName: 'auto-launch-settings',
  defaults: { hideWindowOnAutoLaunch: false },
  schema: {
    hideWindowOnAutoLaunch: { type: 'boolean' }
  }
})

function getAutoLaunchPlatform(): AutoLaunchPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return process.platform
  }
  return 'linux'
}

export function getHideWindowOnAutoLaunchEnabled(): boolean {
  return autoLaunchSettingsStore.get('hideWindowOnAutoLaunch')
}

export function setHideWindowOnAutoLaunchEnabled(enabled: boolean): void {
  autoLaunchSettingsStore.set('hideWindowOnAutoLaunch', enabled)
}

export function getAutoLaunchEnabled(): boolean {
  const platform = getAutoLaunchPlatform()
  if (platform === 'linux') {
    return false
  }

  const settings = app.getLoginItemSettings(getAutoLaunchQueryOptions(platform))
  return resolveAutoLaunchEnabled(platform, settings)
}

export function getAutoLaunchInvocationStatus(argv: readonly string[] = process.argv): {
  launchedAtLogin: boolean
} {
  const platform = getAutoLaunchPlatform()
  if (platform === 'linux') {
    return { launchedAtLogin: false }
  }
  if (platform === 'win32') {
    return {
      launchedAtLogin: resolveAutoLaunchInvocation({
        platform,
        wasOpenedAtLogin: false,
        argv
      })
    }
  }

  try {
    const settings = app.getLoginItemSettings(getAutoLaunchQueryOptions(platform))
    return {
      launchedAtLogin: resolveAutoLaunchInvocation({
        platform,
        wasOpenedAtLogin: Boolean(settings.wasOpenedAtLogin),
        argv
      })
    }
  } catch (error) {
    console.warn('[Electron] Failed to read login launch status', error)
    return { launchedAtLogin: false }
  }
}

export function applyAutoLaunchSettings(openAtLogin: boolean): void {
  const platform = getAutoLaunchPlatform()
  if (platform === 'linux') {
    return
  }
  app.setLoginItemSettings(getAutoLaunchRegistrationSettings(platform, openAtLogin))
}
