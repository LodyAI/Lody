import { Socket } from 'node:net';
import type { AdbServerClient } from '@yume-chan/adb';
import { ReadableStream, MaybeConsumable } from '@yume-chan/stream-extra';

/** Socket destruction must settle pending reads as well as `closed`. */
export function createAdbConnector(
  signal: AbortSignal,
  port = 5037
): AdbServerClient.ServerConnector & { close(): Promise<void> } {
  const sockets = new Map<Socket, Promise<void>>();
  return {
    async connect(options) {
      signal.throwIfAborted();
      const abortSignal = AbortSignal.any([
        signal,
        ...(options?.signal ? [options.signal as AbortSignal] : []),
      ]);
      const socket = new Socket({ signal: abortSignal });
      const closed = new Promise<undefined>((resolve) =>
        socket.once('close', () => {
          sockets.delete(socket);
          resolve(undefined);
        })
      );
      sockets.set(socket, closed);
      if (options?.unref) socket.unref();
      let ended = false;
      const readable = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const finish = (error?: Error) => {
              if (ended) return;
              ended = true;
              if (error) controller.error(error);
              else controller.close();
            };
            socket.on('data', (data) => {
              if (ended) return;
              controller.enqueue(data);
              if ((controller.desiredSize ?? 0) <= 0) socket.pause();
            });
            socket.on('end', () => finish());
            socket.on('error', (error) => finish(error));
            socket.on('close', () => finish());
          },
          pull() {
            socket.resume();
          },
          cancel() {
            ended = true;
            socket.destroy();
            return closed;
          },
        },
        { highWaterMark: 65536, size: (chunk) => chunk.byteLength }
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = (error: Error) => {
            socket.off('connect', ready);
            reject(error);
          };
          const ready = () => {
            socket.off('error', fail);
            resolve();
          };
          socket.once('error', fail);
          socket.once('connect', ready);
          socket.connect({ host: '127.0.0.1', port });
        });
      } catch (error) {
        socket.destroy();
        await closed;
        throw error;
      }
      socket.setNoDelay(true);
      return {
        readable,
        closed,
        writable: new MaybeConsumable.WritableStream<Uint8Array>({
          write: (chunk) =>
            new Promise<void>((resolve, reject) =>
              socket.write(chunk, (error) => (error ? reject(error) : resolve()))
            ),
          close() {
            socket.end();
          },
          abort() {
            socket.destroy();
          },
        }),
        close: async () => {
          socket.destroy();
          await closed;
        },
      };
    },
    addReverseTunnel: () => {
      throw Error('Reverse ADB tunnels are disabled');
    },
    removeReverseTunnel: () => {},
    clearReverseTunnels: () => {},
    async close() {
      const pending = [...sockets.values()];
      for (const socket of sockets.keys()) socket.destroy();
      await Promise.all(pending);
    },
  };
}
