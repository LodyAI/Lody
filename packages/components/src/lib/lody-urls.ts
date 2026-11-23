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

export function getDownloadPageUrl(language: string | undefined): string {
  const isChinese = language?.startsWith('zh') ?? false;
  const path = isChinese ? '/zh/download' : '/download';
  return new URL(path, getLodyOrigin()).toString();
}

export function getNightlyDownloadPageUrl(language: string | undefined): string {
  return `${getDownloadPageUrl(language)}/nightly`;
}

export function getChangelogUrl(language: string | undefined): string {
  const isChinese = language?.startsWith('zh') ?? false;
  const path = isChinese ? '/zh/changelog' : '/changelog';
  return new URL(path, getLodyOrigin()).toString();
}

export function getWebsiteUrl(language: string | undefined): string {
  const isChinese = language?.startsWith('zh') ?? false;
  const path = isChinese ? '/zh/' : '/home';
  return new URL(path, getLodyOrigin()).toString();
}
