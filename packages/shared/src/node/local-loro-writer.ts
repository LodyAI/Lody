import { Effect, Layer } from 'effect';
import { LocalLoroWriterTurn } from '../local-loro-writer';

/** Node poll/check turn boundary; cancellation removes the actual Immediate. */
export const LocalLoroWriterNodeTurn = Layer.succeed(LocalLoroWriterTurn, {
  next: Effect.callback<void>((resume) => {
    const handle = setImmediate(() => resume(Effect.void));
    return Effect.sync(() => clearImmediate(handle));
  }),
});

import type net from 'node:net';
import type { LocalLoroDataPlaneServerConnection } from '../local-loro-data-plane-server';

/** The single Node socket write/drain boundary. Wire serialization is not logging. */
export const makeNodeLocalLoroWriterConnection = (
  id: string,
  socket: Pick<net.Socket, 'destroyed' | 'write' | 'on' | 'off'>
): LocalLoroDataPlaneServerConnection => ({
  id,
  send: (message) => !socket.destroyed && socket.write(`${JSON.stringify(message)}\n`),
  onDrain: (listener) => {
    socket.on('drain', listener);
    return () => {
      socket.off('drain', listener);
    };
  },
});
