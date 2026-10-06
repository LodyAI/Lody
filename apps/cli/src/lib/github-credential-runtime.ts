/** Dependency-free source shared by the native Git and gh adapters. */
export const githubCredentialRuntime = String.raw`
const credentialError = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const errorCode = error => {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = [error?.code, error?.cause?.code].find(value => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value));
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'unexpected_error';
};
const diagnostic = (source, stage, error) => {
  const detail = { source, stage, code: errorCode(error) };
  if (Number.isInteger(error?.status)) detail.status = error.status;
  if (typeof error?.requestId === 'string' && /^[a-f0-9-]{1,64}$/.test(error.requestId)) detail.requestId = error.requestId;
  console.error('[Lody GitHub] ' + JSON.stringify(detail));
  return detail;
};
// This file is authored by the host, never inferred from a child's token/env.
// A pinned context token names an immutable snapshot for host-side clone/fetch.
const readCredentialContext = (fs, statePath, env) => {
  const file = env.LODY_GIT_CRED_CONTEXT_FILE || (env.LODY_GIT_CRED_CONTEXT_TOKEN && statePath + '.contexts/' + env.LODY_GIT_CRED_CONTEXT_TOKEN + '.json');
  if (!file) throw credentialError('context_missing');
  let context;
  try { context = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw credentialError('context_unreadable', { cause }); }
  if (context?.version !== 1 || typeof context.contextToken !== 'string' || !context.contextToken || typeof context.allowLocalAuth !== 'boolean') throw credentialError('context_invalid');
  return context;
};
const readCredentialPolicy = () => {
  const context = getContext();
  return { allowLocalAuth: context.allowLocalAuth, personalEnabled: true };
};
const readManagedCandidate = async (repoFullName, source) => {
  const response = await requestBroker('/github-token', {
    repoFullName, source, contextToken: getContext().contextToken,
  }, 3000);
  if (!response) throw credentialError('broker_unavailable');
  let body;
  try { body = await response.json(); }
  catch (cause) { throw credentialError(errorCode(cause) === 'timeout' ? 'timeout' : 'invalid_response', { cause, status: response.status }); }
  if (!response.ok) throw credentialError(typeof body.error === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(body.error) ? body.error : 'broker_http_error', { status: response.status, requestId: body.requestId });
  if (body.available === false) throw credentialError(typeof body.reason === 'string' && /^[a-z_]{1,64}$/.test(body.reason) ? body.reason : 'credential_unavailable');
  if (typeof body.token !== 'string' || !body.token || /[\r\n]/.test(body.token) || body.tokenSource !== source) throw credentialError('invalid_credential_response');
  return { token: body.token };
};
// One acquisition per source. Consumers can continue after a provably safe
// failure of the actual operation; never restart this iterator to retry a source.
async function* githubCredentials(repo, policy, localCandidate, anonymous = false) {
  const failures = [];
  for (const source of ['personal', 'local', 'app', ...(anonymous ? ['anonymous'] : [])]) {
    if (source === 'personal' && policy.personalEnabled === false) continue;
    if (source === 'local' && !policy.allowLocalAuth) continue;
    try {
      const candidate = source === 'anonymous' ? { token: null } : source === 'local' ? await localCandidate() : await readManagedCandidate(repo, source);
      if (!candidate) throw credentialError('credential_missing');
      yield { ...candidate, source };
    } catch (error) {
      failures.push(diagnostic(source, 'acquire', error));
    }
  }
  throw credentialError('credentials_exhausted', { failures });
}
const selectGitHubCredential = async (repo, policy, localCandidate, requireWrite, anonymousCandidate, verify = async () => true) => {
  const failures = [];
  try {
    for await (const candidate of githubCredentials(repo, policy, localCandidate, !requireWrite && !!anonymousCandidate)) {
      try {
        if (candidate.source === 'anonymous' && !await anonymousCandidate()) throw credentialError('anonymous_unavailable');
        if (!await verify(candidate)) throw credentialError('access_denied');
        console.error('[Lody GitHub] ' + JSON.stringify({ source: candidate.source, stage: 'selected', repo }));
        return candidate;
      } catch (error) { failures.push(diagnostic(candidate.source, 'access', error)); }
    }
  } catch (error) {
    if (error.code === 'credentials_exhausted') error.failures.push(...failures);
    throw error;
  }
};
`;
