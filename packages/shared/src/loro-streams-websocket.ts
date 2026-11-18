/** Connection auth context from the loro-ds-v1 multiplexer. */
export type LoroStreamsWebSocketAuthContext = {
  readonly reason: 'initial' | 'reauth' | 'renew';
  readonly previousToken?: string;
};

/** Only an explicit true/1 enables WS. Explicit false overrides the environment. */
export const isLoroStreamsWebSocketEnabled = (explicit?: boolean, environment?: unknown): boolean =>
  explicit ?? (environment === '1' || environment === 'true');

/** Structural compatibility with the forthcoming SDK; no unavailable dependency required. */
export type LoroStreamsWebSocketOptions = {
  readonly enabled: true;
  readonly url: string;
  readonly authPoolKey: string;
  readonly auth?: (context: LoroStreamsWebSocketAuthContext) => string | Promise<string>;
};

/** Keep the key absent for legacy SDKs and HTTP-only callers unless opted in. */
export const loroStreamsWebSocketOptions = (
  enabled: boolean,
  url: string,
  authPoolKey: string,
  auth?: LoroStreamsWebSocketOptions['auth']
): { webSocket?: LoroStreamsWebSocketOptions } =>
  enabled ? { webSocket: { enabled: true, url, authPoolKey, ...(auth ? { auth } : {}) } } : {};
