import { Effect } from 'effect';
import {
  makeStreamsTransport,
  StreamsAuth,
  type StreamsTransport,
  type StreamsTransportOptions,
} from 'loro-repo/effect/streams';
import type { NativeWorkspaceTransport } from './transport';
import type { LoroStreamsTokenAuth } from '../loro-streams-token/service';

/** Lazy attachment: construction has no network effects and owns no second token cache. */
export const workspaceStreamsTransport = (
  options: StreamsTransportOptions,
  auth: LoroStreamsTokenAuth
): NativeWorkspaceTransport<StreamsTransport> => ({
  kind: 'native-workspace-transport',
  make: (id) =>
    makeStreamsTransport({ ...options, id }).pipe(
      Effect.provideService(StreamsAuth, { getToken: (context) => auth(context) })
    ),
});
