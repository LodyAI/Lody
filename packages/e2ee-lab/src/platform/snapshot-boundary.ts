import { Effect, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { StreamsRecordBoundaryPort } from '@lody/e2ee-core/host';
import { LabContentGatewayError } from './content-gateway';
import { makeLabSdkOwner } from './sdk-owner';
import { readBoundedBody } from './bounded-body';
function printableOffset(offset: string) {
  if (offset.length < 1 || offset.length > 3950) return false;
  for (let index = 0; index < offset.length; index++) {
    const code = offset.charCodeAt(index);
    if (code < 33 || code > 126) return false;
  }
  return true;
}
const Reply = Schema.Struct({
  offset: Schema.String,
  boundary: Schema.Boolean,
  notAfterHead: Schema.Boolean,
  head: Schema.String,
});
/** Ordinary HTTP metadata query. No backend tables, payload decoding or client
 * arithmetic on opaque offsets. The request/body lease outlives cancellation. */
export const makeLabRiverrunSnapshotBoundary = Effect.fnUntraced(function* (input: {
  readonly baseUrl: string;
  readonly genesis: Bytes.GenesisHash;
  readonly model: 'loro' | 'flock';
  readonly fetch?: typeof fetch;
}) {
  const model = input.model,
    transport = input.fetch ?? fetch;
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const origin = yield* Effect.try({
    try: () => new URL(input.baseUrl),
    catch: () => new LabContentGatewayError({ status: 400 }),
  });
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !['loro', 'flock'].includes(model)
  )
    return yield* new LabContentGatewayError({ status: 400 });
  const stream = `${Buffer.from(genesis.toBytes()).toString('hex')}/${model}`;
  const native = yield* makeLabSdkOwner(({ signal }) => ({ signal, close: async () => undefined }));
  const port: StreamsRecordBoundaryPort = {
    query: ({ stream: requestedStream, offset }) => {
      if (requestedStream !== stream || !printableOffset(offset))
        return Effect.fail(new LabContentGatewayError({ status: 400 }));
      return native
        .invoke(async ({ signal }) => {
          const url = new URL(`/ds/${stream}/record-boundary`, origin);
          url.searchParams.set('offset', offset);
          const response = await transport(url, { signal, redirect: 'error' });
          const body = response.body ? await readBoundedBody(response.body, 16 * 1024) : undefined;
          if (response.status === 400) return null;
          if (!response.ok || !body) throw new LabContentGatewayError({ status: 502 });
          const reply = Schema.decodeUnknownSync(Reply)(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
          );
          if (reply.offset !== offset || !reply.head || reply.head.length > 3950)
            throw new LabContentGatewayError({ status: 502 });
          return reply;
        })
        .pipe(
          Effect.mapError(() => new LabContentGatewayError({ status: 502 })),
          Effect.flatMap((reply) =>
            reply === null
              ? Effect.fail(new LabContentGatewayError({ status: 409 }))
              : Effect.succeed(reply)
          )
        );
    },
  };
  return (offset: string) =>
    port
      .query({ stream, offset })
      .pipe(Effect.map((reply) => reply.boundary && reply.notAfterHead));
});
