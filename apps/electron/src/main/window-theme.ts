export type ResolvedWindowTheme = 'light' | 'dark'
export type NativeWindowThemeSource = ResolvedWindowTheme | 'system'

export function isNativeWindowThemeSource(value: unknown): value is NativeWindowThemeSource {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * The `nativeTheme.themeSource` a freshly created window starts from.
 *
 * Onboarding is pinned to Light before its first renderer paint. Every other
 * window follows the theme the renderer last committed (mirrored into the main
 * process by `theme-settings.ts`), because the window's background color and
 * caption overlay are chosen here, long before React can apply the user's
 * choice. `system` stays the fallback for a first launch, where nothing has
 * been committed yet.
 */
export function getInitialMainWindowThemeSource(
  initialPath: '/' | '/onboarding' = '/',
  storedThemeSource: NativeWindowThemeSource | null = null
): NativeWindowThemeSource {
  if (initialPath === '/onboarding') {
    return 'light'
  }
  return storedThemeSource ?? 'system'
}

const WINDOW_BACKGROUND_COLORS: Record<ResolvedWindowTheme, string> = {
  light: '#FFFFFF',
  dark: '#101010'
}

export const MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT = 36

// Matches the bundled VS Code themes' `titleBar.*` colors
// (`lody-light.json` / `Vesper-dark-color-theme.json`) so the OS-drawn
// caption buttons sit on the same canvas as the rest of the window.
const TITLE_BAR_OVERLAY_COLORS: Record<
  ResolvedWindowTheme,
  { color: string; symbolColor: string }
> = {
  light: { color: '#FFFFFF', symbolColor: '#3C4048' },
  dark: { color: '#101010', symbolColor: '#7E7E7E' }
}

export function getMainWindowBackgroundColor(theme: ResolvedWindowTheme): string {
  return WINDOW_BACKGROUND_COLORS[theme]
}

export function getMainWindowTitleBarOverlay(theme: ResolvedWindowTheme): {
  color: string
  symbolColor: string
  height: number
} {
  return {
    ...TITLE_BAR_OVERLAY_COLORS[theme],
    height: MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT
  }
}

export function resolveNativeWindowTheme(shouldUseDarkColors: boolean): ResolvedWindowTheme {
  return shouldUseDarkColors ? 'dark' : 'light'
}

export type NativeWindowAppearanceTarget = {
  setBackgroundColor: (color: string) => void
  setTitleBarOverlay?: (overlay: { color: string; symbolColor: string; height: number }) => void
}

export function applyResolvedWindowTheme(
  window: NativeWindowAppearanceTarget,
  theme: ResolvedWindowTheme,
  platform: NodeJS.Platform
): void {
  window.setBackgroundColor(getMainWindowBackgroundColor(theme))
  if (platform === 'win32') {
    window.setTitleBarOverlay?.(getMainWindowTitleBarOverlay(theme))
  }
}
