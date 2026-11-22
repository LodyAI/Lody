import { notificationMessages } from '@lody/shared/notifications';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import React, { useEffect } from 'react';
import { Select } from '@lody/ui/select';
import { useAtom } from 'jotai';
import { languageAtom } from '../atoms/settings';
import type { SupportedLanguage } from '@lody/shared';
import { withPush } from '@/lib/push-notifications';

import en from '../../../../locales/en.json';
import lang_en from '../../../../locales/modules/lang/en.json';
import lang_zhCN from '../../../../locales/modules/lang/zh_CN.json';

/* `en` is the fallback language, so its bundle stays eager. `zh_CN` (~500KB)
   loads on demand: `ensureLanguageResources` fetches it before init when the
   detected/stored language is Chinese, and before any later language switch,
   so `i18n.changeLanguage` always sees a real bundle — never the en fallback. */
async function loadZhCNBundle(): Promise<Record<string, unknown>> {
  const module = await import('../../../../locales/zh_CN.json');
  return { ...module.default, ...notificationMessages.zh };
}

export const resources = {
  en: {
    translation: { ...en, ...notificationMessages.en },
    lang: lang_en,
  },
  zh_CN: {
    translation: {},
    lang: lang_zhCN,
  },
};

const loadedLanguages = new Set<string>(['en']);
const languageLoadPromises = new Map<string, Promise<void>>();

export function ensureLanguageResources(language: string): Promise<void> {
  if (loadedLanguages.has(language)) {
    return Promise.resolve();
  }
  let pending = languageLoadPromises.get(language);
  if (!pending) {
    pending = (async () => {
      // Only zh_CN is deferred today; extend the switch when locales grow.
      const bundle = language === 'zh_CN' ? await loadZhCNBundle() : {};
      if (i18next.isInitialized) {
        i18next.addResourceBundle(language, defaultNS, bundle, true, true);
      } else {
        resources[language as SupportedLanguage].translation = bundle;
      }
      loadedLanguages.add(language);
    })();
    languageLoadPromises.set(language, pending);
    // A failed fetch must not poison the map — a retry re-issues the import.
    pending.catch(() => languageLoadPromises.delete(language));
  }
  return pending;
}

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
  // Pull the locale bundle before init — with `initImmediate: false` the init
  // itself is synchronous, so this is the only async gap. In tests that mock
  // react-i18next without initReactI18next, the .use() chain throws — degrade
  // to a skipped init instead of surfacing an unhandled rejection.
  try {
    await ensureLanguageResources(nextLanguage);
  } catch (error) {
    console.warn(`Failed to load i18n resources for ${nextLanguage}:`, error);
  }

  if (!initializationPromise) {
    try {
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
    } catch (error) {
      // `use`/`init` throws synchronously when the react-i18next plugin is a
      // partial mock in tests — keep the promise resolved so callers and the
      // floating bootstrap call don't surface an unhandled rejection.
      console.warn('i18n init failed:', error);
      initializationPromise = Promise.resolve();
    }
  }

  await initializationPromise;

  if (i18next.resolvedLanguage === nextLanguage || i18next.language === nextLanguage) {
    return;
  }

  try {
    await i18next.changeLanguage(nextLanguage);
  } catch (error) {
    console.warn(`i18n changeLanguage(${nextLanguage}) failed:`, error);
  }
};

/* Direct `i18n.changeLanguage` calls skip the lazy-bundle fetch and would fall
   back to English for zh_CN — every language switch must go through this. */
export async function setAppLanguage(language: string): Promise<void> {
  await initI18n(language);
}

export const currentSupportedLanguages = Object.keys(resources);
export const languageCodeToName = Object.fromEntries(
  currentSupportedLanguages.map((lang) => [lang, resources[lang as SupportedLanguage].lang.name])
);

void initI18n(readStoredLanguagePreference() ?? detectBrowserLanguage() ?? fallbackLanguage);

// `Select.Value` reads the label of the current value from `items`, not from the
// rows, so the list is stated once and drives both.
const languageOptions = currentSupportedLanguages.map((lang) => ({
  value: lang,
  label: languageCodeToName[lang],
}));

export const LanguageSelector = ({ triggerClassName }: { triggerClassName?: string }) => {
  const [language, setLanguage] = useAtom(languageAtom);
  return (
    <Select.Root
      items={languageOptions}
      defaultValue={language}
      value={language}
      onValueChange={(value) => {
        if (value == null) return;
        setLanguage(value);
        void setAppLanguage(value);
        if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) {
          return;
        }
        void withPush((pushClient) => {
          void pushClient.User.setLanguage(value === 'en' ? 'en' : 'zh');
        }).catch((error: unknown) => {
          console.error('Failed to sync Push language', error);
        });
      }}
    >
      <Select.Trigger className={triggerClassName}>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {languageOptions.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
};

// sub window language change
export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === LANGUAGE_STORAGE_KEY) {
        const nextLanguage = parseStoredLanguageValue(e.newValue);
        if (!nextLanguage) {
          return;
        }
        void setAppLanguage(nextLanguage);
      }
    };
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('storage', handler);
    };
  }, []);
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
