const INITIAL_WINDOW_THEME_ARGUMENT_PREFIX = '--lody-initial-window-theme='

export type InitialWindowTheme = 'light' | 'dark'

/**
 * Carries the theme main already resolved for this window into preload.
 *
 * Preload is the only renderer-side code that runs before the document is
 * parsed, and the CSP (`script-src 'self'`) rules out the inline blocking
 * script `next-themes` would otherwise use — so preload is where `.dark` has
 * to land if the first painted frame is to be the right color. It cannot ask
 * main over IPC for it, because that answer arrives asynchronously, after the
 * frame it was needed for. A launch argument is already resolved by the time
 * preload's first line runs.
 *
 * It is fixed for the window's lifetime, so a RELOAD that follows an in-session
 * theme change replays the theme the window opened on for one frame before the
 * renderer corrects it. That is strictly better than the previous behavior (the
 * OS appearance, on every load), and keeping it an argument avoids a
 * synchronous main-process round trip on the renderer's very first line.
 */
export function serializeInitialWindowThemeArgument(theme: InitialWindowTheme): string {
  return `${INITIAL_WINDOW_THEME_ARGUMENT_PREFIX}${theme}`
}

export function readInitialWindowThemeArgument(argv: readonly string[]): InitialWindowTheme | null {
  const argument = argv.find((value) => value.startsWith(INITIAL_WINDOW_THEME_ARGUMENT_PREFIX))
  if (!argument) {
    return null
  }

  const value = argument.slice(INITIAL_WINDOW_THEME_ARGUMENT_PREFIX.length)
  return value === 'light' || value === 'dark' ? value : null
}
