/** Shared source embedded in the standalone Git and gh helpers (no runtime deps). */
export const githubCredentialRuntime = String.raw`
const readCredentialPolicy = async () => {
  const contextToken = getContextToken();
  if (!contextToken) throw new Error('Lody did not supply a GitHub credential context for this operation. No GitHub credential was selected. Update Lody; if this persists, report this startup/context error.');
  // Retry only the read-only policy lookup, before selecting any identity. Each
  // request rereads workspace broker state, but keeps this helper's requester.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    let policy;
    let failure = 'broker_unavailable';
    let retryable = true;
    try {
      response = await requestBroker('/github-auth-context', { contextToken }, 10000);
      if (response) {
        failure = 'HTTP ' + response.status;
        retryable = [500, 502, 503, 504].includes(response.status);
        policy = await response.json();
      }
    } catch (error) {
      // Never echo exception messages, response bodies, URLs or token material.
      // Invalid JSON/config is not a connection failure and cannot select auth.
      if (!response || response.ok) {
        const code = error?.cause?.code || error?.code;
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          failure = 'policy_timeout';
          retryable = true;
        } else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
          failure = 'broker_connection_failed (' + code + ')';
          retryable = true;
        } else if (code === 'ENOENT') {
          failure = 'broker_state_missing';
        } else {
          failure = 'invalid_broker_response';
          retryable = false;
        }
      }
    }
    if (policy?.error === 'invalid_context') throw new Error('GitHub credential context expired or the requester changed. Restart this session.');
    if (response?.status === 401) throw new Error('Lody credential broker authentication failed. Reconnect this machine to Lody before retrying; no GitHub operation was attempted.');
    if (response?.ok && policy && typeof policy.allowLocalAuth === 'boolean' && typeof policy.personalEnabled === 'boolean') return policy;
    if (response?.ok && !retryable) {
      failure = 'invalid_policy_response';
      retryable = false;
    }
    if (attempt === 0 && retryable) {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    throw new Error('Cannot verify GitHub identity preferences with Lody (' + failure + ', ' + (attempt + 1) + ' attempt(s)). Check the Lody connection and machine access, then retry; no GitHub operation was attempted.');
  }
};

const readManagedCandidate = async (repoFullName, source, invalidatedPersonalToken) => {
  const response = await requestBroker('/github-token', {
    repoFullName, source, contextToken: getContextToken(), invalidatedPersonalToken,
  }, 15000);
  if (!response || !response.ok) throw new Error('GitHub credential service is unavailable; no operation was attempted.');
  const body = await response.json();
  if (body.available === false) return { token: null, reason: typeof body.reason === 'string' ? body.reason : null };
  if (!body.token || body.tokenSource !== source) throw new Error('Invalid GitHub credential response.');
  return { token: body.token, reason: null };
};

// Why the personal identity was skipped, in words the user can act on. Never
// includes token material; reasons are backend policy codes or preflight states.
const describePersonalUnavailable = (repo, reason) => {
  switch (reason) {
    case 'personal_auth_missing':
      return 'your personal GitHub account is not authorized yet (Settings > Integrations > GitHub > Authorize)';
    case 'personal_token_expired':
    case 'personal_token_refresh_failed':
      return 'your personal GitHub authorization has expired or been revoked; re-authorize in Settings > Integrations > GitHub';
    case 'no_repository_access':
      return 'your GitHub account cannot access ' + repo + ' with the required permission';
    case 'token_invalid':
      return 'GitHub rejected your personal token; re-authorize in Settings > Integrations > GitHub';
    default:
      return reason ? 'personal access is unavailable (' + reason + ')' : 'personal access is unavailable';
  }
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
  let personalUnavailable = null;
  if (policy.personalEnabled) {
    let candidate = await readManagedCandidate(repo, 'personal');
    let token = candidate.token;
    personalUnavailable = candidate.reason;
    if (token) {
      let status = await checkRepositoryCredential(token, repo, requireWrite);
      if (status === 'invalid') {
        candidate = await readManagedCandidate(repo, 'personal', token);
        token = candidate.token;
        personalUnavailable = candidate.reason ?? 'token_invalid';
        if (token) status = await checkRepositoryCredential(token, repo, requireWrite);
      }
      if (token && status === 'usable') return { token, source: 'personal' };
      if (token) personalUnavailable = status === 'invalid' ? 'token_invalid' : 'no_repository_access';
    }
    personalUnavailable = describePersonalUnavailable(repo, personalUnavailable);
  }
  if (policy.allowLocalAuth) {
    const local = await localCandidate();
    if (local) {
      if (personalUnavailable) console.error('[Lody] Using machine-local GitHub credentials for ' + repo + ': ' + personalUnavailable + '.');
      return { ...local, source: 'local' };
    }
  }
  const token = (await readManagedCandidate(repo, 'app')).token;
  if (!token && !requireWrite && anonymousCandidate && await anonymousCandidate()) {
    console.error('[Lody] Reading public GitHub repository ' + repo + ' anonymously (no applicable credential).');
    return { token: null, source: 'anonymous' };
  }
  if (!token) throw new Error('No GitHub credential is available for ' + repo + '.');
  console.error('[Lody] Using GitHub App identity for ' + repo + (personalUnavailable ? ': ' + personalUnavailable + '.' : '.'));
  return { token, source: 'app' };
};
`;
