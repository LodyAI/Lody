import { z } from 'zod';
import { Clock, Context, Data, Effect, Layer } from 'effect';
import { getServerTimeOffset } from './time-sync';

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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CachedLoroStreamsToken = {
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

export type MinimalStorage = {
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
  readonly _tag = 'LoroStreamsTokenAuthError';
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'LoroStreamsTokenAuthError';
  }
}

export class LoroStreamsTokenError extends Data.TaggedError('LoroStreamsTokenError')<{
  readonly reason: 'credential' | 'http' | 'response' | 'superseded' | 'closed';
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {}

export type LoroStreamsTokenFailure = LoroStreamsTokenError | LoroStreamsTokenAuthError;

/** One instance per provider: I/O ownership must not be shared between providers. */
export class LoroStreamsTokenPorts extends Context.Service<
  LoroStreamsTokenPorts,
  {
    readonly credential: Effect.Effect<string | null | undefined, LoroStreamsTokenFailure>;
    readonly request: (
      endpoint: string,
      credential: string,
      request: LoroStreamsTokenRequest
    ) => Effect.Effect<{ status: number; body?: unknown }, LoroStreamsTokenFailure>;
    readonly now: Effect.Effect<number>;
    readonly storage: MinimalStorage | undefined;
    readonly encrypt: (
      namespace: string,
      credential: string,
      token: CachedLoroStreamsToken
    ) => Effect.Effect<string | null>;
    readonly decrypt: (
      namespace: string,
      credential: string,
      raw: string
    ) => Effect.Effect<CachedLoroStreamsToken | null>;
    readonly hasPending: () => boolean;
    readonly cleanup: Effect.Effect<void>;
  }
>()('@lody/shared/LoroStreamsTokenPorts') {}

export { LoroStreamsTokenReleaseFailed } from './loro-streams-token/io';
import { makeLoroStreamsRawIo } from './loro-streams-token/io';

/** Fetch and WebCrypto are adapted once; refresh/cache orchestration stays native. */
export const makeLoroStreamsTokenWebPorts = (options: {
  credential: Effect.Effect<string | null | undefined, LoroStreamsTokenFailure>;
  fetchImpl?: FetchLike;
  storage?: MinimalStorage;
  cleanupTimeoutMs?: number;
  /** Registered only by the deprecated facade, never by native consumers. */
  resolveCredentialLegacy?: (signal: AbortSignal) => PromiseLike<string | null | undefined>;
}) => {
  const raw = makeLoroStreamsRawIo(options.cleanupTimeoutMs ?? 5_000);
  const ioError = (reason: 'http' | 'credential') => (cause: unknown) =>
    new LoroStreamsTokenError({
      reason,
      message: `Loro Streams ${reason} request failed`,
      cause,
    });
  return LoroStreamsTokenPorts.of({
    credential: options.resolveCredentialLegacy
      ? raw.fromPromise('credential', options.resolveCredentialLegacy, ioError('credential'))
      : options.credential,
    request: (endpoint, credential, request) =>
      Effect.suspend(() => {
        let status: number | undefined;
        let releasingBody = false;
        return raw.fromPromise(
          'HTTP',
          async (signal) => {
            const response = await (options.fetchImpl ?? fetch)(endpoint, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${credential}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(request),
              signal,
            });
            status = response.status;
            // Error bodies can contain secrets. Body consumption remains owned by
            // the same abortable raw operation as fetch.
            if (!response.ok) {
              releasingBody = true;
              await response.body?.cancel();
              releasingBody = false;
              return { status: response.status };
            }
            return { status: response.status, body: await response.json() };
          },
          (cause) =>
            new LoroStreamsTokenError({
              reason: 'http',
              message: 'Loro Streams HTTP/body request failed',
              cause,
              status,
            }),
          () => releasingBody
        );
      }),
    now: Clock.currentTimeMillis.pipe(Effect.map((now) => now + getServerTimeOffset())),
    storage: options.storage ?? getLocalStorage(),
    encrypt: (namespace, credential, token) =>
      raw
        .fromPromise(
          'WebCrypto encrypt',
          () => encryptCachedTokenForStorage(namespace, credential, token),
          () => null
        )
        .pipe(Effect.catch(() => Effect.succeed(null))),
    decrypt: (namespace, credential, value) =>
      raw
        .fromPromise(
          'WebCrypto decrypt',
          async () => {
            const encrypted = EncryptedLoroStreamsTokenStorageSchema.safeParse(JSON.parse(value));
            return encrypted.success
              ? await decryptCachedTokenFromStorage(namespace, credential, encrypted.data)
              : null;
          },
          () => null
        )
        .pipe(Effect.catch(() => Effect.succeed(null))),
    hasPending: raw.hasPending,
    cleanup: raw.cleanup,
  });
};

export const LoroStreamsTokenWebLive = (
  options: Parameters<typeof makeLoroStreamsTokenWebPorts>[0]
) => Layer.sync(LoroStreamsTokenPorts, () => makeLoroStreamsTokenWebPorts(options));

export const loroStreamsTokenStorageKey = getTokenStorageKey;
export {
  makeLoroStreamsTokenProvider,
  LoroStreamsTokens,
  LoroStreamsTokensLive,
  LoroStreamsTokenShutdownFailed,
  describeLoroStreamsTokenCause,
} from './loro-streams-token/service';
export type {
  LoroStreamsTokenProvider,
  LoroStreamsTokenProviderOptions,
  LoroStreamsAuthContext,
  LoroStreamsTokenAuth,
  LoroStreamsTokenReadFailure,
  LoroStreamsTokenFailureKind,
  LoroStreamsTokenErrorContext,
  LoroStreamsTokenHealth,
} from './loro-streams-token/service';
export { createLoroStreamsTokenProviderLegacy } from './loro-streams-token/legacy';
