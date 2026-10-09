import { Context, Effect } from 'effect';
import type {
  StorageError,
  StreamProtocolError,
  TransportError,
  ValidationError,
} from '../pure/errors';

export interface KeyOutboxTransaction {
  readonly load: (id: string) => Effect.Effect<Uint8Array | null, StorageError | ValidationError>;
  readonly save: (
    id: string,
    bytes: Uint8Array
  ) => Effect.Effect<void, StorageError | ValidationError>;
}

export class KeyOutbox extends Context.Service<
  KeyOutbox,
  {
    readonly exclusive: <A, E, R>(
      work: (tx: KeyOutboxTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | StorageError | ValidationError, R>;
  }
>()('@lody/e2ee-core/KeyOutbox') {}

/** Central-mailbox integration: put stores encrypted envelopes; read observes exact
 * stored bytes. Neither proves recipient installation. Installation reports and
 * recipient/epoch work lists use the separate KeyMailboxRemote protocol.
 */
export class KeyDeliveryRemote extends Context.Service<
  KeyDeliveryRemote,
  {
    readonly put: (
      id: string,
      bytes: Uint8Array
    ) => Effect.Effect<void | 'conflict', TransportError | StreamProtocolError | ValidationError>;
    readonly read: (
      id: string
    ) => Effect.Effect<Uint8Array | null, TransportError | StreamProtocolError | ValidationError>;
  }
>()('@lody/e2ee-core/KeyDeliveryRemote') {}
