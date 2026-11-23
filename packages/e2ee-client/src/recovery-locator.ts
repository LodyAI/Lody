/**
 * The `serviceLocator` every host writes into, and requires from, a vault-v1 recovery
 * file: the canonical origin of the product site the client is signed in to.
 * Desktop, mobile and Web derive it from the same site URL so one file opens on all of
 * them. It is never a backend deployment URL or an account ID.
 */

/** Locator of Lody Cloud recovery files. */
export const LODY_CLOUD_RECOVERY_SERVICE_LOCATOR = 'https://lody.ai';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Canonical recovery service locator for a product site URL: its origin (lower-case
 * host, default port omitted, no path or trailing slash). HTTPS is required; plain
 * HTTP is accepted only for loopback development hosts. Returns `null` for a missing,
 * malformed, credential-bearing or non-HTTP(S) URL, so the host refuses recovery
 * instead of writing or accepting an unusable locator.
 */
export function recoveryServiceLocator(siteUrl: string | null | undefined): string | null {
  const value = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname)))
    return null;
  return url.origin;
}
