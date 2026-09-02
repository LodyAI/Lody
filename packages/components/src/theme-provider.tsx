import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from 'next-themes';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import {
  DEFAULT_VSCODE_THEME_SELECTION,
  applyVSCodeThemeCssVariables,
  createLodyVSCodeShikiThemeName,
  getBundledVSCodeThemeByIdSync,
  getCachedBundledVSCodeThemes,
  getRegisteredLodyVSCodeThemeForDiffs,
  isSelectableBundledVSCodeThemeId,
  resolveBundledVSCodeThemes,
  registerLodyVSCodeThemeForDiffs,
  type LodyResolvedVSCodeTheme,
} from '@/lib/vscode-theme';

import { forcedThemeClassNames } from '@lody/ui/theme';

export type Theme = 'dark' | 'light' | 'system';

const FORCED_STYLEX_CLASSES = [...forcedThemeClassNames('light'), ...forcedThemeClassNames('dark')];
export type ResolvedTheme = 'light' | 'dark';

export const THEME_CYCLE_ORDER: readonly Theme[] = ['light', 'dark', 'system'];

export function nextCycledTheme(current: Theme): Theme {
  const index = THEME_CYCLE_ORDER.indexOf(current);
  return THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length];
}

/**
 * The app ships exactly two palettes: Lody Light (cool white) and Vesper
 * (dark). Users pick light, dark, or system (follow the OS). The underlying
 * VS Code theme selection is FIXED — there is no per-mode theme picker or
 * persistence. The bundled VS Code theme machinery stays only to drive syntax
 * colors for the editor/diff/terminal at these two ids.
 */
const FIXED_VSCODE_THEME_SELECTION = DEFAULT_VSCODE_THEME_SELECTION;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Apply theme visually without persisting to localStorage. */
  previewTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => null,
  previewTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function parseStoredTheme(value: string | null): Theme | null {
  if (value === 'dark' || value === 'light' || value === 'system') {
    return value;
  }
  return null;
}

const getActiveVSCodeThemeId = (resolvedTheme: ResolvedTheme): string | undefined => {
  return resolvedTheme === 'dark'
    ? FIXED_VSCODE_THEME_SELECTION.darkThemeId
    : FIXED_VSCODE_THEME_SELECTION.lightThemeId;
};

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'vite-ui-theme',
}: ThemeProviderProps) {
  const [previewedTheme, setPreviewedTheme] = useState<Theme>();
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme={defaultTheme}
      enableColorScheme={false}
      enableSystem
      forcedTheme={previewedTheme}
      storageKey={storageKey}
      themes={['light', 'dark']}
      // Electron's CSP intentionally rejects inline scripts. Its native-theme
      // bridge supplies the initial resolved theme immediately after mount.
      scriptProps={isElectron ? { type: 'application/json' } : undefined}
    >
      <LodyThemeProvider
        defaultTheme={defaultTheme}
        previewedTheme={previewedTheme}
        setPreviewedTheme={setPreviewedTheme}
      >
        {children}
      </LodyThemeProvider>
    </NextThemesProvider>
  );
}

type LodyThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme: Theme;
  previewedTheme: Theme | undefined;
  setPreviewedTheme: (theme: Theme | undefined) => void;
};

function LodyThemeProvider({
  children,
  defaultTheme,
  previewedTheme,
  setPreviewedTheme,
}: LodyThemeProviderProps) {
  const {
    theme: storedThemeValue,
    systemTheme: browserSystemTheme,
    setTheme: setStoredTheme,
  } = useNextTheme();
  const storedTheme = parseStoredTheme(storedThemeValue ?? null) ?? defaultTheme;
  const theme = previewedTheme ?? storedTheme;
  const [nativeSystemTheme, setNativeSystemTheme] = useState<ResolvedTheme>();

  const browserResolvedTheme: ResolvedTheme = browserSystemTheme === 'dark' ? 'dark' : 'light';
  const resolvedTheme = theme === 'system' ? (nativeSystemTheme ?? browserResolvedTheme) : theme;

  useEffect(() => {
    return onIpcEvent('app.nativeTheme', (resolved) => {
      setNativeSystemTheme(resolved);
    });
  }, []);

  useIsomorphicLayoutEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark', ...FORCED_STYLEX_CLASSES);
    root.classList.add(resolvedTheme);
    if (theme !== 'system') root.classList.add(...forcedThemeClassNames(resolvedTheme));
    root.style.colorScheme = theme === 'system' ? 'light dark' : resolvedTheme;
  }, [resolvedTheme, theme]);

  // On Electron, keep the OS-drawn window chrome (notably the Windows title bar)
  // matching the in-app theme. Preserve `system` as the native source.
  useEffect(() => {
    void getIpcServices()?.app.setNativeTheme(theme);
  }, [theme]);

  useIsomorphicLayoutEffect(() => {
    const root = window.document.documentElement;
    const activeThemeId = getActiveVSCodeThemeId(resolvedTheme);
    if (!activeThemeId) {
      return undefined;
    }

    const activeTheme = getBundledVSCodeThemeByIdSync(activeThemeId);
    if (!activeTheme) {
      return undefined;
    }
    const application = applyVSCodeThemeCssVariables(root, activeTheme);

    return () => {
      application.dispose();
    };
  }, [resolvedTheme]);

  const setTheme = useCallback(
    (nextTheme: Theme) => {
      setPreviewedTheme(undefined);
      setStoredTheme(nextTheme);
    },
    [setPreviewedTheme, setStoredTheme]
  );
  const previewTheme = useCallback(
    (nextTheme: Theme) => {
      setPreviewedTheme(nextTheme);
    },
    [setPreviewedTheme]
  );

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      previewTheme,
    }),
    [previewTheme, resolvedTheme, setTheme, theme]
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => useContext(ThemeProviderContext);

export const useResolvedTheme = (): ResolvedTheme => {
  return useTheme().resolvedTheme;
};

export const useActiveVSCodeThemeId = (): string | undefined => {
  const resolvedTheme = useResolvedTheme();
  return getActiveVSCodeThemeId(resolvedTheme);
};

export const useActiveVSCodeTheme = (): LodyResolvedVSCodeTheme | undefined => {
  const activeThemeId = useActiveVSCodeThemeId();
  return useMemo(
    () => (activeThemeId ? getBundledVSCodeThemeByIdSync(activeThemeId) : undefined),
    [activeThemeId]
  );
};

export const useBundledVSCodeThemes = (): LodyResolvedVSCodeTheme[] => {
  const [loaded, setLoaded] = useState(() => getCachedBundledVSCodeThemes() !== undefined);
  const [themes, setThemes] = useState<LodyResolvedVSCodeTheme[]>(() => [
    ...(getCachedBundledVSCodeThemes() ?? []),
  ]);

  useEffect(() => {
    if (loaded) {
      return undefined;
    }

    let cancelled = false;

    void resolveBundledVSCodeThemes()
      .then((bundledThemes) => {
        if (!cancelled) {
          setThemes(bundledThemes);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        console.warn('[vscode-theme] Failed to load bundled themes', error);
        if (!cancelled) {
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loaded]);

  return themes;
};

export const useSelectableBundledVSCodeThemes = (): LodyResolvedVSCodeTheme[] => {
  const themes = useBundledVSCodeThemes();
  return useMemo(
    () => themes.filter((theme) => isSelectableBundledVSCodeThemeId(theme.id)),
    [themes]
  );
};

export const useActiveVSCodeDiffThemeName = (): string | undefined => {
  const activeTheme = useActiveVSCodeTheme();
  const activeDiffThemeName = activeTheme ? createLodyVSCodeShikiThemeName(activeTheme) : undefined;
  const [registeredDiffThemeName, setRegisteredDiffThemeName] = useState<string | undefined>(() =>
    activeTheme ? getRegisteredLodyVSCodeThemeForDiffs(activeTheme) : undefined
  );

  useIsomorphicLayoutEffect(() => {
    if (!activeTheme) {
      setRegisteredDiffThemeName(undefined);
      return undefined;
    }

    const registeredName = getRegisteredLodyVSCodeThemeForDiffs(activeTheme);
    setRegisteredDiffThemeName(registeredName);
    if (registeredName) {
      return undefined;
    }

    let cancelled = false;
    void registerLodyVSCodeThemeForDiffs(activeTheme).then((name) => {
      if (!cancelled) {
        setRegisteredDiffThemeName(name);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeTheme]);

  const cachedRegisteredName = activeTheme
    ? getRegisteredLodyVSCodeThemeForDiffs(activeTheme)
    : undefined;
  return (
    cachedRegisteredName ??
    (registeredDiffThemeName === activeDiffThemeName ? registeredDiffThemeName : undefined)
  );
};
