import { app } from 'electron'
import Conf from 'conf'
import { BACKGROUND_AUTO_LAUNCH_ARG } from './auto-launch-policy'

type AutoLaunchSettingsSchema = {
  startInBackground: boolean
}

const normalizedConfModule = Conf as typeof Conf | { default?: typeof Conf }
const resolvedConf =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default

if (typeof resolvedConf !== 'function') {
  throw new TypeError(
    'Unable to initialize auto-launch settings: invalid Conf module export shape.'
  )
}

const ConfConstructor: typeof Conf = resolvedConf
const autoLaunchSettingsStore = new ConfConstructor<AutoLaunchSettingsSchema>({
  cwd: app.getPath('userData'),
  configName: 'auto-launch-settings',
  defaults: { startInBackground: false },
  schema: {
    startInBackground: { type: 'boolean' }
  }
})

export function getStartInBackgroundEnabled(): boolean {
  return autoLaunchSettingsStore.get('startInBackground')
}

export function setStartInBackgroundEnabled(enabled: boolean): void {
  autoLaunchSettingsStore.set('startInBackground', enabled)
}

export function getAutoLaunchInvocationStatus(): {
  wasOpenedAtLogin: boolean
  wasOpenedAsHidden: boolean
} {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { wasOpenedAtLogin: false, wasOpenedAsHidden: false }
  }

  try {
    const settings = app.getLoginItemSettings()
    return {
      wasOpenedAtLogin: Boolean(settings.wasOpenedAtLogin),
      wasOpenedAsHidden: Boolean(settings.wasOpenedAsHidden)
    }
  } catch (error) {
    console.warn('[Electron] Failed to read login launch status', error)
    return { wasOpenedAtLogin: false, wasOpenedAsHidden: false }
  }
}

export function applyAutoLaunchSettings(openAtLogin: boolean, startInBackground: boolean): void {
  const shouldStartInBackground = openAtLogin && startInBackground
  app.setLoginItemSettings({
    openAtLogin,
    ...(process.platform === 'darwin' ? { openAsHidden: shouldStartInBackground } : {}),
    ...(process.platform === 'win32'
      ? { args: shouldStartInBackground ? [BACKGROUND_AUTO_LAUNCH_ARG] : [] }
      : {})
  })
}
