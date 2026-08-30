export const BACKGROUND_AUTO_LAUNCH_ARG = '--lody-start-in-background'

export function shouldStartMainWindowInBackground(input: {
  preferenceEnabled: boolean
  wasOpenedAtLogin: boolean
  wasOpenedAsHidden: boolean
  argv: readonly string[]
  initialPath: '/' | '/onboarding'
  hasInitialDeepLink: boolean
}): boolean {
  if (!input.preferenceEnabled || input.initialPath !== '/' || input.hasInitialDeepLink) {
    return false
  }

  return (
    input.wasOpenedAtLogin ||
    input.wasOpenedAsHidden ||
    input.argv.includes(BACKGROUND_AUTO_LAUNCH_ARG)
  )
}
