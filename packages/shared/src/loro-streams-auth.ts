import { z } from 'zod';
import { getServerNow } from './time-sync';

export const LoroStreamsTokenRequestSchema = z.object({
  rejectedToken: z.string().min(1).max(16384).optional(),
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const LoroStreamsTokenResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
  gatewayBaseUrl: z.string().url().optional(),
  // Hosted shard topology (bare host suffix, e.g. "streams.example.com"):
  // when present, clients spread presence/control/write traffic across the
  // sibling subdomains under this suffix instead of piling every SSE stream
  // onto the gateway origin. Validated again client-side before use.
  shardHostSuffix: z.string().min(1).max(253).optional(),
});

export type LoroStreamsTokenRequest = z.infer<typeof LoroStreamsTokenRequestSchema>;
export type LoroStreamsTokenResponse = z.infer<typeof LoroStreamsTokenResponseSchema>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type CachedLoroStreamsToken = {
  token: string;
  expiresAtMs: number;
  gatewayBaseUrl?: string;
  shardHostSuffix?: string;
};

export const LORO_STREAMS_TOKEN_REFRESH_SKEW_MS = 30_000;
export const LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX = 'lody:loroStreamsToken';

const LORO_STREAMS_TOKEN_STORAGE_VERSION = 2;
const LORO_STREAMS_TOKEN_STORAGE_ALGORITHM = 'AES-GCM';
const LORO_STREAMS_TOKEN_STORAGE_IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CachedLoroStreamsTokenSchema = z.object({
  token: z.string().min(1),
  expiresAtMs: z.number().finite(),
  gatewayBaseUrl: z.string().url().optional(),
  shardHostSuffix: z.string().min(1).max(253).optional(),
});

const EncryptedLoroStreamsTokenStorageSchema = z.object({
  version: z.literal(LORO_STREAMS_TOKEN_STORAGE_VERSION),
  algorithm: z.literal(LORO_STREAMS_TOKEN_STORAGE_ALGORITHM),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

const LegacyPlaintextLoroStreamsTokenStorageSchema = z.object({
  token: z.string(),
  expiresAtMs: z.number(),
});

type MinimalStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function isMinimalStorage(value: unknown): value is MinimalStorage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    'getItem' in value &&
    'setItem' in value &&
    'removeItem' in value &&
    typeof value.getItem === 'function' &&
    typeof value.setItem === 'function' &&
    typeof value.removeItem === 'function'
  );
}

function getTokenStorageKey(workspaceId: string): string {
  return `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${workspaceId}`;
}

function getLocalStorage(): MinimalStorage | undefined {
  try {
    const storage = Reflect.get(globalThis, 'localStorage') as unknown;
    if (isMinimalStorage(storage)) {
      return storage;
    }
  } catch {
    // ignore unavailable localStorage
  }
  return undefined;
}

function getSubtleCrypto() {
  try {
    return globalThis.crypto?.subtle;
  } catch {
    return undefined;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(`${normalized}${padding}`);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveTokenStorageKey(workspaceId: string, authToken: string) {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    return null;
  }

  // This is obfuscating-at-rest for localStorage, not an XSS boundary: deriving
  // from the current auth token lets refreshes reuse the cache while token
  // rotation naturally makes old ciphertext unreadable.
  const keyMaterial = textEncoder.encode(
    `lody:loroStreamsToken:v${LORO_STREAMS_TOKEN_STORAGE_VERSION}:${workspaceId}:${authToken}`
  );
  const digest = await subtle.digest('SHA-256', keyMaterial);
  return await subtle.importKey(
    'raw',
    digest,
    { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptCachedTokenForStorage(
  workspaceId: string,
  authToken: string,
  token: CachedLoroStreamsToken
): Promise<string | null> {
  const subtle = getSubtleCrypto();
  const key = await deriveTokenStorageKey(workspaceId, authToken);
  if (!subtle || !key) {
    return null;
  }

  const iv = new Uint8Array(LORO_STREAMS_TOKEN_STORAGE_IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = textEncoder.encode(JSON.stringify(token));
  const ciphertext = await subtle.encrypt(
    { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM, iv: toArrayBuffer(iv) },
    key,
    plaintext
  );

  return JSON.stringify({
    version: LORO_STREAMS_TOKEN_STORAGE_VERSION,
    algorithm: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

async function decryptCachedTokenFromStorage(
  workspaceId: string,
  authToken: string,
  encrypted: z.infer<typeof EncryptedLoroStreamsTokenStorageSchema>
): Promise<CachedLoroStreamsToken | null> {
  const subtle = getSubtleCrypto();
  const key = await deriveTokenStorageKey(workspaceId, authToken);
  const iv = base64UrlToBytes(encrypted.iv);
  const ciphertext = base64UrlToBytes(encrypted.ciphertext);
  if (!subtle || !key || !iv || !ciphertext) {
    return null;
  }

  try {
    const plaintext = await subtle.decrypt(
      { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM, iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext)
    );
    const parsedJson = JSON.parse(textDecoder.decode(plaintext));
    const parsed = CachedLoroStreamsTokenSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readCachedTokenFromStorage(
  workspaceId: string,
  authToken: string
): Promise<CachedLoroStreamsToken | null> {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  const storageKey = getTokenStorageKey(workspaceId);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    const encrypted = EncryptedLoroStreamsTokenStorageSchema.safeParse(parsed);
    if (!encrypted.success) {
      if (LegacyPlaintextLoroStreamsTokenStorageSchema.safeParse(parsed).success) {
        storage.removeItem(storageKey);
      }
      return null;
    }

    const token = await decryptCachedTokenFromStorage(workspaceId, authToken, encrypted.data);
    if (!token) {
      storage.removeItem(storageKey);
    }
    return token;
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // ignore
    }
    return null;
  }
}

async function writeCachedTokenToStorage(
  workspaceId: string,
  authToken: string,
  token: CachedLoroStreamsToken,
  shouldWrite: () => boolean
): Promise<void> {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    const encrypted = await encryptCachedTokenForStorage(workspaceId, authToken, token);
    if (!encrypted) {
      return;
    }
    if (shouldWrite()) storage.setItem(getTokenStorageKey(workspaceId), encrypted);
  } catch {
    // ignore cache write failures, including quota and WebCrypto errors
  }
}

function clearCachedTokenFromStorage(workspaceId: string): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(getTokenStorageKey(workspaceId));
  } catch {
    // ignore
  }
}

export type LoroStreamsTokenProviderEvent =
  | {
      type: 'cache-hit';
      workspaceId: string;
      expiresInMs: number;
      hasGatewayBaseUrl: boolean;
    }
  | {
      type: 'cache-miss';
      workspaceId: string;
      reason: 'missing' | 'expired-or-stale';
    }
  | {
      type: 'fetch-start';
      workspaceId: string;
      endpoint: string;
    }
  | {
      type: 'fetch-success';
      workspaceId: string;
      expiresInMs: number;
      hasGatewayBaseUrl: boolean;
    }
  | {
      type: 'fetch-failure';
      workspaceId: string;
      status?: number;
      error: unknown;
    }
  | {
      type: 'in-flight-reuse';
      workspaceId: string;
    }
  | {
      type: 'invalidate';
      workspaceId: string;
      reason: 'manual' | 'unauthorized';
    };

export const buildLoroStreamsTokenEndpoint = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/g, '')}/api/loro-streams/token`;

/**
 * Thrown when `/api/loro-streams/token` rejects the caller's long-lived
 * credentials as 401/403. Direct `getToken()` callers should treat this as
 * fatal: the CLI token has been revoked (or was never valid for this
 * workspace) and no amount of retrying will recover it. Transport auth
 * callbacks convert this to `undefined` so streams-crdt can surface
 * `auth_failed` instead of retryable `auth_provider_error`.
 */
export class LoroStreamsTokenAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'LoroStreamsTokenAuthError';
  }
}

export function createLoroStreamsTokenProvider(options: {
  endpoint: string;
  workspaceId: string;
  authToken:
    | string
    | null
    | undefined
    | (() => Promise<string | null | undefined> | string | null | undefined);
  fetchImpl?: FetchLike;
  refreshSkewMs?: number;
  onEvent?: (event: LoroStreamsTokenProviderEvent) => void;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshSkewMs = options.refreshSkewMs ?? LORO_STREAMS_TOKEN_REFRESH_SKEW_MS;
  // State belongs to this provider and one resolved credential, never a global cache.
  const storageNamespace = JSON.stringify([options.endpoint, options.workspaceId]);
  let credential: string | null | undefined;
  let initialized = false;
  let generation = 0;
  let cached: CachedLoroStreamsToken | null = null;
  let inFlight: Promise<CachedLoroStreamsToken> | null = null;
  let terminalAuthFailure: LoroStreamsTokenAuthError | null = null;
  let rejectedToken: string | undefined;
  let hydrate = true;

  const emit = (event: LoroStreamsTokenProviderEvent): void => options.onEvent?.(event);
  const resolveAuthToken = async () =>
    typeof options.authToken === 'function' ? await options.authToken() : options.authToken;

  const reset = (reason: 'manual' | 'unauthorized') => {
    cached = null;
    hydrate = false;
    clearCachedTokenFromStorage(storageNamespace);
    if (reason === 'manual') {
      generation++;
      inFlight = null;
      terminalAuthFailure = null;
      rejectedToken = undefined;
    }
    emit({ type: 'invalidate', workspaceId: options.workspaceId, reason });
  };

  const ensureFreshToken = async (failedToken?: string): Promise<CachedLoroStreamsToken> => {
    // Even an in-memory hit must belong to the currently resolved login.
    const authToken = await resolveAuthToken();
    if (!initialized || credential !== authToken) {
      if (initialized) reset('manual');
      else clearCachedTokenFromStorage(options.workspaceId); // Remove the old endpoint-agnostic cache.
      initialized = true;
      credential = authToken;
      hydrate = true;
    }
    if (!authToken) {
      throw new LoroStreamsTokenAuthError('Missing Loro Streams token provider auth token', 401);
    }
    if (terminalAuthFailure) throw terminalAuthFailure;
    // A callback from an older stream cannot invalidate a newer cached token.
    // Never discard the refresh another callback has already started.
    if (failedToken && cached?.token === failedToken) {
      rejectedToken = failedToken;
      reset('unauthorized');
    }
    if (inFlight) {
      emit({ type: 'in-flight-reuse', workspaceId: options.workspaceId });
      return inFlight;
    }
    if (cached && getServerNow() < cached.expiresAtMs - refreshSkewMs) {
      emit({
        type: 'cache-hit',
        workspaceId: options.workspaceId,
        expiresInMs: cached.expiresAtMs - getServerNow(),
        hasGatewayBaseUrl: typeof cached.gatewayBaseUrl === 'string',
      });
      return cached;
    }

    const epoch = generation;
    const isCurrent = () => generation === epoch && credential === authToken;
    const assertCurrentGeneration = () => {
      if (!isCurrent()) throw new Error('Loro Streams token request superseded by an auth change');
    };
    const assertCurrent = async () => {
      if (!isCurrent() || (await resolveAuthToken()) !== authToken || !isCurrent()) {
        throw new Error('Loro Streams token request superseded by an auth change');
      }
    };
    // One HTTP round trip. `sentRejectedToken` is fixed when the body is built,
    // so a rejection that arrives later cannot be carried by this request.
    const requestToken = async (
      sentRejectedToken: string | undefined
    ): Promise<CachedLoroStreamsToken> => {
      emit({ type: 'fetch-start', workspaceId: options.workspaceId, endpoint: options.endpoint });
      const startedAt = getServerNow();
      const response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: LoroStreamsTokenRequestSchema.shape.workspaceId.parse(options.workspaceId),
          ...(sentRejectedToken ? { rejectedToken: sentRejectedToken } : {}),
        } satisfies LoroStreamsTokenRequest),
      });
      await assertCurrent();
      assertCurrentGeneration();
      if (!response.ok) {
        // Do not include a backend response body: it may contain credentials.
        if (response.status === 401 || response.status === 403) {
          const error = new LoroStreamsTokenAuthError(
            `Loro Streams token authorization failed (status=${response.status})`,
            response.status
          );
          terminalAuthFailure = error;
          throw error;
        }
        throw new Error(`Failed to fetch Loro Streams token (status=${response.status})`);
      }
      const parsed = LoroStreamsTokenResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid Loro Streams token response');
      await assertCurrent();
      assertCurrentGeneration();
      return {
        token: parsed.data.token,
        expiresAtMs: startedAt + parsed.data.expiresIn * 1000,
        gatewayBaseUrl: parsed.data.gatewayBaseUrl,
        shardHostSuffix: parsed.data.shardHostSuffix,
      };
    };
    const promise = (async (): Promise<CachedLoroStreamsToken> => {
      if (hydrate) {
        hydrate = false;
        const stored = await readCachedTokenFromStorage(storageNamespace, authToken);
        await assertCurrent();
        assertCurrentGeneration();
        if (
          stored &&
          stored.token !== rejectedToken &&
          getServerNow() < stored.expiresAtMs - refreshSkewMs
        ) {
          cached = stored;
          return stored;
        }
      }
      emit({
        type: 'cache-miss',
        workspaceId: options.workspaceId,
        reason: cached ? 'expired-or-stale' : 'missing',
      });
      try {
        const sent = rejectedToken;
        let nextToken = await requestToken(sent);
        if (rejectedToken !== undefined && rejectedToken !== sent) {
          // An unauthorized callback joined this refresh after its body was
          // already sent. If the issuer handed back the very token the gateway
          // rejected, spend exactly one more request that does carry
          // `rejectedToken`. Every caller awaiting this promise shares that
          // retry, so a fan-out of callbacks still costs one extra round trip.
          if (nextToken.token === rejectedToken) {
            nextToken = await requestToken(rejectedToken);
          }
        }
        // Encryption uses the credential that authorized this request, never a
        // later login. A stale encrypted write cannot be decrypted by that login.
        // The gate also re-reads the rejection marker, because it runs
        // synchronously just before `setItem` while the encryption above it is
        // several async WebCrypto calls long: an unauthorized callback landing
        // inside that window clears storage first, and an unguarded write would
        // put the rejected JWT back for the next process to hydrate.
        // `reset('unauthorized')` deliberately keeps the generation, so
        // `isCurrent()` alone cannot see it.
        await writeCachedTokenToStorage(
          storageNamespace,
          authToken,
          nextToken,
          () => isCurrent() && nextToken.token !== rejectedToken
        );
        await assertCurrent();
        assertCurrentGeneration();
        cached = nextToken;
        // The marker only survives while the provider is still serving the
        // rejected JWT, so a refresh that predates the rejection cannot clear it.
        if (nextToken.token !== rejectedToken) rejectedToken = undefined;
        emit({
          type: 'fetch-success',
          workspaceId: options.workspaceId,
          expiresInMs: nextToken.expiresAtMs - getServerNow(),
          hasGatewayBaseUrl: typeof nextToken.gatewayBaseUrl === 'string',
        });
        return nextToken;
      } catch (error) {
        emit({
          type: 'fetch-failure',
          workspaceId: options.workspaceId,
          status: error instanceof LoroStreamsTokenAuthError ? error.status : undefined,
          error,
        });
        throw error;
      }
    })();
    inFlight = promise;
    try {
      return await promise;
    } finally {
      if (inFlight === promise) inFlight = null;
    }
  };

  return {
    getToken: async (): Promise<string> => (await ensureFreshToken()).token,
    invalidate: (reason: 'manual' | 'unauthorized' = 'manual'): void => {
      if (reason === 'unauthorized') rejectedToken = cached?.token ?? rejectedToken;
      reset(reason);
    },
    getGatewayBaseUrl: (): string | undefined => cached?.gatewayBaseUrl,
    getShardHostSuffix: (): string | undefined => cached?.shardHostSuffix,
    /** Each stream callback tracks the token it received, so delayed failures
     * cannot invalidate a replacement obtained by another stream callback. */
    createAuthCallback: (): ((context?: {
      reason: string;
      previousToken?: string;
    }) => Promise<string | undefined>) => {
      let lastToken: string | undefined;
      return async (context) => {
        try {
          const current = await ensureFreshToken(
            context?.reason === 'unauthorized' ? (context.previousToken ?? lastToken) : undefined
          );
          lastToken = current.token;
          return current.token;
        } catch (error) {
          if (error instanceof LoroStreamsTokenAuthError) return undefined;
          throw error;
        }
      };
    },
  };
}
