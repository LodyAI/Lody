// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectBrowserLanguage, parseStoredLanguageValue } from '../src/i18n';

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

  it('distinguishes Traditional Chinese from Simplified Chinese', () => {
    for (const tag of ['zh-Hant', 'zh-Hant-TW', 'zh-Hant-HK', 'zh-TW', 'zh-HK', 'zh-MO', 'zh_TW']) {
      setLanguages([tag], tag);
      expect(detectBrowserLanguage()).toBe('zh_Hant');
    }

    for (const tag of ['zh', 'zh-Hans', 'zh-Hans-CN', 'zh-CN', 'zh-SG', 'zh_CN']) {
      setLanguages([tag], tag);
      expect(detectBrowserLanguage()).toBe('zh_CN');
    }
  });

  it.each([
    ['ja-JP', 'ja'],
    ['ja', 'ja'],
    ['ko-KR', 'ko'],
    ['es-MX', 'es'],
    ['fr-CA', 'fr'],
    ['ru-RU', 'ru'],
    ['en-GB', 'en'],
    ['de-DE', null],
  ] as const)('maps browser tag %s to %s', (tag, expected) => {
    setLanguages([tag], tag);
    expect(detectBrowserLanguage()).toBe(expected);
  });

  it('normalizes exact supported codes and BCP-47 aliases in stored language preferences', () => {
    expect(parseStoredLanguageValue(JSON.stringify('zh_Hant'))).toBe('zh_Hant');
    expect(parseStoredLanguageValue('zh-Hant')).toBe('zh_Hant');
    expect(parseStoredLanguageValue('zh-CN')).toBe('zh_CN');
    expect(parseStoredLanguageValue(JSON.stringify('ja'))).toBe('ja');
    expect(parseStoredLanguageValue(JSON.stringify('ko'))).toBe('ko');
    expect(parseStoredLanguageValue(JSON.stringify('es'))).toBe('es');
    expect(parseStoredLanguageValue(JSON.stringify('fr'))).toBe('fr');
    expect(parseStoredLanguageValue(JSON.stringify('ru'))).toBe('ru');
    expect(parseStoredLanguageValue('de-DE')).toBeNull();
  });

  it.each([
    ['macOS', 'darwin', 'zh-Hans-CN', 'zh_CN'],
    ['macOS Traditional', 'darwin', 'zh-Hant-TW', 'zh_Hant'],
    ['Windows', 'win32', 'zh-CN', 'zh_CN'],
    ['Linux', 'linux', 'zh_CN', 'zh_CN'],
    ['Japanese', 'darwin', 'ja-JP', 'ja'],
    ['Korean', 'win32', 'ko-KR', 'ko'],
    ['Spanish', 'linux', 'es-ES', 'es'],
    ['French', 'darwin', 'fr-FR', 'fr'],
    ['Russian', 'linux', 'ru-RU', 'ru'],
  ] as const)(
    'uses the %s system language passed by Electron main',
    (_label, os, language, expected) => {
      setLanguages(['en-US'], 'en-US');
      const electronWindow = window as GlobalWindow;
      electronWindow.__LODY_ELECTRON__ = true;
      electronWindow.__LODY_PLATFORM__ = {
        os,
        homeDir: '/home/test',
        preferredSystemLanguages: [language, 'en-US'],
      };

      expect(detectBrowserLanguage()).toBe(expected);
    }
  );

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
