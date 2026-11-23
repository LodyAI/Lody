import { registerPlugin } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { releaseSplashOnTheme } from './startup-theme-core';

/**
 * Startup appearance: the theme the user committed, mirrored to the native
 * shell, and the native splash held up until the WebView has painted in it.
 *
 * The shared `ThemeProvider` applies `.dark`/`.light` on `<html>` before the
 * WebView's own first paint, so inside the WebView there is no flash. The flash
 * lives in what the shell shows BEFORE that: the splash and the WebView's
 * background, which the shell colors from its own storage at launch because
 * the renderer's `localStorage` is unreadable there. This module is the mobile
 * half of the contract that `apps/electron` fulfils over IPC; the bridge type
 * is `LodyStartupThemeBridge` in `@lody/components/theme-provider`.
 */

export type StartupTheme = 'light' | 'dark' | 'system';

type LodyStartupThemePlugin = {
  persist: (options: { theme: StartupTheme }) => Promise<void>;
};

type LodyStartupThemeBridge = {
  persist: (theme: StartupTheme) => Promise<void>;
};

type StartupThemeWindow = Window & {
  __LODY_STARTUP_THEME__?: LodyStartupThemeBridge;
};

const LodyStartupTheme = registerPlugin<LodyStartupThemePlugin>('LodyStartupTheme');

export function initStartupThemeBridge(): void {
  const bridge: LodyStartupThemeBridge = {
    persist: (theme) => LodyStartupTheme.persist({ theme }),
  };
  (window as StartupThemeWindow).__LODY_STARTUP_THEME__ = bridge;
}

const SPLASH_FADE_OUT_MS = 200;

export function hideNativeSplash(): void {
  void SplashScreen.hide({ fadeOutDuration: SPLASH_FADE_OUT_MS }).catch((error: unknown) => {
    console.warn('[startup-theme] Failed to hide the native splash', error);
  });
}

export function initNativeSplashHandoff(): void {
  const root = document.documentElement;
  releaseSplashOnTheme(
    root,
    (onMutation) => {
      const observer = new MutationObserver(onMutation);
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    hideNativeSplash
  );
}
