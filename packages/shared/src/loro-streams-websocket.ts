/** Connection auth context from the loro-ds-v1 multiplexer (`connect`) and Repo shim (`initial`). */
export type LoroStreamsWebSocketAuthContext = {
  readonly reason: 'connect' | 'initial' | 'reauth' | 'renew';
  readonly previousToken?: string;
};

const WEB_SOCKET_OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * WS is on by default. The environment turns it off only with `0`, `false`, `off` or `no`
 * (any case); an explicit boolean overrides the environment. Off, every transport stays on
 * HTTP (SSE or long-poll), as before WS existed.
 */
export const isLoroStreamsWebSocketEnabled = (explicit?: boolean, environment?: unknown): boolean =>
  explicit ??
  !(typeof environment === 'string' && WEB_SOCKET_OFF_VALUES.has(environment.trim().toLowerCase()));

/** WebSocket transport options shared across @loro-dev/streams-crdt and loro-repo. */
export type LoroStreamsWebSocketOptions = {
  readonly enabled: true;
  readonly url: string;
  readonly authPoolKey: string;
  readonly auth?: (context: LoroStreamsWebSocketAuthContext) => string | Promise<string>;
};

/** Keep the key absent for legacy SDKs and HTTP-only callers when WS is off. */
export const loroStreamsWebSocketOptions = (
  enabled: boolean,
  url: string,
  authPoolKey: string,
  auth?: LoroStreamsWebSocketOptions['auth']
): { webSocket?: LoroStreamsWebSocketOptions } =>
  enabled ? { webSocket: { enabled: true, url, authPoolKey, ...(auth ? { auth } : {}) } } : {};
