import { app } from 'electron'
import Conf from 'conf'
import { resolveInitialDesktopPath, type InitialDesktopPath } from './onboarding-launch-policy'
import { createSettingsStoreWithFallback } from './settings-store-core'

type OnboardingStateSchema = {
  completed: boolean
}

const normalizedConfModule = Conf as typeof Conf | { default?: typeof Conf }
const ConfConstructor =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default

if (typeof ConfConstructor !== 'function') {
  throw new TypeError('Unable to initialize onboarding state: invalid Conf module export shape.')
}

const onboardingStateStore = createSettingsStoreWithFallback<OnboardingStateSchema>(
  () =>
    new ConfConstructor<OnboardingStateSchema>({
      cwd: app.getPath('userData'),
      configName: 'onboarding-state',
      defaults: { completed: false },
      schema: {
        completed: { type: 'boolean' }
      }
    }),
  { configName: 'onboarding-state', defaults: { completed: false } }
)

export function getInitialDesktopPath(): InitialDesktopPath {
  return resolveInitialDesktopPath({
    isPackaged: app.isPackaged,
    onboardingCompleted: onboardingStateStore.get('completed'),
    forceOnboarding: process.env['LODY_ELECTRON_FORCE_ONBOARDING'] === '1'
  })
}

export function markOnboardingCompleted(): void {
  onboardingStateStore.set('completed', true)
}
