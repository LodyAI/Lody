/** The installation callback carries advice separately from its retry capability. */
export const GITHUB_INSTALL_ERROR_CODES = [
  'authorization_required',
  'temporarily_unavailable',
  'installation_not_visible',
  'linked_elsewhere',
  'suspended',
  'encrypted_workspace',
  'repositories_too_many',
  'invalid_state',
  'forbidden',
  'deletion_in_progress',
] as const;
export type GitHubInstallErrorCode = (typeof GITHUB_INSTALL_ERROR_CODES)[number];
export const GITHUB_INSTALL_RETRY_PREFIX = '#github-install-retry=';

export function readGitHubInstallError(search: string): GitHubInstallErrorCode | 'unknown' | null {
  const code = new URLSearchParams(search).get('github_install_error');
  if (!code) return null;
  return GITHUB_INSTALL_ERROR_CODES.includes(code as GitHubInstallErrorCode)
    ? (code as GitHubInstallErrorCode)
    : 'unknown';
}

/** A callback capability must never become an arbitrary external-navigation link. */
export function readGitHubInstallRetry(
  hash: string,
  convexSiteUrl: string | undefined
): string | null {
  if (!convexSiteUrl || !hash.startsWith(GITHUB_INSTALL_RETRY_PREFIX)) return null;
  try {
    const url = new URL(decodeURIComponent(hash.slice(GITHUB_INSTALL_RETRY_PREFIX.length)));
    const site = new URL(convexSiteUrl);
    const state = url.searchParams.get('state');
    const installationId = url.searchParams.get('installation_id');
    if (
      !['https:', 'http:'].includes(site.protocol) ||
      url.origin !== site.origin ||
      url.username ||
      url.password ||
      url.pathname !== '/api/github/callback' ||
      url.hash ||
      url.searchParams.get('setup_action') !== 'update' ||
      !state ||
      state.length > 4096 ||
      !installationId ||
      !/^[1-9]\d*$/.test(installationId) ||
      !Number.isSafeInteger(Number(installationId)) ||
      [...url.searchParams.keys()].some(
        (key) => !['state', 'installation_id', 'setup_action'].includes(key)
      ) ||
      ['state', 'installation_id', 'setup_action'].some(
        (key) => url.searchParams.getAll(key).length !== 1
      )
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function currentGitHubInstallationRecovery(): string | undefined {
  const url = new URL(window.location.href);
  if (!readGitHubInstallError(url.search)) return undefined;
  const retry = readGitHubInstallRetry(url.hash, import.meta.env.VITE_CONVEX_SITE_URL);
  if (!retry) return undefined;
  return `?${new URLSearchParams({ github_install_error: url.searchParams.get('github_install_error')! })}${GITHUB_INSTALL_RETRY_PREFIX}${encodeURIComponent(retry)}`;
}

export function restoreGitHubInstallationRecovery(recovery: string): void {
  const url = new URL(recovery, window.location.origin);
  if (
    !readGitHubInstallError(url.search) ||
    !readGitHubInstallRetry(url.hash, import.meta.env.VITE_CONVEX_SITE_URL)
  )
    return;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${url.search}${url.hash}`
  );
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
