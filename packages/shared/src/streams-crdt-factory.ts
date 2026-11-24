import {
  StreamsCrdt,
  type JsonObject,
  type StreamsCrdtOptions,
  type StreamsCrdtShardUrlsOptions,
  type StreamsWebSocketOptions,
} from '@loro-dev/streams-crdt';
import type { LoroStreamsWebSocketOptions } from './loro-streams-websocket';
import { recordStreamsHttpFallback } from './streams-transport-diagnostics';

export type CreateStreamsCrdtWebSocketPolicy =
  | StreamsWebSocketOptions
  | LoroStreamsWebSocketOptions
  | 'disabled';

export type CreateStreamsCrdtShardUrlsPolicy = StreamsCrdtShardUrlsOptions | 'disabled';

export type CreateStreamsCrdtOptions<TVersion extends JsonObject> = Omit<
  StreamsCrdtOptions<TVersion>,
  'webSocket' | 'shardUrls'
> & {
  readonly webSocket: CreateStreamsCrdtWebSocketPolicy;
  readonly shardUrls: CreateStreamsCrdtShardUrlsPolicy;
};

/**
 * Single governed construction entry for `StreamsCrdt`.
 * Callers must explicitly pass WebSocket and shard URL policies (`'disabled'` allowed)
 * so durable streams cannot ship HTTP-only or unsharded by omission.
 */
export function createStreamsCrdt<TVersion extends JsonObject>(
  options: CreateStreamsCrdtOptions<TVersion>
): StreamsCrdt<TVersion> {
  const { webSocket, shardUrls, ...rest } = options;
  if (webSocket === 'disabled' || webSocket.enabled === false) {
    recordStreamsHttpFallback('no-ws');
  }
  return new StreamsCrdt({
    ...rest,
    ...(webSocket !== 'disabled' ? { webSocket: webSocket as StreamsWebSocketOptions } : {}),
    ...(shardUrls !== 'disabled' ? { shardUrls } : {}),
  });
}
