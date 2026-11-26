/**
 * Where the emoji picker reads its dataset, and in which language.
 *
 * The files are emitted by `vite-emojibase-assets.ts` in the host app's build,
 * so this side only has to resolve the same URL. Kept apart from the picker
 * component so a host that has not wired the plugin fails in one obvious place
 * rather than silently falling back to a CDN — Lody's desktop and mobile apps
 * are expected to work offline.
 */

import { normalizeSupportedLanguage, type SupportedLanguage } from '@lody/shared/language';

/** Path segment under the app's base URL. The Vite plugin emits into it. */
export const EMOJIBASE_ASSET_DIRECTORY = 'emojibase';

/**
 * The product's own languages, and the whole set the plugin emits.
 *
 * The dataset is ~750 KB per locale, so bundling every locale `emojibase-data`
 * ships would cost megabytes for languages the rest of the UI cannot be
 * displayed in. Declared here rather than in the plugin so the resolver below
 * cannot ask for a file the build never wrote.
 */
export const EMOJIBASE_BUNDLED_LOCALES = [
  'en',
  'zh',
  'zh-hant',
  'ja',
  'ko',
  'es',
  'fr',
  'ru',
] as const;

export type EmojibaseLocale = (typeof EMOJIBASE_BUNDLED_LOCALES)[number];

const SUPPORTED_TO_EMOJIBASE: Record<SupportedLanguage, EmojibaseLocale> = {
  en: 'en',
  zh_CN: 'zh',
  zh_Hant: 'zh-hant',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  ru: 'ru',
};

/**
 * The bundled dataset's base URL.
 *
 * Anchored on the app's Vite base, NOT on the current document path. The router
 * uses browser history wherever the app is served over http, so the document URL
 * is a deep route like `/workspace/settings/agent-roles` — resolving against it
 * produced `…/settings/emojibase`, which the dev server answered with the SPA
 * fallback and the picker then tried to parse as JSON.
 *
 * A relative base (`./`, what the packaged Electron renderer builds with) still
 * resolves against the document, which is correct there: that renderer loads
 * `index.html` over `file:` and switches to hash history, so the document path
 * stays the entry file.
 */
export const getBundledEmojibaseUrl = (): string | undefined => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
  // This module is also followed by Electron's Node-side config typecheck,
  // whose ambient ImportMetaEnv intentionally contains only main-process keys.
  const base = (
    (import.meta.env as { readonly BASE_URL?: string } | undefined)?.BASE_URL || '/'
  ).replace(/\/*$/, '/');
  return base.startsWith('/')
    ? new URL(`${base}${EMOJIBASE_ASSET_DIRECTORY}`, window.location.origin).href
    : new URL(`${base}${EMOJIBASE_ASSET_DIRECTORY}`, document.baseURI).href;
};

/**
 * The picker's locale for a product language tag.
 *
 * Emoji labels and category names are the picker's own copy, so they follow the
 * product language rather than the host OS.
 */
export const resolveEmojibaseLocale = (language: string | undefined): EmojibaseLocale => {
  const normalized = normalizeSupportedLanguage(language);
  return normalized ? SUPPORTED_TO_EMOJIBASE[normalized] : 'en';
};
