import { toSiteLocalePrefix } from '@lody/shared/language';
import { isNativeAppShell } from './native-platform';

const LODY_FALLBACK_ORIGIN = 'https://lody.ai';

/** Public invite for the Lody Discord server (sidebar + About → Join community). */
export const LODY_DISCORD_URL = 'https://discord.gg/E8mZtMu38s';

/**
 * Resolve the origin to use for Lody marketing/site links (download page,
 * website, etc.). Borrows the current web origin when there is a real one so
 * staging/preview builds link to themselves, and falls back to the canonical
 * production origin when there isn't (native shells, `file://` Electron
 * bundles, SSR).
 */
export function getLodyOrigin(): string {
  if (typeof window === 'undefined' || isNativeAppShell()) {
    return LODY_FALLBACK_ORIGIN;
  }
  if (window.location.protocol === 'file:' || window.location.origin === 'null') {
    return LODY_FALLBACK_ORIGIN;
  }
  return window.location.origin;
}

export function getSiteLocalePrefix(language: string | undefined): string {
  return toSiteLocalePrefix(language);
}

export function getSiteLocalizedUrl(
  path: string,
  language: string | undefined,
  origin: string = getLodyOrigin()
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const prefix = getSiteLocalePrefix(language);
  return new URL(`${prefix}${normalizedPath}`, origin).toString();
}

export function getDownloadPageUrl(language: string | undefined): string {
  return getSiteLocalizedUrl('/download', language);
}

export function getNightlyDownloadPageUrl(language: string | undefined): string {
  return `${getDownloadPageUrl(language)}/nightly`;
}

export function getChangelogUrl(language: string | undefined): string {
  return getSiteLocalizedUrl('/changelog', language);
}

export function getWebsiteUrl(language: string | undefined): string {
  const prefix = getSiteLocalePrefix(language);
  const path = prefix ? `${prefix}/` : '/home';
  return new URL(path, getLodyOrigin()).toString();
}
