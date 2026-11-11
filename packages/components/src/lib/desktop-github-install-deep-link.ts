import {
  readGitHubInstallError,
  readGitHubInstallRetry,
  GITHUB_INSTALL_RETRY_PREFIX,
} from './github-installation-recovery';
import { readWorkspaceSlugFromPath } from './deep-link-path';

/**
 * Where to land after the GitHub install deep link returns.
 *
 * - `'settings'`: the integrations page (default — matches the flow when the
 *   user kicked install off from settings and expects to see the result).
 * - `'home'`: the workspace home (`/chat`) — used when install was kicked off
 *   from the onboarding overlay, since landing on a settings page mid-flow
 *   leaves the user behind a covered settings UI once they finish.
 */
export type DesktopGitHubInstallReturnTarget = 'settings' | 'home';

export function resolveDesktopGitHubInstallDeepLinkPath(
  deepLinkUrl: string,
  fallbackPathname = '/',
  options?: { target?: DesktopGitHubInstallReturnTarget }
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'lody:' || parsed.hostname !== 'github-install') {
    return null;
  }

  const workspaceSlug =
    parsed.searchParams.get('workspaceSlug')?.trim() || readWorkspaceSlugFromPath(fallbackPathname);
  if (!workspaceSlug) {
    return null;
  }

  const error = readGitHubInstallError(parsed.search);
  // Success leaves the projects step open; failures must expose settings recovery.
  if (fallbackPathname === '/onboarding' && !error) return null;
  const target = error ? 'settings' : (options?.target ?? 'settings');
  const subpath = target === 'home' ? '/chat' : '/settings/github';

  const targetSearchParams = new URLSearchParams();
  if (!error && parsed.searchParams.get('installed') === 'true') {
    targetSearchParams.set('installed', 'true');
  }

  if (error) targetSearchParams.set('github_install_error', error);
  const retry = error
    ? readGitHubInstallRetry(parsed.hash, import.meta.env.VITE_CONVEX_SITE_URL)
    : null;
  const hash = retry ? `${GITHUB_INSTALL_RETRY_PREFIX}${encodeURIComponent(retry)}` : '';
  const search = targetSearchParams.toString();
  const path = `/${encodeURIComponent(workspaceSlug)}${subpath}`;
  return `${search ? `${path}?${search}` : path}${hash}`;
}
