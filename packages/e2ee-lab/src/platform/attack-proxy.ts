import { createServer } from 'node:http';
import { Effect } from 'effect';
import { readBoundedBody } from './bounded-body';
/** Native loopback delivery adapter. The parent retains control of response gates
 * while the real child is awaiting HTTP. No credentials enter attack observations. */
export const makeLabActorProxy = Effect.fnUntraced(function* (input: {
  readonly origin: string;
  readonly fetch: typeof fetch;
}) {
  const controller = new AbortController(),
    active = new Set<Promise<void>>();
  let closed = false;
  const server = createServer((request, response) => {
    if (closed) {
      response.writeHead(503);
      response.end();
      return;
    }
    const raw = (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        if ((size += bytes.length) > 16 * 1024 * 1024) throw new Error('proxy-budget');
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(name))
          headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const reply = await input.fetch(new URL(request.url!, input.origin), {
        method: request.method,
        headers,
        body: body.length ? body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const bytes = reply.body
        ? await readBoundedBody(reply.body, 16 * 1024 * 1024)
        : new Uint8Array();
      if (!bytes) throw new Error('proxy-budget');
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      response.end(Buffer.from(bytes));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    active.add(raw);
    void raw.then(() => active.delete(raw));
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
        closed = true;
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        await Promise.allSettled([...active]);
      })
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy-address');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
});
