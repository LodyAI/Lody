import { notificationMessages } from '@lody/shared/notifications';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import React, { useEffect } from 'react';
import { Select } from '@lody/ui/select';
import { useAtom } from 'jotai';
import { languageAtom } from '../atoms/settings';
import {
  bcp47ToSupportedLanguage,
  normalizeSupportedLanguage,
  toPushLanguage,
  type SupportedLanguage,
} from '@lody/shared';
import { withPush } from '@/lib/push-notifications';

import en from '../../../../locales/en.json';
import lang_en from '../../../../locales/modules/lang/en.json';
import lang_zhCN from '../../../../locales/modules/lang/zh_CN.json';
import lang_zhHant from '../../../../locales/modules/lang/zh_Hant.json';
import lang_ja from '../../../../locales/modules/lang/ja.json';
import lang_ko from '../../../../locales/modules/lang/ko.json';
import lang_es from '../../../../locales/modules/lang/es.json';
import lang_fr from '../../../../locales/modules/lang/fr.json';
import lang_ru from '../../../../locales/modules/lang/ru.json';

/* `en` is the fallback language, so its bundle stays eager. Every non-English
   locale (~500KB each) loads on demand: `ensureLanguageResources` fetches it
   before init when the detected/stored language is non-English, and before any
   later language switch, so `i18n.changeLanguage` always sees a real bundle —
   never the en fallback. */
const DEFERRED_LOCALE_LOADERS: Record<
  Exclude<SupportedLanguage, 'en'>,
  () => Promise<Record<string, unknown>>
> = {
  zh_CN: async () => {
    const module = await import('../../../../locales/zh_CN.json');
    return { ...module.default, ...notificationMessages.zh };
  },
  zh_Hant: async () => {
    const module = await import('../../../../locales/zh_Hant.json');
    return { ...module.default, ...notificationMessages.zh_Hant };
  },
  ja: async () => {
    const module = await import('../../../../locales/ja.json');
    return { ...module.default, ...notificationMessages.ja };
  },
  ko: async () => {
    const module = await import('../../../../locales/ko.json');
    return { ...module.default, ...notificationMessages.ko };
  },
  es: async () => {
    const module = await import('../../../../locales/es.json');
    return { ...module.default, ...notificationMessages.es };
  },
  fr: async () => {
    const module = await import('../../../../locales/fr.json');
    return { ...module.default, ...notificationMessages.fr };
  },
  ru: async () => {
    const module = await import('../../../../locales/ru.json');
    return { ...module.default, ...notificationMessages.ru };
  },
};

export const resources: Record<
  SupportedLanguage,
  { translation: Record<string, unknown>; lang: { name: string } }
> = {
  en: {
    translation: { ...en, ...notificationMessages.en },
    lang: lang_en,
  },
  zh_CN: {
    translation: {},
    lang: lang_zhCN,
  },
  zh_Hant: {
    translation: {},
    lang: lang_zhHant,
  },
  ja: {
    translation: {},
    lang: lang_ja,
  },
  ko: {
    translation: {},
    lang: lang_ko,
  },
  es: {
    translation: {},
    lang: lang_es,
  },
  fr: {
    translation: {},
    lang: lang_fr,
  },
  ru: {
    translation: {},
    lang: lang_ru,
  },
};

const loadedLanguages = new Set<string>(['en']);
const languageLoadPromises = new Map<string, Promise<void>>();

export function ensureLanguageResources(language: string): Promise<void> {
  const normalized = normalizeSupportedLanguage(language) ?? fallbackLanguage;
  if (loadedLanguages.has(normalized)) {
    return Promise.resolve();
  }
  let pending = languageLoadPromises.get(normalized);
  if (!pending) {
    pending = (async () => {
      const loader = normalized === 'en' ? undefined : DEFERRED_LOCALE_LOADERS[normalized];
      const bundle = loader ? await loader() : {};
      if (i18next.isInitialized) {
        i18next.addResourceBundle(normalized, defaultNS, bundle, true, true);
      } else {
        resources[normalized].translation = bundle;
      }
      loadedLanguages.add(normalized);
    })();
    languageLoadPromises.set(normalized, pending);
    // A failed fetch must not poison the map — a retry re-issues the import.
    pending.catch(() => languageLoadPromises.delete(normalized));
  }
  return pending;
}

export const defaultNS = 'translation';
export const fallbackLanguage = 'en';
const LANGUAGE_STORAGE_KEY = 'lody-language';
let initializationPromise: Promise<void> | null = null;
let latestLanguageRequest = 0;

function coerceSupportedLanguage(value: unknown): SupportedLanguage | null {
  return normalizeSupportedLanguage(value);
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

function ensureI18nInitialized(): Promise<void> {
  if (!initializationPromise) {
    try {
      // Initialize synchronously with the eager fallback (`en`) so react-i18next
      // registers its singleton before any component renders. Otherwise a host
      // that mounts before `initI18n` resolves hits `useTranslation()`'s `!i18n`
      // early return (skipping hooks) and crashes with a hook-order mismatch on
      // its next render.
      initializationPromise = i18next
        .use(initReactI18next)
        .init({
          lng: fallbackLanguage,
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
  return initializationPromise;
}

export const initI18n = async (language: string) => {
  const requestId = ++latestLanguageRequest;
  const nextLanguage = coerceSupportedLanguage(language) ?? fallbackLanguage;
  const initPromise = ensureI18nInitialized();

  let resourcesLoaded = true;
  try {
    await ensureLanguageResources(nextLanguage);
  } catch (error) {
    resourcesLoaded = false;
    console.warn(`Failed to load i18n resources for ${nextLanguage}:`, error);
  }

  await initPromise;

  if (!resourcesLoaded || requestId !== latestLanguageRequest) {
    return;
  }

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
          void pushClient.User.setLanguage(toPushLanguage(value));
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
