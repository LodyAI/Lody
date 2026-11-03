// @vitest-environment jsdom

// @vitest-environment jsdom
// @vitest-environment jsdom
// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  ThemeProvider,
  useActiveVSCodeThemeId,
  useResolvedTheme,
  useTheme,
} from '../src/theme-provider';

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
    delete window.__LODY_STARTUP_THEME__;
    if (originalMatchMediaDescriptor) {
      Object.defineProperty(window, 'matchMedia', originalMatchMediaDescriptor);
    } else {
      Reflect.deleteProperty(window, 'matchMedia');
    }
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

  it('mirrors a committed theme into the Electron main process, but never a preview', () => {
    installMatchMediaMock(false);
    const startupSources: unknown[] = [];
    const nativeStartupSources: unknown[] = [];
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: async (channel: string, source: unknown) => {
          if (channel === 'app.setStartupThemeSource') startupSources.push(source);
        },
        on: () => () => {},
        send: () => {},
      },
    });
    window.__LODY_STARTUP_THEME__ = {
      persist: async (theme) => {
        nativeStartupSources.push(theme);
      },
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          ThemeProvider,
          { defaultTheme: 'light', storageKey: 'theme-provider-test-theme' },
          React.createElement(ThemeProbe)
        )
      );
    });
    expect(startupSources).toEqual(['light']);
    expect(nativeStartupSources).toEqual(['light']);

    // A preview retints live native chrome but says nothing about how the app
    // should open, so it must not reach either persisted startup theme.
    flushSync(() => {
      container?.querySelector<HTMLButtonElement>('#preview-dark-theme')?.click();
    });
    expect(startupSources).toEqual(['light']);
    expect(nativeStartupSources).toEqual(['light']);

    flushSync(() => {
      container?.querySelector<HTMLButtonElement>('#set-dark-theme')?.click();
    });
    expect(startupSources).toEqual(['light', 'dark']);
    expect(nativeStartupSources).toEqual(['light', 'dark']);
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
