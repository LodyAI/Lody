// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingThemeLifecycle } from '../src/components/onboarding/use-onboarding-theme-lifecycle';
import { ThemeProvider, useTheme } from '../src/theme-provider';

function ThemeLifecycleProbe() {
  const completeThemeLifecycle = useOnboardingThemeLifecycle();
  const { theme, resolvedTheme } = useTheme();

  return (
    <div data-testid="theme" data-theme={theme} data-resolved-theme={resolvedTheme}>
      <button type="button" onClick={completeThemeLifecycle}>
        Complete
      </button>
    </div>
  );
}

function UnmountableThemeLifecycleProbe() {
  const [mounted, setMounted] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setMounted(false)}>
        Leave onboarding
      </button>
      {mounted ? <ThemeLifecycleProbe /> : null}
    </>
  );
}

describe('desktop onboarding theme lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  const setNativeTheme = vi.fn();
  const setStartupThemeSource = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('vite-ui-theme', 'dark');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: () => true,
      }),
    });
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: async (channel: string, ...args: unknown[]) => {
          if (channel === 'app.setNativeTheme') {
            setNativeTheme(args[0]);
            return;
          }
          if (channel === 'app.setStartupThemeSource') {
            setStartupThemeSource(args[0]);
            return;
          }
          throw new Error(`unexpected invoke ${channel}`);
        },
        on: () => () => {},
        send: () => {},
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.lodyVscodeTheme;
    Reflect.deleteProperty(window, 'ipc');
    Reflect.deleteProperty(window, 'matchMedia');
    vi.clearAllMocks();
  });

  it('forces Light on entry and restores System only when completion is released', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeLifecycleProbe />
        </ThemeProvider>
      );
    });

    const probe = container.querySelector<HTMLElement>('[data-testid="theme"]');
    expect(probe?.dataset.theme).toBe('light');
    expect(probe?.dataset.resolvedTheme).toBe('light');
    expect(localStorage.getItem('vite-ui-theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(setNativeTheme).toHaveBeenLastCalledWith('light');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });

    expect(probe?.dataset.theme).toBe('system');
    expect(probe?.dataset.resolvedTheme).toBe('dark');
    expect(localStorage.getItem('vite-ui-theme')).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(setNativeTheme).toHaveBeenLastCalledWith('system');
    // Onboarding really commits these, so the next launch must open on the
    // restored System source rather than onboarding's forced Light.
    expect(setStartupThemeSource).toHaveBeenLastCalledWith('system');
  });

  it('restores System when the onboarding route unmounts', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <UnmountableThemeLifecycleProbe />
        </ThemeProvider>
      );
    });

    expect(localStorage.getItem('vite-ui-theme')).toBe('light');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });

    expect(localStorage.getItem('vite-ui-theme')).toBe('system');
    expect(setNativeTheme).toHaveBeenLastCalledWith('system');
    expect(setStartupThemeSource).toHaveBeenLastCalledWith('system');
  });
});
