import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import React, { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { languageAtom } from '../atoms/settings';
import type { SupportedLanguage } from '@lody/shared';
import { withOneSignal } from '@/lib/onesignal';

import en from '../../../../locales/en.json';
import lang_en from '../../../../locales/modules/lang/en.json';
import lang_zhCN from '../../../../locales/modules/lang/zh_CN.json';
import zhCN from '../../../../locales/zh_CN.json';

export const resources = {
  en: {
    translation: en,
    lang: lang_en,
  },
  zh_CN: {
    translation: zhCN,
    lang: lang_zhCN,
  },
};

export const defaultNS = 'translation';
export const fallbackLanguage = 'en';
const LANGUAGE_STORAGE_KEY = 'lody-language';
let initializationPromise: Promise<void> | null = null;

function coerceSupportedLanguage(value: unknown): SupportedLanguage | null {
  if (typeof value !== 'string') {
    return null;
  }
  return currentSupportedLanguages.includes(value) ? (value as SupportedLanguage) : null;
}

export function parseStoredLanguageValue(raw: string | null | undefined): SupportedLanguage | null {
  const direct = coerceSupportedLanguage(raw);
  if (direct) {
    return direct;
  }
  if (!raw) {
    return null;
  }
  try {
    return coerceSupportedLanguage(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readStoredLanguagePreference(): SupportedLanguage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return parseStoredLanguageValue(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

// Map a BCP-47 tag (e.g. `zh-CN`, `zh-Hans`, `en-US`) to a supported language.
// BCP-47 tags are case-insensitive and structured as `<base>-<region>-...`, so
// we lowercase the input and take the base subtag. We don't install
// i18next-browser-languagedetector for two supported languages — a direct walk
// over `navigator.languages` is simpler and ships no extra code. Rejected:
// matching the full tag case-sensitively. `navigator.languages` is usually
// canonical (`en-US`, `zh-CN`), but a strict match would silently fall through
// to `en` for any non-canonical casing, which is a footgun.
const BASE_SUBTAG_TO_SUPPORTED: Record<string, SupportedLanguage> = {
  en: 'en',
  // Any Chinese variant maps to Simplified Chinese, since that's the only
  // Chinese locale we ship.
  zh: 'zh_CN',
};

function bcp47ToSupportedLanguage(tag: string): SupportedLanguage | null {
  // Electron returns BCP-47 tags, while some Linux locale configurations still
  // surface the legacy underscore spelling. Treat both separators identically.
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return BASE_SUBTAG_TO_SUPPORTED[base] ?? null;
}

export function detectBrowserLanguage(): SupportedLanguage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  // Electron's Chromium locale may reflect which `.pak` files were packaged,
  // not the user's OS preference. Main passes the real system language list to
  // preload before renderer code runs, keeping detection correct on macOS,
  // Windows, and Linux without an asynchronous first-paint language switch.
  const candidates =
    window.__LODY_ELECTRON__ === true
      ? (window.__LODY_PLATFORM__?.preferredSystemLanguages ?? [])
      : typeof navigator === 'undefined'
        ? []
        : navigator.languages && navigator.languages.length > 0
          ? navigator.languages
          : navigator.language
            ? [navigator.language]
            : [];
  for (const candidate of candidates) {
    const matched = bcp47ToSupportedLanguage(candidate);
    if (matched) {
      return matched;
    }
  }
  return null;
}

export const initI18n = async (language: string) => {
  const nextLanguage = coerceSupportedLanguage(language) ?? fallbackLanguage;

  if (!initializationPromise) {
    initializationPromise = i18next
      .use(initReactI18next)
      .init({
        // The first call happens at module bootstrap with the stored/detected
        // preference. Initializing directly in that language avoids committing
        // one English frame before AppInitializer's effect can reconcile it.
        lng: nextLanguage,
        fallbackLng: fallbackLanguage,
        defaultNS,
        ns: [defaultNS],
        keySeparator: false,
        debug: import.meta.env.DEV && import.meta.env.MODE !== 'test',
        resources,
        backend: [],
        interpolation: {
          escapeValue: false,
        },
        react: {
          useSuspense: false,
        },
        initImmediate: false,
      })
      .then(() => undefined);
  }

  await initializationPromise;

  if (i18next.resolvedLanguage === nextLanguage || i18next.language === nextLanguage) {
    return;
  }

  await i18next.changeLanguage(nextLanguage);
};

export const currentSupportedLanguages = Object.keys(resources);
export const languageCodeToName = Object.fromEntries(
  currentSupportedLanguages.map((lang) => [lang, resources[lang as SupportedLanguage].lang.name])
);

void initI18n(readStoredLanguagePreference() ?? detectBrowserLanguage() ?? fallbackLanguage);

export const LanguageSelector = ({ triggerClassName }: { triggerClassName?: string }) => {
  const { i18n } = useTranslation();
  const [language, setLanguage] = useAtom(languageAtom);
  return (
    <Select
      defaultValue={language}
      value={language}
      onValueChange={(value: SupportedLanguage) => {
        setLanguage(value);
        void i18n.changeLanguage(value);
        if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) {
          return;
        }
        void withOneSignal((oneSignal) => {
          void oneSignal.User.setLanguage(value === 'en' ? 'en' : 'zh');
        }).catch((error: unknown) => {
          console.error('Failed to sync OneSignal language', error);
        });
      }}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {currentSupportedLanguages.map((lang) => (
          <SelectItem key={lang} value={lang}>
            {languageCodeToName[lang]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

// sub window language change
export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const { i18n } = useTranslation();

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === LANGUAGE_STORAGE_KEY) {
        const nextLanguage = parseStoredLanguageValue(e.newValue);
        if (!nextLanguage) {
          return;
        }
        void i18n.changeLanguage(nextLanguage);
      }
    };
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('storage', handler);
    };
  }, [i18n]);
  return children;
};

// @ts-ignore
if (import.meta.hot) {
  // @ts-ignore
  import.meta.hot.on('i18n-update', ({ file, content }: { file: string; content: string }) => {
    const updatedResources = JSON.parse(content);

    // `file` is absolute path e.g. /Users/innei/git/follow/locales/en.json
    // Absolute path e.g. /Users/innei/git/follow/locales/modules/<module-name>/en.json

    // 1. parse root language
    if (!file.includes('locales/modules')) {
      const lang = file.split('/').pop()?.replace('.json', '');
      if (!lang) return;
      i18next.addResourceBundle(lang, defaultNS, updatedResources, true, true);
      void i18next.reloadResources(lang, defaultNS);
    } else {
      const nsName = file.match(/locales\/modules\/(.+?)\//)?.[1];

      if (!nsName) return;
      const lang = file.split('/').pop()?.replace('.json', '');
      if (!lang) return;
      i18next.addResourceBundle(lang, nsName, updatedResources, true, true);
      void i18next.reloadResources(lang, nsName);
    }
  });
}
