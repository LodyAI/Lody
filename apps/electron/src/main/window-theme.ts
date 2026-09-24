export type ResolvedWindowTheme = 'light' | 'dark'
export type NativeWindowThemeSource = ResolvedWindowTheme | 'system'

export function getInitialMainWindowThemeSource(
  initialPath: '/' | '/onboarding' = '/'
): NativeWindowThemeSource {
  return initialPath === '/onboarding' ? 'light' : 'system'
}

const WINDOW_BACKGROUND_COLORS: Record<ResolvedWindowTheme, string> = {
  light: '#FFFFFF',
  dark: '#141413'
}

export const MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT = 36

// Matches the bundled VS Code themes' `titleBar.*` colors
// (`lody-light.json` / Vesper after Lody's warm palette,
// `vesper-warm-palette.ts`) so the OS-drawn
// caption buttons sit on the same canvas as the rest of the window.
const TITLE_BAR_OVERLAY_COLORS: Record<
  ResolvedWindowTheme,
  { color: string; symbolColor: string }
> = {
  light: { color: '#FFFFFF', symbolColor: '#3C4048' },
  dark: { color: '#141413', symbolColor: '#7E7B76' }
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
