import { createInstance, type i18n } from 'i18next';
import { createElement, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

/** An independent, synchronous translator: no app resources or global language. */
export function createTestI18n({
  language = 'en',
  keyLabels = false,
  exposeValues = false,
  interpolate = true,
}: {
  language?: string;
  keyLabels?: boolean;
  exposeValues?: boolean;
  interpolate?: boolean;
} = {}): i18n {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: false,
    resources: { [language]: { translation: {} } },
    initAsync: false,
    interpolation: {
      escapeValue: false,
      // Some option-list fixtures intentionally assert literal fallback markers.
      ...(interpolate ? {} : { prefix: '[[', suffix: ']]' }),
    },
    react: { useSuspense: false },
    // Control/permission tests intentionally identify actions by stable keys.
    // Other suites use i18next's real fallback and interpolation behavior.
    ...(keyLabels
      ? {
          parseMissingKeyHandler(
            key: string,
            _fallback: string | undefined,
            options: Record<string, unknown> = {}
          ) {
            if (!exposeValues) return key;
            const values = Object.fromEntries(
              Object.entries(options).filter(
                ([name]) => !['lng', 'lngs', 'ns', 'keyPrefix', 'defaultValue'].includes(name)
              )
            );
            return Object.keys(values).length ? `${key} ${JSON.stringify(values)}` : key;
          },
        }
      : {}),
  });
  return instance;
}

export function withTestI18n(children: ReactNode, instance: i18n) {
  return createElement(I18nextProvider, { i18n: instance }, children);
}
