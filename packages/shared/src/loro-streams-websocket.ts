/** Connection auth context from the loro-ds-v1 multiplexer (`connect`) and Repo shim (`initial`). */
export type LoroStreamsWebSocketAuthContext = {
  readonly reason: 'connect' | 'initial' | 'reauth' | 'renew';
  readonly previousToken?: string;
};

/** Only an explicit true/1 enables WS. Explicit false overrides the environment. */
export const isLoroStreamsWebSocketEnabled = (explicit?: boolean, environment?: unknown): boolean =>
  explicit ?? (environment === '1' || environment === 'true');

/** WebSocket transport options shared across @loro-dev/streams-crdt and loro-repo. */
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
