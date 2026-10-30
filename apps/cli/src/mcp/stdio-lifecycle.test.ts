import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/server';
import { Effect, Exit, Fiber, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import { serveStdioMcp, stdioMcpConnectionLayer } from './stdio/lifecycle';

function fixture(server = new McpServer({ name: 'test', version: '1' })) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  const connected = Promise.withResolvers<void>();
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    connected.resolve();
  };
  const program = serveStdioMcp.pipe(
    Effect.provide(stdioMcpConnectionLayer({ createServer: () => server, stdin, stdout, signals }))
  );
  const expectReleased = (options?: { readonly started?: boolean }) => {
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
    // SDK 2.1.0 close() keeps exactly one tagged stdout error listener
    // (`swallowsErrorsAfterClose`) after start(), so a late write is not an
    // unhandled 'error'. A transport that never started adds nothing.
    // Command-owned listeners must still be gone in both cases.
    const stdoutErrors = stdout.listeners('error');
    const commandOwned = stdoutErrors.filter(
      (listener) =>
        !Object.getOwnPropertySymbols(listener).some(
          (symbol) => symbol.description === 'swallowsErrorsAfterClose'
        )
    );
    expect(commandOwned).toEqual([]);
    expect(stdoutErrors).toHaveLength(options?.started === false ? 0 : 1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(server.server.transport).toBeUndefined();
  };
  return { stdin, stdout, signals, server, connected: connected.promise, program, expectReleased };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

function response(stream: PassThrough, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    let buffered = '';
    const onData = (data: Buffer) => {
      buffered += data.toString();
      let end: number;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message.id === id) {
          stream.off('data', onData);
          resolve(message);
        }
      }
    };
    stream.on('data', onData);
  });
}

function send(stream: PassThrough, value: unknown) {
  stream.write(`${JSON.stringify(value)}\n`);
}

describe('stdio MCP command lifetime', () => {
  it('keeps the application usable for a real tool request after connection, then closes on EOF', async () => {
    const application = makeApplicationRuntime(Layer.empty, {
      recover: Effect.failCause,
      project: (cause) => cause,
    });
    const f = fixture();
    f.server.registerTool('owner', { description: 'synthetic lifecycle probe' }, async () => {
      if (application.isClosing()) throw new Error('Presence application owner unavailable');
      const value = await application.runtime.runPromise(Effect.succeed('owner available'));
      return { content: [{ type: 'text', text: value }] };
    });
    // Same command-then-application-close ordering as index.ts.
    const command = (async () => {
      try {
        await Effect.runPromise(f.program);
      } finally {
        await application.closeLegacy();
      }
    })();
    const prematureExit = command.then(() => {
      throw new Error('MCP command ended before the client finished');
    });
    await f.connected;
    const initialized = response(f.stdout, 1);
    send(f.stdin, initialize);
    await Promise.race([initialized, prematureExit]);
    send(f.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = response(f.stdout, 2);
    send(f.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'owner', arguments: {} },
    });
    expect(await Promise.race([result, prematureExit])).toMatchObject({
      result: { content: [{ text: 'owner available' }] },
    });
    expect(application.isClosing()).toBe(false);
    f.stdin.end();
    await command;
    expect(application.isReleased()).toBe(true);
    f.expectReleased();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('releases transport on %s', async (signal) => {
    const f = fixture();
    const command = Effect.runPromise(f.program);
    await f.connected;
    f.signals.emit(signal);
    f.signals.emit(signal);
    await command;
    f.expectReleased();
  });

  it('releases transport when its owning fiber is interrupted', async () => {
    const f = fixture();
    const fiber = Effect.runFork(f.program);
    await f.connected;
    await Effect.runPromise(Fiber.interrupt(fiber));
    f.expectReleased();
  });

  it('cleans up a partially connected SDK server after startup failure', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    const connect = server.connect.bind(server);
    const failure = new Error('synthetic startup failure');
    server.connect = async (transport) => {
      await connect(transport);
      throw failure;
    };
    const f = fixture(server);
    const exit = await Effect.runPromiseExit(f.program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toMatchObject([{ error: { phase: 'connect', cause: failure } }]);
    f.expectReleased();
  });

  it('reports input failure and releases all subscriptions', async () => {
    const f = fixture();
    const command = Effect.runPromiseExit(f.program);
    await f.connected;
    const failure = new Error('synthetic input failure');
    f.stdin.emit('error', failure);
    const exit = await command;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toMatchObject([{ error: { phase: 'input', cause: failure } }]);
    f.expectReleased();
  });

  it('SDK close signals cancellation to an in-flight tool before the command ends', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    f.server.registerTool('pending', {}, async (extra) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        extra.mcpReq.signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            resolve();
          },
          { once: true }
        );
      });
      return { content: [] };
    });
    const command = Effect.runPromise(f.program);
    await f.connected;
    const initialized = response(f.stdout, 1);
    send(f.stdin, initialize);
    await initialized;
    send(f.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(f.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pending', arguments: {} },
    });
    await entered.promise;
    f.signals.emit('SIGTERM');
    await command;
    await cancelled.promise;
    f.expectReleased();
  });

  it('finishes when the SDK transport closes without EOF', async () => {
    const f = fixture();
    const command = Effect.runPromise(f.program);
    await f.connected;
    await f.server.close();
    await command;
    f.expectReleased();
  });

  it('preserves both startup and cleanup failures', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    const connect = server.connect.bind(server);
    server.connect = async (transport) => {
      const close = transport.close.bind(transport);
      transport.close = async () => {
        await close();
        throw new Error('synthetic release failure');
      };
      await connect(transport);
      throw new Error('synthetic acquire failure');
    };
    const f = fixture(server);
    const exit = await Effect.runPromiseExit(f.program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toMatchObject([
        { error: { phase: 'connect' } },
        { defect: { phase: 'close' } },
      ]);
    }
    f.expectReleased();
  });

  it('does not start a transport on an already destroyed input', async () => {
    const f = fixture();
    f.stdin.destroy();
    await Effect.runPromise(f.program);
    f.expectReleased({ started: false });
  });
});
