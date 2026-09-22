import { Context, Effect } from 'effect';
import type { StreamProtocolError, TransportError, ValidationError } from '../pure/errors';

export interface EpochStreamPage {
  readonly requestOffset: string;
  readonly nextOffset: string;
  readonly upToDate: boolean;
  readonly body: Uint8Array;
}

/** One explicitly selected raw-envelope stream. Offsets are opaque and stream-local. */
export class EpochStream extends Context.Tag('@lody/e2ee-core/EpochStream')<
  EpochStream,
  {
    readonly read: (
      offset: string
    ) => Effect.Effect<EpochStreamPage, TransportError | StreamProtocolError | ValidationError>;
    readonly append: (
      offset: string,
      bytes: Uint8Array
    ) => Effect.Effect<
      'accepted' | 'conflict',
      TransportError | StreamProtocolError | ValidationError
    >;
  }
>() {}
