export const AUTO_LAUNCH_ARG = '--lody-auto-launch'

export type AutoLaunchPlatform = 'darwin' | 'win32' | 'linux'

export function getAutoLaunchQueryOptions(platform: AutoLaunchPlatform): {
  type?: 'mainAppService'
  args?: string[]
} {
  if (platform === 'darwin') {
    return { type: 'mainAppService' }
  }
  if (platform === 'win32') {
    return { args: [AUTO_LAUNCH_ARG] }
  }
  return {}
}

export function getAutoLaunchRegistrationSettings(
  platform: AutoLaunchPlatform,
  openAtLogin: boolean
): {
  openAtLogin: boolean
  type?: 'mainAppService'
  args?: string[]
} {
  return {
    openAtLogin,
    ...getAutoLaunchQueryOptions(platform)
  }
}

export function resolveAutoLaunchEnabled(
  platform: AutoLaunchPlatform,
  settings: { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean }
): boolean {
  return (
    settings.openAtLogin || (platform === 'win32' && Boolean(settings.executableWillLaunchAtLogin))
  )
}

export function resolveAutoLaunchInvocation(input: {
  platform: AutoLaunchPlatform
  wasOpenedAtLogin: boolean
  argv: readonly string[]
}): boolean {
  if (input.platform === 'darwin') {
    return input.wasOpenedAtLogin
  }
  return input.platform === 'win32' && input.argv.includes(AUTO_LAUNCH_ARG)
}

export function shouldHideMainWindowOnAutoLaunch(input: {
  preferenceEnabled: boolean
  launchedAtLogin: boolean
  initialPath: '/' | '/onboarding'
  hasInitialDeepLink: boolean
}): boolean {
  if (!input.preferenceEnabled || input.initialPath !== '/' || input.hasInitialDeepLink) {
    return false
  }

  return input.launchedAtLogin
}
