// Whitelist for the `?redirect=` parameter used by `/login` and
// `/complete-email`. A permissive implementation here is an open-redirect
// vulnerability: an attacker who lands a user on
// `https://lody.ai/login?redirect=https://evil.com/fake-login` can phish the
// session handoff. Keep the allowlist tight.

export type SafeAuthRedirectOptions = {
  /** Origin used to resolve relative redirects and allow same-origin targets. */
  appOrigin: string;
  /**
   * A pathname that, if the redirect resolves to it on the same origin, is
   * rejected to prevent redirect loops (e.g. `/login` on the login page).
   */
  forbiddenSamePathname?: string;
};

/**
 * Returns the redirect target to use, or `null` if the candidate is missing,
 * malformed, or not allowed. Callers should fall back to a default route when
 * this returns `null`.
 *
 * Allowed:
 *   - Same-origin URLs (supports localhost dev + the app's own host), except a
 *     caller-specified forbidden pathname on that same origin.
 *   - `https://lody.ai` and `https://*.lody.ai` subdomains, for the shared-auth
 *     handoff to `feedback.lody.ai` and any future sibling properties.
 *
 * Rejected:
 *   - `http:` lody.ai URLs (requires https for shared-auth cookies).
 *   - Any other scheme (including `javascript:`, `data:`).
 *   - Hostnames that only look like lody.ai (e.g. `lody.ai.evil.com`,
 *     `notlody.ai`).
 *   - Protocol-relative URLs resolving off-domain (e.g. `//evil.com`).
 */
export function isSafeAuthRedirect(
  candidate: string | null | undefined,
  options: SafeAuthRedirectOptions
): string | null {
  if (!candidate) return null;

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(candidate, options.appOrigin);
  } catch {
    return null;
  }

  if (redirectUrl.origin === options.appOrigin) {
    if (
      options.forbiddenSamePathname !== undefined &&
      redirectUrl.pathname === options.forbiddenSamePathname
    ) {
      return null;
    }
    return candidate;
  }

  if (redirectUrl.protocol !== 'https:') return null;

  const host = redirectUrl.hostname;
  const isLodyAiHost = host === 'lody.ai' || host.endsWith('.lody.ai');
  if (!isLodyAiHost) return null;

  return redirectUrl.toString();
}
