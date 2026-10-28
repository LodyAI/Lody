import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Clock, Effect, Semaphore, type Scope } from 'effect';
import { z } from 'zod';
import type { LedgerView } from '@lody/e2ee-core/protocol';
import type { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import {
  isE2eeReadQuery,
  E2EE_READ_QUERY_METHODS,
  type E2eeQueryInput,
  type E2eeQueryResult,
  type E2eePreparedDispatch,
} from '@lody/shared/e2ee-rpc';
import { E2eeRpcOriginals } from './e2ee-node-store';
import { e2eeRpcResource } from './e2ee-resource';
import { LoroStreamsRpcRequestSchema } from './rpc';
import {
  decodeE2eeRpcRequestBody,
  decodeE2eeRpcResponseBody,
  decodeE2eeRpcErrorBody,
  encodeE2eeRpcRequestBody,
  encodeE2eeRpcResponseBody,
  encodeE2eeRpcErrorBody,
  E2EE_RPC_MAX_FRAME_BYTES,
} from './e2ee-wire';

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const digest = (value: Uint8Array) => Uint8Array.from(createHash('sha256').update(value).digest());
const attempt = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new Error('e2ee_query_invalid') });
const json = (value: Uint8Array): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const inputSchema = z
  .object({
    queryId: z.string().min(1).max(128),
    method: z.enum(E2EE_READ_QUERY_METHODS),
    params: z.unknown(),
  })
  .strict();
const outcomeSchema = z.union([
  z.object({ result: z.unknown() }).strict(),
  z
    .object({
      error: z
        .object({
          code: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          message: z.string().max(256),
          data: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
]);
const normalize = (input: E2eeQueryInput) =>
  inputSchema.parse(JSON.parse(JSON.stringify(inputSchema.parse(input))));
const key = (input: E2eeQueryInput) => JSON.stringify(['query', input.queryId]);
const pageBytes = 512 * 1024;
const maxPages = 32;
const pageSchema = z
  .object({
    version: z.literal(0),
    totalPages: z.number().int().min(1).max(maxPages),
    totalBytes: z
      .number()
      .int()
      .min(1)
      .max(pageBytes * maxPages),
    data: z.string().max(4 * Math.ceil(pageBytes / 3)),
  })
  .strict();
const decodePage = (body: ReturnType<typeof decodeE2eeRpcResponseBody>) => {
  const page = pageSchema.parse(json(body.payload));
  const bytes = Buffer.from(page.data, 'base64');
  if (
    bytes.toString('base64') !== page.data ||
    bytes.length > pageBytes ||
    body.sequence >= page.totalPages ||
    (body.kind === 'success') !== (body.sequence === page.totalPages - 1) ||
    page.totalPages !== Math.ceil(page.totalBytes / pageBytes) ||
    bytes.length !== Math.min(pageBytes, page.totalBytes - body.sequence * pageBytes)
  ) {
    bytes.fill(0);
    throw new Error('e2ee_query_page');
  }
  return { ...page, bytes };
};
type Binding = Effect.Success<ReturnType<typeof makeRealtimeContentBinding>>;

/** Trusted-host read integration. Uses the existing method codecs and response outbox;
 * no execution claim or renderer-selected signer/deadline. Pages are one immutable outcome. */
export function makeE2eeReadQueries(
  options: {
    workspaceId: string;
    requesterDevice: string;
    originals: E2eeRpcOriginals;
    ledger: () => Effect.Effect<LedgerView, unknown>;
    binding: (resource: string) => Effect.Effect<Binding, unknown, Scope.Scope>;
  },
  targetSigner: (machineId: string) => Effect.Effect<string, unknown>
) {
  const sealing = Semaphore.makeUnsafe(1);
  const pending = new Map<string, Uint8Array[]>();
  const unhex = (value: string) => {
    if (
      typeof value !== 'string' ||
      value.length < 286 ||
      value.length > E2EE_RPC_MAX_FRAME_BYTES * 2 ||
      !/^(?:[0-9a-f]{2})+$/.test(value)
    )
      throw new Error('e2ee_query_frame');
    return Uint8Array.from(Buffer.from(value, 'hex'));
  };
  const permitted = Effect.fnUntraced(function* () {
    const state = (yield* options.ledger()).inspectState();
    const self = state.devices.get(options.requesterDevice);
    if (!self || self.kind === 'recovery' || !state.members.has(hex(self.membershipId.toBytes())))
      return yield* Effect.fail(new Error('e2ee_query_denied'));
    return undefined;
  });
  const openQuery = Effect.fnUntraced(function* (machineId: string, frameHex: string) {
    const frame = yield* attempt(() => unhex(frameHex));
    const binding = yield* options.binding(e2eeRpcResource(machineId));
    const opened = yield* binding.openRequest(frame);
    try {
      const body = yield* attempt(() => decodeE2eeRpcRequestBody(opened.plaintext));
      try {
        const input = yield* attempt(() =>
          inputSchema.parse({
            ...z
              .object({ queryId: z.string(), params: z.unknown() })
              .strict()
              .parse(json(body.params)),
            method: body.method,
          })
        );
        if (!isE2eeReadQuery(input.method, input.params))
          return yield* Effect.fail(new Error('e2ee_query_method'));
        // Reuse the production method wire schema before any handler can run.
        yield* attempt(() =>
          LoroStreamsRpcRequestSchema.parse({
            jsonrpc: '2.0',
            id: hex(body.requestId),
            rpcVersion: '1',
            workspaceId: options.workspaceId,
            machineId,
            replyTo: 'host-read-query',
            sentAt: 0,
            expiresAt: body.expiresAt,
            method: input.method,
            params: input.params,
          })
        );
        return {
          input,
          requestId: hex(body.requestId),
          expiresAt: body.expiresAt,
          requesterDevice: opened.signer,
          epoch: opened.epoch,
          frame,
        };
      } finally {
        body.params.fill(0);
      }
    } finally {
      opened.plaintext.fill(0);
    }
  });
  type Opened = Effect.Success<ReturnType<typeof openQuery>>;
  const responseKey = (request: Opened) => `query-response:${hex(digest(request.frame))}`;
  const readPages = (request: Opened) => {
    const pages: Uint8Array[] = [];
    for (let sequence = 0; sequence < maxPages; sequence++) {
      const frame = options.originals.readResponse(responseKey(request), sequence);
      if (!frame) break;
      pages.push(frame);
    }
    return pages;
  };
  const prepareQuery = (machineId: string, input: E2eeQueryInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* permitted();
        const args = yield* attempt(() => normalize(input));
        const signer = yield* targetSigner(machineId);
        let saved = yield* attempt(() => options.originals.read('sent', key(args)));
        if (!saved) {
          const now = yield* Clock.currentTimeMillis;
          const body = yield* attempt(() =>
            encodeE2eeRpcRequestBody({
              requestId: randomBytes(16),
              expiresAt: now + 60_000,
              method: args.method,
              params: encode({ queryId: args.queryId, params: args.params }),
            })
          );
          try {
            const binding = yield* options.binding(e2eeRpcResource(machineId));
            const frame = yield* binding.sealRequest(body);
            saved = yield* attempt(() =>
              options.originals.retain('sent', key(args), { target: machineId, signer, frame })
            );
          } finally {
            body.fill(0);
          }
        }
        if (saved.target !== machineId || saved.signer !== signer)
          return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
        const original = yield* openQuery(machineId, hex(saved.frame));
        if (
          original.requesterDevice !== options.requesterDevice ||
          !isDeepStrictEqual(original.input, args)
        )
          return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
        return {
          requestId: original.requestId,
          targetMachineId: machineId,
          frameHex: hex(saved.frame),
          requesterDevice: options.requesterDevice,
          expiresAt: original.expiresAt,
        } satisfies E2eePreparedDispatch;
      })
    );
  const queryResponse = (machineId: string, request: Opened, outcome: E2eeQueryResult) =>
    sealing.withPermits(1)(
      Effect.uninterruptible(
        Effect.scoped(
          Effect.gen(function* () {
            if ((yield* targetSigner(machineId)) !== options.requesterDevice)
              return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
            const responseId = responseKey(request);
            const saved = yield* attempt(() => readPages(request));
            if (saved.length) return saved;
            let frames = pending.get(responseId);
            if (!frames) {
              if (pending.size >= 32) return yield* Effect.fail(new Error('e2ee_query_capacity'));
              let result: E2eeQueryResult = yield* attempt(() => outcomeSchema.parse(outcome));
              let payload = encode(result);
              if (payload.length > pageBytes * maxPages) {
                result = {
                  error: {
                    code: 'e2ee_query_too_large',
                    message: 'Query exceeds 16 MiB. Request a smaller page or range.',
                    data: {
                      truncated: true,
                      totalBytes: payload.length,
                      maxBytes: pageBytes * maxPages,
                    },
                  },
                };
                payload.fill(0);
                payload = encode(result);
              }
              const binding = yield* options.binding(e2eeRpcResource(machineId));
              frames = [];
              try {
                const count = result.error ? 1 : Math.max(1, Math.ceil(payload.length / pageBytes));
                for (let sequence = 0; sequence < count; sequence++) {
                  const chunk = result.error
                    ? encodeE2eeRpcErrorBody({
                        code: result.error.code,
                        detail: encode(result.error),
                      })
                    : encode({
                        version: 0,
                        totalPages: count,
                        totalBytes: payload.length,
                        data: Buffer.from(
                          payload.subarray(sequence * pageBytes, (sequence + 1) * pageBytes)
                        ).toString('base64'),
                      });
                  const body = encodeE2eeRpcResponseBody({
                    requestId: Buffer.from(request.requestId, 'hex'),
                    requestDigest: digest(request.frame),
                    kind: result.error ? 'error' : sequence === count - 1 ? 'success' : 'progress',
                    sequence,
                    payload: chunk,
                  });
                  try {
                    frames.push(yield* binding.sealResponse(body, request.epoch));
                  } finally {
                    body.fill(0);
                    chunk.fill(0);
                  }
                }
              } finally {
                payload.fill(0);
              }
              pending.set(responseId, frames);
            }
            const originals = frames;
            yield* attempt(() => options.originals.retainResponsePages(responseId, originals));
            pending.delete(responseId);
            return originals;
          })
        )
      )
    );
  const acceptQueryResponse = (machineId: string, input: E2eeQueryInput, frameHex: string) =>
    Effect.scoped(
      Effect.gen(function* (): Effect.fn.Return<E2eeQueryResult | null, unknown, Scope.Scope> {
        yield* permitted();
        const args = yield* attempt(() => normalize(input));
        const saved = yield* attempt(() => options.originals.read('sent', key(args)));
        if (
          !saved ||
          saved.target !== machineId ||
          saved.signer !== (yield* targetSigner(machineId))
        )
          return yield* Effect.fail(new Error('e2ee_rpc_original_missing'));
        const request = yield* openQuery(machineId, hex(saved.frame));
        if (
          request.requesterDevice !== options.requesterDevice ||
          !isDeepStrictEqual(request.input, args)
        )
          return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
        const binding = yield* options.binding(e2eeRpcResource(machineId));
        const checked = Effect.fnUntraced(function* (frame: Uint8Array) {
          const opened = yield* binding.openResponse(frame, saved.signer, request.epoch);
          try {
            const response = yield* attempt(() => decodeE2eeRpcResponseBody(opened.plaintext));
            if (
              hex(response.requestId) !== request.requestId ||
              hex(response.requestDigest) !== hex(digest(saved.frame)) ||
              response.sequence >= maxPages
            ) {
              response.payload.fill(0);
              return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
            }
            try {
              if (response.kind !== 'error')
                (yield* attempt(() => decodePage(response))).bytes.fill(0);
              return response;
            } catch (cause) {
              response.payload.fill(0);
              throw cause;
            }
          } finally {
            opened.plaintext.fill(0);
          }
        });
        const frame = yield* attempt(() => unhex(frameHex));
        const response = yield* checked(frame);
        try {
          yield* attempt(() =>
            options.originals.retainResponse(responseKey(request), response.sequence, frame)
          );
        } finally {
          response.payload.fill(0);
        }
        const chunks: Uint8Array[] = [];
        let expected: { totalPages: number; totalBytes: number } | undefined;
        try {
          for (let sequence = 0; sequence < maxPages; sequence++) {
            const part = yield* attempt(() =>
              options.originals.readResponse(responseKey(request), sequence)
            );
            if (!part) return null;
            const body = yield* checked(part);
            chunks.push(body.payload);
            if (body.sequence !== sequence)
              return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
            if (body.kind === 'error') {
              if (sequence !== 0) return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
              const failure = yield* attempt(() => decodeE2eeRpcErrorBody(body.payload));
              try {
                const value = yield* attempt(() =>
                  outcomeSchema.parse({ error: json(failure.detail) })
                );
                if (!('error' in value) || value.error.code !== failure.code)
                  return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
                return value;
              } finally {
                failure.detail.fill(0);
              }
            }
            const page = yield* attempt(() => decodePage(body));
            if (
              expected &&
              (page.totalBytes !== expected.totalBytes || page.totalPages !== expected.totalPages)
            ) {
              page.bytes.fill(0);
              return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
            }
            expected = page;
            body.payload.fill(0);
            chunks[chunks.length - 1] = page.bytes;
            if (body.kind === 'success') {
              const plaintext = Buffer.concat(chunks);
              try {
                const value = yield* attempt(() => outcomeSchema.parse(json(plaintext)));
                if (!('result' in value))
                  return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
                return value;
              } finally {
                plaintext.fill(0);
              }
            }
          }
          return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
        } finally {
          for (const chunk of chunks) chunk.fill(0);
        }
      })
    );
  return {
    prepareQuery,
    openQuery: (machineId: string, frame: string) => Effect.scoped(openQuery(machineId, frame)),
    queryResponse,
    retainQueryRequest: (machineId: string, request: Opened) =>
      attempt(() =>
        options.originals.retain(
          'received',
          JSON.stringify(['query-request', request.requesterDevice, request.requestId]),
          { target: machineId, signer: request.requesterDevice, frame: request.frame }
        )
      ),
    acceptQueryResponse,
    readQueryResponse: (request: Opened) => attempt(() => readPages(request)),
  };
}
