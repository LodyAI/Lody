// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectBrowserLanguage } from '../src/i18n';

type GlobalWindow = typeof window & {
  __LODY_ELECTRON__?: true;
  __LODY_PLATFORM__?: {
    os: string;
    homeDir: string;
    preferredSystemLanguages?: readonly string[];
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const w = window as GlobalWindow;
  delete w.__LODY_ELECTRON__;
  delete w.__LODY_PLATFORM__;
});

function setLanguages(languages: string[] | undefined, language?: string) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages ?? []);
  if (language !== undefined) vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
}

describe('detectBrowserLanguage', () => {
  // Regression: an English-primary browser with Chinese as a secondary fallback
  // used to walk past `en-US` (which the old code normalized to `en_US` — not a
  // supported key) and incorrectly resolve to `zh_CN`. The fix matches the BCP-47
  // base subtag, so the first supported base wins.
  it('prefers the primary base subtag over later fallbacks', () => {
    setLanguages(['en-US', 'zh-CN'], 'en-US');
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('treats any Chinese variant as zh_CN', () => {
    setLanguages(['zh-Hant-HK'], 'zh-Hant-HK');
    expect(detectBrowserLanguage()).toBe('zh_CN');

    setLanguages(['zh'], 'zh');
    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it.each([
    ['macOS', 'darwin', 'zh-Hans-CN'],
    ['Windows', 'win32', 'zh-CN'],
    ['Linux', 'linux', 'zh_CN'],
  ])('uses the %s system language passed by Electron main', (_label, os, language) => {
    setLanguages(['en-US'], 'en-US');
    const electronWindow = window as GlobalWindow;
    electronWindow.__LODY_ELECTRON__ = true;
    electronWindow.__LODY_PLATFORM__ = {
      os,
      homeDir: '/home/test',
      preferredSystemLanguages: [language, 'en-US'],
    };

    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it('does not fall back to Chromium locale packs when Electron system languages are absent', () => {
    setLanguages(['zh-CN'], 'zh-CN');
    const electronWindow = window as GlobalWindow;
    electronWindow.__LODY_ELECTRON__ = true;
    electronWindow.__LODY_PLATFORM__ = { os: 'linux', homeDir: '/home/test' };

    expect(detectBrowserLanguage()).toBeNull();
  });
});
