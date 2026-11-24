// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectBrowserLanguage } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GlobalWindow = typeof window & {
  __LODY_ELECTRON__?: true;
  __LODY_PLATFORM__?: {
    os: string;
    homeDir: string;
    preferredSystemLanguages?: readonly string[];
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  const w = window as GlobalWindow;
  delete w.__LODY_ELECTRON__;
  delete w.__LODY_PLATFORM__;
});

function setLanguages(languages: string[] | undefined, language?: string) {
  // jsdom provides navigator.language by default; replace it per test.
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    value: languages,
  });
  if (language !== undefined) {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: language,
    });
  }
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

describe('i18n synchronous bootstrap', () => {
  it('registers react-i18next before async locale loading so components mounted immediately survive re-render', async () => {
    setLanguages(['zh-CN'], 'zh-CN');
    vi.resetModules();

    const [
      { act: freshAct, createElement: h, useState: freshUseState },
      { createRoot: freshRoot },
    ] = await Promise.all([import('react'), import('react-dom/client')]);
    const { getI18n, useTranslation } = await import('react-i18next');
    const { initI18n } = await import('../src/i18n');

    // Immediately after importing ../src/i18n — before awaiting initI18n or
    // zh_CN.json — react-i18next must already have an initialized instance.
    expect(getI18n()).toBeDefined();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = freshRoot(container);

    function Probe({ tick }: { tick: number }) {
      const { t } = useTranslation();
      const [items] = freshUseState<string[]>([]);
      return h('span', null, `${tick}:${items.length}:${t('common.close')}`);
    }

    try {
      freshAct(() => {
        root.render(h(Probe, { tick: 1 }));
      });
      expect(container.textContent).toBe('1:0:Close');

      await freshAct(async () => {
        await initI18n('zh_CN');
        root.render(h(Probe, { tick: 2 }));
      });

      expect(container.textContent).toContain('2:0:');
      expect(container.textContent).not.toBe('2:0:Close');
    } finally {
      freshAct(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
