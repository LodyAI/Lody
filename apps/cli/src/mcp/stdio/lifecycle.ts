import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Context, Deferred, Effect, Layer } from 'effect';
import type { Readable, Writable } from 'node:stream';

export class StdioMcpFailure extends Error {
  readonly _tag = 'StdioMcpFailure';
  constructor(
    readonly phase: 'connect' | 'input' | 'close',
    cause: unknown
  ) {
    super(`MCP stdio ${phase} failed`, { cause });
  }
}

export class StdioMcpConnection extends Context.Service<
  StdioMcpConnection,
  { readonly serve: Effect.Effect<void, StdioMcpFailure> }
>()('lody/mcp/StdioMcpConnection') {}

export const serveStdioMcp = Effect.flatMap(StdioMcpConnection, (connection) => connection.serve);

type Signals = Pick<NodeJS.Process, 'on' | 'off'>;

/** SDK/Node adapter. The command scope owns the transport and every event subscription. */
export const stdioMcpConnectionLayer = (options: {
  readonly createServer: () => McpServer;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly signals: Signals;
}) =>
  Layer.effect(
    StdioMcpConnection,
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void, StdioMcpFailure>();
      const server = options.createServer();
      const transport = new StdioServerTransport(options.stdin, options.stdout);
      const stop = () => Deferred.doneUnsafe(stopped, Effect.void);
      const failInput = (cause: Error) =>
        Deferred.doneUnsafe(stopped, Effect.fail(new StdioMcpFailure('input', cause)));
      const previousClose = server.server.onclose;
      const onclose = () => {
        try {
          previousClose?.();
        } finally {
          stop();
        }
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          server.server.onclose = onclose;
          options.stdin.on('end', stop);
          options.stdin.on('close', stop);
          options.stdin.on('error', failInput);
          options.stdout.on('error', failInput);
          options.signals.on('SIGINT', stop);
          options.signals.on('SIGTERM', stop);
          if (options.stdin.readableEnded || options.stdin.destroyed) stop();
        }),
        () =>
          // In SDK 2.0.0 stdio close synchronously detaches listeners and aborts
          // SDK requests; it performs no asynchronous I/O or drain wait.
          Effect.tryPromise({
            try: () => transport.close(),
            catch: (cause) => new StdioMcpFailure('close', cause),
          }).pipe(
            Effect.orDie,
            Effect.ensuring(
              Effect.sync(() => {
                options.stdin.off('end', stop);
                options.stdin.off('close', stop);
                options.stdin.off('error', failInput);
                options.stdout.off('error', failInput);
                options.signals.off('SIGINT', stop);
                options.signals.off('SIGTERM', stop);
                server.server.onclose = previousClose;
              })
            )
          )
      );

      return {
        serve: Effect.gen(function* () {
          if (yield* Deferred.isDone(stopped)) return yield* Deferred.await(stopped);
          // SDK start is synchronous listener installation behind a Promise.
          // Finish that installation before an interrupt can release transport.
          yield* Effect.tryPromise({
            try: () => server.connect(transport),
            catch: (cause) => new StdioMcpFailure('connect', cause),
          }).pipe(Effect.uninterruptible);
          return yield* Deferred.await(stopped);
        }),
      };
    })
  );
