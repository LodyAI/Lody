const INITIAL_WINDOW_THEME_ARGUMENT_PREFIX = '--lody-initial-window-theme='

export type InitialWindowTheme = 'light' | 'dark'

/**
 * Carries the theme main already resolved for this window into preload.
 *
 * Preload is where `.dark` has to land for the first frame to be the right
 * color, and it cannot ask main over IPC because that answer arrives after the
 * frame it was needed for. A launch argument is already resolved by the time
 * preload's first line runs.
 *
 * It is fixed for the window's lifetime, so a RELOAD after an in-session theme
 * change replays the opening theme for one frame. Still better than the old
 * behavior (the OS appearance, every load), and it avoids a synchronous
 * main-process round trip on the renderer's very first line.
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
