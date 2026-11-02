import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import {
  applyVSCodeThemeCssVariables,
  createLodyVSCodeShikiThemeName,
  getBundledVSCodeThemeByIdSync,
  registerLodyVSCodeThemeForDiffs,
  resolveBundledVSCodeThemesSync,
  type LodyResolvedVSCodeTheme,
} from '@lody/components/lib/vscode-theme';

type CodeReviewThemeContextValue = {
  readonly activeTheme: LodyResolvedVSCodeTheme | undefined;
  readonly diffThemeName: string;
};

const CodeReviewThemeContext = createContext<CodeReviewThemeContextValue | null>(null);

const DEFAULT_DARK_THEME_ID = 'vesper';
const FALLBACK_DIFF_THEME_NAME = 'pierre-dark';

/**
 * Resolves and applies a bundled VSCode theme (Vesper by default) to the
 * document root, and registers matching TextMate and Zed themes for @pierre/diffs.
 *
 * This mirrors the `@lody/components` VSCode theme adaptation so the review
 * helper looks consistent with the rest of Lody when running standalone.
 */
export function CodeReviewThemeProvider({ children }: { readonly children: ReactNode }) {
  const theme = useMemo(() => {
    resolveBundledVSCodeThemesSync();
    return getBundledVSCodeThemeByIdSync(DEFAULT_DARK_THEME_ID);
  }, []);

  useLayoutEffect(() => {
    if (!theme) {
      return undefined;
    }

    const application = applyVSCodeThemeCssVariables(document.documentElement, theme);
    let cancelled = false;

    void registerLodyVSCodeThemeForDiffs(theme).catch((error: unknown) => {
      if (!cancelled) {
        console.warn('[code-review-helper] Failed to register VSCode theme for diffs', error);
      }
    });

    return () => {
      cancelled = true;
      application.dispose();
    };
  }, [theme]);

  const value = useMemo<CodeReviewThemeContextValue>(
    () => ({
      activeTheme: theme,
      diffThemeName: theme ? createLodyVSCodeShikiThemeName(theme) : FALLBACK_DIFF_THEME_NAME,
    }),
    [theme]
  );

  return (
    <CodeReviewThemeContext.Provider value={value}>{children}</CodeReviewThemeContext.Provider>
  );
}

export function useCodeReviewTheme(): CodeReviewThemeContextValue {
  const context = useContext(CodeReviewThemeContext);
  if (!context) {
    return {
      activeTheme: undefined,
      diffThemeName: FALLBACK_DIFF_THEME_NAME,
    };
  }
  return context;
}
