import { createServer } from 'node:http';
import { Effect, Result } from 'effect';
import type { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
type Host = Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>;
type Remote = Result.Result.Success<ReturnType<Host['bind']>>;
/** Explicit synthetic pre-authenticated session. JSON never selects the principal.
 * This is a transport fixture, not the migrated challenge/bearer host. */
export function makeSyntheticMailboxHttp(remote: Remote) {
  return Effect.gen(function* () {
    const active = new Set<Promise<void>>();
    const handle = async (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse
    ) => {
      try {
        let body = '';
        for await (const bytes of request) {
          body += bytes;
          if (body.length > 64 * 1024) throw new Error('oversized body');
        }
        const input = JSON.parse(body);
        let action: Effect.Effect<unknown, unknown>;
        switch (input.op) {
          case 'status':
            action = remote.status(input.slot);
            break;
          case 'list':
            action = remote.list(input.kind, input.cursor, input.limit);
            break;
          case 'fetch':
            action = remote.fetch(input.epoch, input.cursor, input.limit).pipe(
              Effect.map((page) => ({
                ...page,
                items: page.items.map((item) => ({
                  ...item,
                  frame: Buffer.from(item.frame).toString('hex'),
                })),
              }))
            );
            break;
          case 'read':
            action = remote
              .read(input.id)
              .pipe(
                Effect.map((bytes) => (bytes === null ? null : Buffer.from(bytes).toString('hex')))
              );
            break;
          case 'put':
            action = remote
              .put(input.id, new Uint8Array(Buffer.from(input.bytes, 'hex')))
              .pipe(Effect.as({ ok: true }));
            break;
          case 'report':
            action = remote
              .report(
                new Uint8Array(Buffer.from(input.bytes, 'hex')),
                input.publication === null
                  ? undefined
                  : new Uint8Array(Buffer.from(input.publication, 'hex'))
              )
              .pipe(Effect.as({ ok: true }));
            break;
          case 'repair':
            action = remote
              .repair(input.slot, input.requestId, input.rejectedDigest)
              .pipe(Effect.as({ ok: true }));
            break;
          default:
            throw new Error('unknown operation');
        }
        const result = await Effect.runPromise(Effect.result(action));
        response.writeHead(Result.isSuccess(result) ? 200 : 403, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(Result.isSuccess(result) ? result.success : { error: 'refused' })
        );
      } catch {
        response.writeHead(400);
        response.end('{}');
      }
    };
    const server = createServer((request, response) => {
      const raw = handle(request, response);
      active.add(raw);
      void raw.finally(() => active.delete(raw));
    });
    yield* Effect.acquireRelease(
      Effect.uninterruptible(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(0, '127.0.0.1', resolve);
            })
        )
      ),
      () =>
        Effect.promise(async () => {
          const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
          server.closeAllConnections();
          await Promise.allSettled([...active]);
          await closed;
        })
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no local address');
    return `http://127.0.0.1:${address.port}/key-mailbox`;
  });
}
