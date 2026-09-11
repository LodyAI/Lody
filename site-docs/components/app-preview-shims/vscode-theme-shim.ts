// Preview shim for `@/lib/vscode-theme`.
// The real barrel pulls bundled VS Code theme JSON via Vite `?raw` imports and shiki,
// which the public-site preview does not need. Only terminal-component and
// theme-provider and share-theme-scope consume it, and the preview renders no
// code/terminal/share-image blocks, so no-op theme helpers suffice. theme-provider's
// relative import is redirected to this `@/` path so the alias can intercept it.
export type VSCodeTerminalTheme = Record<string, unknown>;
export type LodyResolvedVSCodeTheme = Record<string, unknown>;
export type VSCodeThemeMode = 'light' | 'dark';
export type VSCodeThemeSelection = {
  lightThemeId?: string;
  darkThemeId?: string;
};

export const DEFAULT_VSCODE_THEME_SELECTION: VSCodeThemeSelection = {
  lightThemeId: 'lody-light',
  darkThemeId: 'vesper',
};

// Real value from lib/vscode-theme/vscode-theme-shiki.ts — a @pierre/diffs theme
// object the real DiffViewer passes to <FileDiff> as its fallback theme; @pierre
// resolves these bundled theme names on the main-thread highlighter.
export const DEFAULT_VSCODE_DIFF_THEME_FALLBACK = {
  dark: 'github-dark-default',
  light: 'pierre-light',
} as const;

export const createVSCodeTerminalTheme = (..._args: unknown[]): VSCodeTerminalTheme => ({});
export const createThemeCssVariables = (..._args: unknown[]): Record<string, string> => ({});
export const resolveAnsiColorToCss = (..._args: unknown[]): string => '';
export const applyVSCodeThemeCssVariables = (..._args: unknown[]): void => {};
export const compactThemeSelection = (selection: unknown): unknown => selection;
export const createLodyVSCodeShikiThemeName = (..._args: unknown[]): string => 'lody';
export const getBundledVSCodeThemeByIdSync = (..._args: unknown[]): undefined => undefined;
export const getCachedBundledVSCodeThemes = (..._args: unknown[]): readonly unknown[] | undefined =>
  undefined;
export const getRegisteredLodyVSCodeThemeForDiffs = (..._args: unknown[]): undefined => undefined;
export const isSelectableBundledVSCodeThemeId = (themeId: string): boolean =>
  themeId === 'lody-light' || themeId === 'vesper';
export const parseThemeSelectionStorage = (..._args: unknown[]): VSCodeThemeSelection => ({
  ...DEFAULT_VSCODE_THEME_SELECTION,
});
export const resolveBundledVSCodeThemes = async (..._args: unknown[]): Promise<unknown[]> => [];
export const registerLodyVSCodeThemeForDiffs = (..._args: unknown[]): void => {};
export const serializeThemeSelectionStorage = (..._args: unknown[]): string => '';
export const updateThemeSelection = (selection: unknown): unknown => selection;
