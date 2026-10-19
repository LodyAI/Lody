/** Native clients hand off to the browser's authenticated workspace settings. */
export function getPersonalGitHubAuthorizationUrl(workspaceSlug: string): string {
  const siteUrl = import.meta.env.VITE_SITE_URL?.trim() || 'https://lody.ai';
  const url = new URL(`/${encodeURIComponent(workspaceSlug)}/settings/github`, siteUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid GitHub authorization site URL');
  }
  return url.toString();
}

const PROOF_KEY = 'lody:githubPersonalAuthorization';

export async function createPersonalGitHubProof() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const verifier = encode(bytes);
  const challenge = encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  );
  return { verifier, challenge };
}

export function storePersonalGitHubProof(state: string, verifier: string) {
  // One pending grant per user; never move the verifier into a URL or synced state.
  sessionStorage.setItem(PROOF_KEY, JSON.stringify({ state, verifier }));
}

export function takePersonalGitHubCallback(): {
  state: string;
  code: string;
  verifier: string;
} | null {
  const prefix = '#github-personal=';
  if (!window.location.hash.startsWith(prefix)) return null;
  const payload = window.location.hash.slice(prefix.length);
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  );
  const proof = sessionStorage.getItem(PROOF_KEY);
  sessionStorage.removeItem(PROOF_KEY);
  const callback: unknown = JSON.parse(decodeURIComponent(payload));
  const stored: unknown = proof ? JSON.parse(proof) : null;
  if (
    !callback ||
    typeof callback !== 'object' ||
    !('state' in callback) ||
    !('code' in callback) ||
    typeof callback.code !== 'string' ||
    !callback.code ||
    !stored ||
    typeof stored !== 'object' ||
    !('state' in stored) ||
    !('verifier' in stored) ||
    typeof stored.verifier !== 'string' ||
    stored.state !== callback.state ||
    typeof callback.state !== 'string'
  ) {
    throw new Error('Invalid GitHub authorization return');
  }
  return { state: callback.state, code: callback.code, verifier: stored.verifier };
}
