import { z } from 'zod';

export const SESSION_SHARE_MAX_TARGETS = 32;
export const SESSION_SHARE_MAX_TITLE_BYTES = 1024;
/** Every response body, including active SSE and attachment downloads, is bounded. */
export const SESSION_SHARE_READ_LIFETIME_MS = 120_000;
export const SESSION_SHARE_READ_AUTH_PATH = '/api/sharing/read';
/** Signed service-to-service observation endpoint; never a client registration API. */
export const SESSION_SHARE_SOURCE_VERIFY_PATH = '/api/sharing/verify-sources';

export type SessionShareVersions = {
  scopeVersion: number;
  credentialVersion: number;
};

export type SessionShareManifest = SessionShareVersions & {
  shareId: string;
  rootSessionId: string;
  workspaceName: string;
  targets: { sessionId: string; title: string }[];
  /** Authorization must be revalidated by this time; not a stream JWT expiry. */
  validUntil: number;
};
export const SessionShareManifestSchema = z.object({
  shareId: z.string(),
  rootSessionId: z.string(),
  workspaceName: z.string(),
  scopeVersion: z.number().int().positive(),
  credentialVersion: z.number().int().positive(),
  validUntil: z.number().finite(),
  targets: z
    .array(z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), title: z.string() }))
    .min(1)
    .max(SESSION_SHARE_MAX_TARGETS),
});

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
