// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  ThemeProvider,
  nextCycledTheme,
  useActiveVSCodeThemeId,
  useResolvedTheme,
  useTheme,
} from '../src/theme-provider';
import {
  applyVSCodeThemeCssVariables,
  createThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
} from '../src/lib/vscode-theme';

// The app now ships exactly two themes, pinned by the provider.
const FIXED_LIGHT_THEME_ID = 'lody-light';
const FIXED_DARK_THEME_ID = 'vesper';

function ThemeProbe() {
  const { theme, previewTheme, setTheme } = useTheme();
  const resolvedTheme = useResolvedTheme();
  const activeVSCodeThemeId = useActiveVSCodeThemeId();

  return React.createElement(
    'div',
    {
      id: 'theme-probe',
      'data-theme': theme,
      'data-resolved-theme': resolvedTheme,
      'data-active-vscode-theme-id': activeVSCodeThemeId ?? '',
    },
    React.createElement('button', { id: 'set-dark-theme', onClick: () => setTheme('dark') }),
    React.createElement('button', { id: 'set-light-theme', onClick: () => setTheme('light') }),
    React.createElement('button', { id: 'set-system-theme', onClick: () => setTheme('system') }),
    React.createElement('button', { id: 'preview-dark-theme', onClick: () => previewTheme('dark') })
  );
}

const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');

type MediaQueryChangeListener = (this: MediaQueryList, event: MediaQueryListEvent) => void;

function installMatchMediaMock(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<MediaQueryChangeListener>();
  const legacyListeners = new Set<MediaQueryChangeListener>();

  const mediaQueryList = {
    media: COLOR_SCHEME_QUERY,
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener: (eventName: string, listener: EventListenerOrEventListenerObject | null) => {
      if (eventName === 'change' && typeof listener === 'function') {
        listeners.add(listener as MediaQueryChangeListener);
      }
    },
    removeEventListener: (
      eventName: string,
      listener: EventListenerOrEventListenerObject | null
    ) => {
      if (eventName === 'change' && typeof listener === 'function') {
        listeners.delete(listener as MediaQueryChangeListener);
      }
    },
    addListener: (listener: MediaQueryChangeListener | null) => {
      if (listener) {
        legacyListeners.add(listener);
      }
    },
    removeListener: (listener: MediaQueryChangeListener | null) => {
      if (listener) {
        legacyListeners.delete(listener);
      }
    },
    dispatchEvent: () => true,
  } as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== COLOR_SCHEME_QUERY) {
        throw new Error(`Unexpected matchMedia query: ${query}`);
      }
      return mediaQueryList;
    },
  });

  return {
    setMatches(nextMatches: boolean, notify = true) {
      if (matches === nextMatches) {
        return;
      }

      matches = nextMatches;
      if (!notify) {
        return;
      }
      const event = { matches, media: COLOR_SCHEME_QUERY } as MediaQueryListEvent;

      for (const listener of listeners) {
        listener.call(mediaQueryList, event);
      }
      for (const listener of legacyListeners) {
        listener.call(mediaQueryList, event);
      }
      if (typeof mediaQueryList.onchange === 'function') {
        mediaQueryList.onchange.call(mediaQueryList, event);
      }
    },
  };
}

describe('nextCycledTheme', () => {
  it('cycles light, dark, then system', () => {
    expect(nextCycledTheme('light')).toBe('dark');
    expect(nextCycledTheme('dark')).toBe('system');
    expect(nextCycledTheme('system')).toBe('light');
  });
});

describe('ThemeProvider', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.lodyVscodeTheme;
    document.documentElement.classList.remove('light', 'dark');
    Reflect.deleteProperty(window, 'ipc');
    if (originalMatchMediaDescriptor) {
      Object.defineProperty(window, 'matchMedia', originalMatchMediaDescriptor);
    } else {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('applies bundled VSCode theme variables during the initial mount commit', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'dark',
            storageKey: 'theme-provider-test-theme',
          },
          React.createElement('div', null, 'theme probe')
        )
      );
    });

    // Dark mode pins Vesper.
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_DARK_THEME_ID);
    expect(document.documentElement.style.getPropertyValue('--vscode-editor-background')).toBe(
      '#101010'
    );
    expect(document.documentElement.style.getPropertyValue('--vscode-button-background')).toBe(
      '#FFC799'
    );
  });

  it('replaces previously applied theme variables even if the old application is not explicitly disposed', () => {
    const documentRoot = document.documentElement;
    const darkTheme = getBundledVSCodeThemeByIdSync('vesper');
    const lightTheme = getBundledVSCodeThemeByIdSync('vscode-light-2026');

    if (!darkTheme || !lightTheme) {
      throw new Error('Expected bundled themes to be available');
    }

    const firstApplication = applyVSCodeThemeCssVariables(documentRoot, darkTheme);
    expect(documentRoot.style.getPropertyValue('--vscode-button-background')).toBe('#FFC799');

    const secondApplication = applyVSCodeThemeCssVariables(documentRoot, lightTheme);
    const lightButtonBackground = createThemeCssVariables(lightTheme)['--vscode-button-background'];
    expect(documentRoot.dataset.lodyVscodeTheme).toBe('vscode-light-2026');
    expect(documentRoot.style.getPropertyValue('--vscode-button-background')).toBe(
      lightButtonBackground
    );

    firstApplication.dispose();
    expect(documentRoot.dataset.lodyVscodeTheme).toBe('vscode-light-2026');
    expect(documentRoot.style.getPropertyValue('--vscode-button-background')).toBe(
      lightButtonBackground
    );

    secondApplication.dispose();
    expect(documentRoot.dataset.lodyVscodeTheme).toBeUndefined();
    expect(documentRoot.style.getPropertyValue('--vscode-button-background')).toBe('');
  });

  it('pins the fixed VS Code theme per mode and persists the explicit mode', () => {
    const themeStorageKey = 'theme-provider-test-theme';

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'light',
            storageKey: themeStorageKey,
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const probe = container.querySelector<HTMLElement>('#theme-probe');
    const setDarkThemeButton = container.querySelector<HTMLButtonElement>('#set-dark-theme');
    const setLightThemeButton = container.querySelector<HTMLButtonElement>('#set-light-theme');
    const setSystemThemeButton = container.querySelector<HTMLButtonElement>('#set-system-theme');

    // Light mode pins Lody Light.
    expect(probe?.dataset.theme).toBe('light');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_LIGHT_THEME_ID);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_LIGHT_THEME_ID);

    flushSync(() => {
      setDarkThemeButton?.click();
    });

    // Dark mode pins Vesper.
    expect(window.localStorage.getItem(themeStorageKey)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(probe?.dataset.theme).toBe('dark');
    expect(probe?.dataset.resolvedTheme).toBe('dark');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_DARK_THEME_ID);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_DARK_THEME_ID);

    flushSync(() => {
      setLightThemeButton?.click();
    });

    expect(window.localStorage.getItem(themeStorageKey)).toBe('light');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_LIGHT_THEME_ID);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_LIGHT_THEME_ID);

    flushSync(() => {
      setSystemThemeButton?.click();
    });

    expect(window.localStorage.getItem(themeStorageKey)).toBe('system');
    expect(probe?.dataset.theme).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light dark');
  });

  it('reacts to storage events for the theme mode', () => {
    const themeStorageKey = 'theme-provider-test-theme';

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'dark',
            storageKey: themeStorageKey,
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const probe = container.querySelector<HTMLElement>('#theme-probe');

    expect(probe?.dataset.theme).toBe('dark');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_DARK_THEME_ID);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_DARK_THEME_ID);

    flushSync(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: themeStorageKey,
          newValue: 'light',
        })
      );
    });

    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(probe?.dataset.theme).toBe('light');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_LIGHT_THEME_ID);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_LIGHT_THEME_ID);
  });

  it('follows system color scheme changes while theme mode is system', () => {
    const matchMediaMock = installMatchMediaMock(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'system',
            storageKey: 'theme-provider-test-theme',
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const probe = container.querySelector<HTMLElement>('#theme-probe');

    expect(probe?.dataset.theme).toBe('system');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_LIGHT_THEME_ID);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light dark');
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_LIGHT_THEME_ID);

    flushSync(() => {
      matchMediaMock.setMatches(true);
    });

    expect(probe?.dataset.theme).toBe('system');
    expect(probe?.dataset.resolvedTheme).toBe('dark');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_DARK_THEME_ID);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_DARK_THEME_ID);

    flushSync(() => {
      matchMediaMock.setMatches(false);
    });

    expect(probe?.dataset.theme).toBe('system');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(probe?.dataset.activeVscodeThemeId).toBe(FIXED_LIGHT_THEME_ID);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.dataset.lodyVscodeTheme).toBe(FIXED_LIGHT_THEME_ID);
  });

  it('previews a theme without persisting it', () => {
    const themeStorageKey = 'theme-provider-test-theme';
    window.localStorage.setItem(themeStorageKey, 'light');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'light',
            storageKey: themeStorageKey,
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const probe = container.querySelector<HTMLElement>('#theme-probe');
    const previewDarkButton = container.querySelector<HTMLButtonElement>('#preview-dark-theme');
    expect(probe?.dataset.resolvedTheme).toBe('light');

    flushSync(() => {
      previewDarkButton?.click();
    });

    expect(probe?.dataset.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(themeStorageKey)).toBe('light');
  });

  it('mirrors the committed theme into the Electron main process, but never a preview', () => {
    installMatchMediaMock(false);
    const invokeCalls: Array<{ channel: string; args: unknown[] }> = [];
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: async (channel: string, ...args: unknown[]) => {
          invokeCalls.push({ channel, args });
          return undefined;
        },
        on: () => () => {},
        send: () => {},
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'light',
            storageKey: 'theme-provider-test-theme',
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const startupCalls = () =>
      invokeCalls
        .filter((call) => call.channel === 'app.setStartupThemeSource')
        .map((call) => call.args[0]);

    // The window background and the pre-paint class for the NEXT launch come
    // from this value, so the first mount has to publish it too.
    expect(startupCalls()).toEqual(['light']);

    invokeCalls.length = 0;
    flushSync(() => {
      container?.querySelector<HTMLButtonElement>('#preview-dark-theme')?.click();
    });

    // A preview retints the live native chrome but says nothing about how the
    // app should open, so it must not reach the persisted startup theme.
    expect(
      invokeCalls.filter((call) => call.channel === 'app.setNativeTheme').map((call) => call.args[0])
    ).toEqual(['dark']);
    expect(startupCalls()).toEqual([]);

    flushSync(() => {
      container?.querySelector<HTMLButtonElement>('#set-dark-theme')?.click();
    });

    expect(startupCalls()).toEqual(['dark']);
  });

  it('follows Electron native theme updates while theme mode is system', () => {
    installMatchMediaMock(false);
    const nativeThemeHandlers = new Set<(resolved: 'light' | 'dark') => void>();
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: async () => undefined,
        on: (channel: string, listener: (payload: unknown) => void) => {
          if (channel === 'app.nativeTheme') {
            nativeThemeHandlers.add(listener as (resolved: 'light' | 'dark') => void);
            return () => {
              nativeThemeHandlers.delete(listener as (resolved: 'light' | 'dark') => void);
            };
          }
          return () => {};
        },
        send: () => {},
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          {
            defaultTheme: 'system',
            storageKey: 'theme-provider-test-theme',
          },
          React.createElement(ThemeProbe)
        )
      );
    });

    const probe = container.querySelector<HTMLElement>('#theme-probe');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(nativeThemeHandlers.size).toBe(1);

    flushSync(() => {
      for (const handler of nativeThemeHandlers) {
        handler('dark');
      }
    });

    expect(probe?.dataset.theme).toBe('system');
    expect(probe?.dataset.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light dark');
  });
});
