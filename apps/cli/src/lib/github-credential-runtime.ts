/** Shared source embedded in the standalone Git and gh helpers (no runtime deps). */
export const githubCredentialRuntime = String.raw`
const readCredentialPolicy = async () => {
  const contextToken = getContextToken();
  if (!contextToken) throw new Error('GitHub credential context is missing. Restart this session.');
  let response;
  let policy;
  try {
    response = await requestBroker('/github-auth-context', { contextToken }, 10000);
    policy = response ? await response.json() : null;
  } catch {}
  if (!response?.ok || !policy || typeof policy.allowLocalAuth !== 'boolean' || typeof policy.personalEnabled !== 'boolean') {
    if (policy?.error === 'invalid_context') throw new Error('GitHub credential context expired or the requester changed. Restart this session.');
    if (response?.status === 401) throw new Error('Lody credential broker authentication failed. Reconnect this machine to Lody before retrying; no GitHub operation was attempted.');
    throw new Error('Cannot verify GitHub identity preferences with Lody. Check the Lody connection and machine access, then retry; no GitHub operation was attempted.');
  }
  return policy;
};

const readManagedCandidate = async (repoFullName, source, invalidatedPersonalToken) => {
  const response = await requestBroker('/github-token', {
    repoFullName, source, contextToken: getContextToken(), invalidatedPersonalToken,
  }, 15000);
  if (!response || !response.ok) throw new Error('GitHub credential service is unavailable; no operation was attempted.');
  const body = await response.json();
  if (body.available === false) return null;
  if (!body.token || body.tokenSource !== source) throw new Error('Invalid GitHub credential response.');
  return body.token;
};

// Read-only preflight. Never replay an actual write with another identity.
// A 403 can be SSO, rate limiting or policy: it must not silently change identity.
const checkRepositoryCredential = async (token, repo, requireWrite, requirePublic = false) => {
  let url = new URL('https://api.github.com/repos/' + repo);
  let response;
  for (let redirects = 0; redirects < 4; redirects++) {
    response = await fetch(url.toString(), {
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000), redirect: 'manual',
    });
    if (![301, 302, 307, 308].includes(response.status)) break;
    const target = new URL(response.headers.get('location'), url);
    if (target.origin !== 'https://api.github.com' || target.username || target.password) throw new Error('Unsafe GitHub redirect.');
    url = target;
  }
  if (response.status === 401) return 'invalid';
  if (response.status === 404) return 'unavailable';
  if (!response.ok) throw new Error('GitHub permission check failed (HTTP ' + response.status + '); identity was not changed.');
  const data = await response.json();
  if (requirePublic && data.private !== false) return 'unavailable';
  const permission = typeof requireWrite === 'string' ? requireWrite : 'push';
  return requireWrite && data.permissions && data.permissions[permission] === false ? 'unavailable' : 'usable';
};

const selectGitHubCredential = async (repo, policy, localCandidate, requireWrite, anonymousCandidate) => {
  let personalUnavailable = false;
  if (policy.personalEnabled) {
    let token = await readManagedCandidate(repo, 'personal');
    if (token) {
      let status = await checkRepositoryCredential(token, repo, requireWrite);
      if (status === 'invalid') {
        token = await readManagedCandidate(repo, 'personal', token);
        if (token) status = await checkRepositoryCredential(token, repo, requireWrite);
      }
      if (token && status === 'usable') return { token, source: 'personal' };
    }
    personalUnavailable = true;
  }
  if (policy.allowLocalAuth) {
    const local = await localCandidate();
    if (local) {
      if (personalUnavailable) console.error('[Lody] Personal GitHub access is unavailable for ' + repo + '; using machine-local credentials.');
      return { ...local, source: 'local' };
    }
  }
  const token = await readManagedCandidate(repo, 'app');
  if (!token && !requireWrite && anonymousCandidate && await anonymousCandidate()) {
    console.error('[Lody] Reading public GitHub repository ' + repo + ' anonymously (no applicable credential).');
    return { token: null, source: 'anonymous' };
  }
  if (!token) throw new Error('No GitHub credential is available for ' + repo + '.');
  console.error('[Lody] Using GitHub App identity for ' + repo + (personalUnavailable ? ' (personal access unavailable).' : '.'));
  return { token, source: 'app' };
};
`;
