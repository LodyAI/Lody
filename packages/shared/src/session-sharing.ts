export * from './session-share-package';
export * from './session-share-export';
export * from './session-share-client';

/** Request intent only; no daemon API accepts approval or publication credentials. */
export type SessionShareRequestInput = {
  workspaceId: string;
  requestId: string;
  requesterUserId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sessionIds: string[];
};
export type SessionShareRequestStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type SessionShareRequestResult = {
  /** Echo of the caller's idempotency key; reuse this as requestId on retry. */
  requestId: string;
  /** Server record identity for human confirmation, never a retry key. */
  shareRequestId: string;
  status: SessionShareRequestStatus;
};

/** Every response body, including attachment downloads, is bounded. */
export const SESSION_SHARE_READ_LIFETIME_MS = 120_000;
export const SESSION_SHARE_READ_AUTH_PATH = '/api/sharing/read';

export function isSessionShareSecret(value: string): boolean {
  // 32 random bytes encoded as lowercase hex. Deliberately versioned in the URL.
  return /^[a-f0-9]{64}$/.test(value);
}

export function createSessionShareSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function hashSessionShareSecret(secret: string): Promise<string> {
  if (!isSessionShareSecret(secret)) throw new Error('Invalid share credential');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`lody-session-share-access-v1:${secret}`)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createSessionShareUrl(shareId: string, secret: string, origin: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(shareId) || !isSessionShareSecret(secret)) {
    throw new Error('Invalid share link');
  }
  // A capability must never be embedded in a caller-controlled path or query.
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    origin.includes('?') ||
    origin.includes('#')
  )
    throw new Error('Invalid share origin');
  return `${url.origin}/s/${shareId}#access=v1.${secret}`;
}

/** Parse only the credential fragment; never accept it from search parameters. */
export function parseSessionShareFragment(fragment: string): string | null {
  const match = /^#access=v1\.([a-f0-9]{64})$/.exec(fragment);
  return match?.[1] ?? null;
}
