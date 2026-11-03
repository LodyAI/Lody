import { sha256 } from '@noble/hashes/sha2.js';
import { hex, unhex, equalJson } from './e2ee-client-bytes';
import { Clock, Effect, Semaphore, type Scope } from 'effect';
import { z } from 'zod';
import type { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import {
  E2eeFeatureInputSchema,
  isE2eeFeatureMethod,
  isE2eeReadQuery,
  type E2eeFeatureInput,
} from '@lody/shared/e2ee-rpc';
import {
  LocalMachineRpcResponseSchema,
  type LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import {
  decodeE2eeRpcRequestBody,
  decodeE2eeRpcResponseBody,
  encodeE2eeRpcRequestBody,
  encodeE2eeRpcResponseBody,
  E2EE_RPC_MAX_FRAME_BYTES,
} from './e2ee-wire';
import { e2eeRpcResource } from './e2ee-resource';
import {
  E2EE_FEATURE_CHUNK_BYTES as chunkBytes,
  E2EE_FEATURE_MAX_REQUEST_BYTES,
  E2EE_FEATURE_MAX_RESULT_BYTES,
  encodeFeatureResponsePage,
  decodeFeatureResponsePage,
} from './e2ee-feature-parts';
import type { E2eeRpcStore } from './e2ee-store';

type OpenedFeature = {
  input: E2eeFeatureInput;
  frame: Uint8Array;
  requestId: string;
  requesterDevice: string;
  epoch: number;
  expiresAt: number;
};
type Binding = Effect.Success<ReturnType<typeof makeRealtimeContentBinding>>;
const attempt = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new Error('e2ee_feature_invalid') });
const frameSchema = z
  .string()
  .min(286)
  .max(2 * E2EE_RPC_MAX_FRAME_BYTES)
  .regex(/^(?:[0-9a-f]{2})+$/);
const digest = (frame: Uint8Array) => sha256(frame);
const key = (input: E2eeFeatureInput) => `feature:${input.requestId}`;
const canonical = (input: unknown) =>
  E2eeFeatureInputSchema.parse(JSON.parse(JSON.stringify(input)));
export { E2EE_FEATURE_MAX_RESULT_BYTES } from './e2ee-feature-parts';

/** Existing RPC wire/key domain, with a fixed product-method allowlist. No arbitrary signing. */
export function makeE2eeFeatureRpcClient(options: {
  workspaceId: string;
  requesterDevice: string;
  originals: E2eeRpcStore['Service'];
  authorizeRequest: (input: E2eeFeatureInput) => Effect.Effect<void, unknown>;
  targetSigner: (machineId: string) => Effect.Effect<string, unknown>;
  binding: (resource: string) => Effect.Effect<Binding, unknown, Scope.Scope>;
}) {
  options = Object.freeze({
    ...options,
    originals: Object.freeze({
      read: options.originals.read.bind(options.originals),
      retain: options.originals.retain.bind(options.originals),
      readResponse: options.originals.readResponse.bind(options.originals),
      retainResponse: options.originals.retainResponse.bind(options.originals),
      retainResponsePages: options.originals.retainResponsePages.bind(options.originals),
      close: options.originals.close.bind(options.originals),
    }),
  });
  const packFrames = (frames: readonly Uint8Array[]) => {
    const bytes = new Uint8Array(frames.reduce((size, frame) => size + 4 + frame.length, 0));
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (const frame of frames) {
      view.setUint32(offset, frame.length);
      bytes.set(frame, offset + 4);
      offset += 4 + frame.length;
    }
    return bytes;
  };
  const unpackFrames = (bytes: Uint8Array): string[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: string[] = [];
    for (let offset = 0; offset < bytes.length;) {
      if (offset + 4 > bytes.length || frames.length >= 128) throw new Error('e2ee_feature_frames');
      const length = view.getUint32(offset);
      offset += 4;
      if (length < 143 || length > E2EE_RPC_MAX_FRAME_BYTES || offset + length > bytes.length)
        throw new Error('e2ee_feature_frames');
      frames.push(hex(bytes.subarray(offset, offset + length)));
      offset += length;
    }
    if (!frames.length) throw new Error('e2ee_feature_frames');
    return frames;
  };
  const readPart = Effect.fnUntraced(function* (machineId: string, frameHex: string) {
    const frame = yield* attempt(() => unhex(frameSchema.parse(frameHex)));
    const binding = yield* options.binding(e2eeRpcResource(machineId));
    const opened = yield* Effect.acquireRelease(binding.openRequest(frame), (value) =>
      Effect.sync(() => value.plaintext.fill(0))
    );
    try {
      const body = yield* Effect.acquireRelease(
        attempt(() => decodeE2eeRpcRequestBody(opened.plaintext)),
        (value) => Effect.sync(() => value.params.fill(0))
      );
      try {
        if (body.method === 'session/dispatch-turn') return null;
        if (
          (!isE2eeFeatureMethod(body.method) && !isE2eeReadQuery(body.method, undefined)) ||
          body.params.length < 9 ||
          body.params.length > chunkBytes + 8
        )
          return yield* Effect.fail(new Error('e2ee_feature_method'));
        const view = new DataView(
          body.params.buffer,
          body.params.byteOffset,
          body.params.byteLength
        );
        const index = view.getUint32(0),
          count = view.getUint32(4);
        if (!count || count > 128 || index >= count)
          return yield* Effect.fail(new Error('e2ee_feature_part'));
        const bytes = yield* Effect.acquireRelease(
          Effect.sync(() => Uint8Array.from(body.params.subarray(8))),
          (value) => Effect.sync(() => value.fill(0))
        );
        return {
          frame,
          index,
          count,
          method: body.method,
          bytes,
          requestId: hex(body.requestId),
          requesterDevice: opened.signer,
          epoch: opened.epoch,
          expiresAt: body.expiresAt,
        };
      } finally {
        body.params.fill(0);
      }
    } finally {
      opened.plaintext.fill(0);
    }
  });
  const openFrames = Effect.fnUntraced(function* (
    machineId: string,
    frames: string[]
  ): Effect.fn.Return<OpenedFeature, unknown, Scope.Scope> {
    const parts: NonNullable<Effect.Success<ReturnType<typeof readPart>>>[] = [];
    let length = 0;
    for (let index = 0; index < frames.length; index++) {
      const part = yield* readPart(machineId, frames[index] ?? '');
      if (!part || part.index !== index || part.count !== frames.length)
        return yield* Effect.fail(new Error('e2ee_feature_part'));
      const first = parts[0];
      if (
        first &&
        (part.requestId !== first.requestId ||
          part.method !== first.method ||
          part.requesterDevice !== first.requesterDevice ||
          part.expiresAt !== first.expiresAt ||
          part.epoch !== first.epoch)
      )
        return yield* Effect.fail(new Error('e2ee_feature_part_binding'));
      parts.push(part);
      length += part.bytes.length;
    }
    const first = parts[0];
    if (!first || length > E2EE_FEATURE_MAX_REQUEST_BYTES)
      return yield* Effect.fail(new Error('e2ee_feature_size'));
    const bytes = yield* Effect.acquireRelease(
      Effect.sync(() => new Uint8Array(length)),
      (value) => Effect.sync(() => value.fill(0))
    );
    let offset = 0;
    try {
      for (const part of parts) {
        bytes.set(part.bytes, offset);
        offset += part.bytes.length;
      }
      const input = yield* attempt(() =>
        canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      );
      if (
        input.request.workspaceId !== options.workspaceId ||
        input.request.machineId !== machineId ||
        input.request.method !== first.method ||
        input.requestId !== first.requestId
      )
        return yield* Effect.fail(new Error('e2ee_feature_scope'));
      return {
        input,
        frame: packFrames(parts.map((part) => part.frame)),
        requestId: input.requestId,
        requesterDevice: first.requesterDevice,
        epoch: first.epoch,
        expiresAt: first.expiresAt,
      };
    } finally {
      bytes.fill(0);
      for (const part of parts) part.bytes.fill(0);
    }
  });
  const incoming = new Map<
    string,
    { frames: Map<number, string>; count: number; expiresAt: number; size: number }
  >();
  let incomingSize = 0;
  const discard = (id: string) => {
    const prior = incoming.get(id);
    if (prior) incomingSize -= prior.size;
    incoming.delete(id);
  };
  const openFeature = Effect.fnUntraced(function* (
    machineId: string,
    frameHex: string
  ): Effect.fn.Return<OpenedFeature | null | undefined, unknown, Scope.Scope> {
    const part = yield* readPart(machineId, frameHex);
    if (!part) return null;
    part.bytes.fill(0);
    const now = yield* Clock.currentTimeMillis;
    for (const [id, saved] of incoming) if (saved.expiresAt <= now) discard(id);
    if (
      part.expiresAt <= now ||
      part.expiresAt > now + (isE2eeReadQuery(part.method, undefined) ? 60_000 : 900_000)
    )
      return yield* Effect.fail(new Error('e2ee_feature_expiry'));
    if (part.count === 1) return yield* openFrames(machineId, [frameHex]);
    const id = JSON.stringify([machineId, part.requesterDevice, part.requestId]);
    let saved = incoming.get(id);
    if (!saved) {
      if (incoming.size >= 32) return yield* Effect.fail(new Error('e2ee_feature_busy'));
      saved = { frames: new Map(), count: part.count, expiresAt: part.expiresAt, size: 0 };
      incoming.set(id, saved);
    }
    const previous = saved.frames.get(part.index);
    if (
      saved.count !== part.count ||
      saved.expiresAt !== part.expiresAt ||
      (previous && previous !== frameHex)
    )
      return yield* Effect.fail(new Error('e2ee_feature_part_conflict'));
    if (!previous) {
      if (incomingSize + part.frame.length > E2EE_FEATURE_MAX_REQUEST_BYTES)
        return yield* Effect.fail(new Error('e2ee_feature_busy'));
      saved.frames.set(part.index, frameHex);
      saved.size += part.frame.length;
      incomingSize += part.frame.length;
    }
    if (saved.frames.size !== saved.count) return undefined;
    const frames = Array.from({ length: saved.count }, (_, index) => saved.frames.get(index) ?? '');
    discard(id);
    return yield* openFrames(machineId, frames);
  });
  const prepareFeature = Effect.fnUntraced(function* (input: E2eeFeatureInput) {
    const args = yield* attempt(() => canonical(input));
    yield* options.authorizeRequest(args);
    if (args.request.workspaceId !== options.workspaceId)
      return yield* Effect.fail(new Error('e2ee_feature_scope'));
    const machineId = args.request.machineId;
    const signer = yield* options.targetSigner(machineId);
    let saved = yield* options.originals.read('sent', key(args));
    if (!saved) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const bytes = yield* attempt(() => new TextEncoder().encode(JSON.stringify(args)));
          const frames: Uint8Array[] = [];
          yield* Effect.addFinalizer(() => Effect.sync(() => bytes.fill(0)));
          try {
            if (bytes.length > E2EE_FEATURE_MAX_REQUEST_BYTES)
              return yield* Effect.fail(new Error('e2ee_feature_size'));
            const count = Math.ceil(bytes.length / chunkBytes);
            const binding = yield* options.binding(e2eeRpcResource(machineId));
            for (let index = 0; index < count; index++) {
              const chunk = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
              const params = new Uint8Array(8 + chunk.length);
              yield* Effect.addFinalizer(() => Effect.sync(() => params.fill(0)));
              const view = new DataView(params.buffer);
              view.setUint32(0, index);
              view.setUint32(4, count);
              params.set(chunk, 8);
              const body = yield* attempt(() =>
                encodeE2eeRpcRequestBody({
                  requestId: unhex(args.requestId),
                  expiresAt:
                    now +
                    (isE2eeReadQuery(args.request.method, args.request.params) ? 60_000 : 900_000),
                  method: args.request.method,
                  params,
                })
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  body.fill(0);
                  params.fill(0);
                })
              );
              try {
                frames.push(yield* binding.sealRequest(body));
              } finally {
                body.fill(0);
                params.fill(0);
              }
            }
            saved = yield* options.originals.retain('sent', key(args), {
              target: machineId,
              signer,
              frame: packFrames(frames),
            });
          } finally {
            bytes.fill(0);
          }
          return undefined;
        })
      );
    }

    if (!saved) return yield* Effect.fail(new Error('e2ee_rpc_original_missing'));
    if (saved.target !== machineId || saved.signer !== signer)
      return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
    const checked = yield* openFrames(machineId, unpackFrames(saved.frame));
    if (
      !checked ||
      checked.requesterDevice !== options.requesterDevice ||
      !equalJson(checked.input, args)
    )
      return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
    yield* options.authorizeRequest(args);
    return {
      requestId: args.requestId,
      targetMachineId: machineId,
      requesterDevice: checked.requesterDevice,
      expiresAt: checked.expiresAt,
      frameHex: unpackFrames(saved.frame)[0] ?? '',
      frames: unpackFrames(saved.frame),
    };
  });
  type Opened = NonNullable<Effect.Success<ReturnType<typeof openFeature>>>;
  const resultKey = (request: Opened) => `feature-response:${hex(digest(request.frame))}`;
  const verifyPage = Effect.fnUntraced(function* (
    request: Opened,
    frame: Uint8Array,
    signer: string
  ) {
    const binding = yield* options.binding(e2eeRpcResource(request.input.request.machineId));
    const opened = yield* Effect.acquireRelease(
      binding.openResponse(frame, signer, request.epoch),
      (value) => Effect.sync(() => value.plaintext.fill(0))
    );
    try {
      const response = yield* Effect.acquireRelease(
        attempt(() => decodeE2eeRpcResponseBody(opened.plaintext)),
        (value) => Effect.sync(() => value.payload.fill(0))
      );
      try {
        if (
          hex(response.requestId) !== request.requestId ||
          hex(response.requestDigest) !== hex(digest(request.frame))
        )
          return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
        const page = yield* Effect.acquireRelease(
          attempt(() => decodeFeatureResponsePage(response)),
          (value) => Effect.sync(() => value.bytes.fill(0))
        );
        return { sequence: response.sequence, page } as const;
      } finally {
        response.payload.fill(0);
      }
    } finally {
      opened.plaintext.fill(0);
    }
  });
  const completeResponse = Effect.fnUntraced(function* (
    request: Opened,
    storageKey: string,
    signer: string,
    requireComplete = false
  ) {
    const first = yield* options.originals.readResponse(storageKey, 0);
    if (!first) return null;
    const head = yield* verifyPage(request, first, signer);
    if (head.sequence !== 0) return yield* Effect.fail(new Error('e2ee_feature_page'));
    const chunks = [head.page.bytes];
    const frames = [first];
    try {
      for (let sequence = 1; sequence < head.page.totalPages; sequence++) {
        const frame = yield* options.originals.readResponse(storageKey, sequence);
        if (!frame) {
          if (requireComplete)
            return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
          return null;
        }
        const next = yield* verifyPage(request, frame, signer);
        chunks.push(next.page.bytes);
        if (
          next.sequence !== sequence ||
          next.page.totalPages !== head.page.totalPages ||
          next.page.totalBytes !== head.page.totalBytes
        )
          return yield* Effect.fail(new Error('e2ee_feature_page'));
        frames.push(frame);
      }
      const bytes = yield* Effect.acquireRelease(
        Effect.sync(() => new Uint8Array(head.page.totalBytes)),
        (value) => Effect.sync(() => value.fill(0))
      );
      try {
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (offset !== bytes.length) return yield* Effect.fail(new Error('e2ee_feature_page'));
        const outcome = yield* attempt(() =>
          LocalMachineRpcResponseSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          )
        );
        return { frames, outcome };
      } finally {
        bytes.fill(0);
      }
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  });
  const pending = new Map<string, Uint8Array[]>();
  const sealing = Semaphore.makeUnsafe(1);
  const sealFeatureResult = (machineId: string, request: Opened, result: LocalMachineRpcResponse) =>
    sealing.withPermits(1)(
      Effect.uninterruptible(
        Effect.scoped(
          Effect.gen(function* () {
            if ((yield* options.targetSigner(machineId)) !== options.requesterDevice)
              return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
            const responseId = resultKey(request);
            const saved = yield* completeResponse(
              request,
              responseId,
              options.requesterDevice,
              true
            );
            if (saved) {
              pending.delete(responseId);
              return saved.frames;
            }
            let frames = pending.get(responseId);
            if (!frames) {
              if (pending.size >= 32) {
                // Retry retained ciphertext only. Abandoned callers must not leave
                // recoverable outbox faults consuming every later request slot.
                for (const [id, retained] of pending) {
                  const persisted = yield* options.originals.retainResponsePages(id, retained).pipe(
                    Effect.as(true),
                    Effect.catch(() => Effect.succeed(false))
                  );
                  if (persisted) {
                    pending.delete(id);
                    break;
                  }
                }
              }
              if (pending.size >= 32) return yield* Effect.fail(new Error('e2ee_feature_busy'));
              let outcome = yield* attempt(() => LocalMachineRpcResponseSchema.parse(result));
              let bytes = yield* attempt(() => new TextEncoder().encode(JSON.stringify(outcome)));
              if (bytes.length > E2EE_FEATURE_MAX_RESULT_BYTES) {
                const totalBytes = bytes.length;
                bytes.fill(0);
                outcome = {
                  ok: false,
                  error: 'Query exceeds 16 MiB. Request a smaller page or range.',
                  code: 'e2ee_query_too_large',
                  data: { truncated: true, totalBytes, maxBytes: E2EE_FEATURE_MAX_RESULT_BYTES },
                };
                bytes = new TextEncoder().encode(JSON.stringify(outcome));
              }
              frames = [];
              const binding = yield* options.binding(e2eeRpcResource(machineId));
              try {
                const count = Math.ceil(bytes.length / chunkBytes);
                for (let sequence = 0; sequence < count; sequence++) {
                  const payload = encodeFeatureResponsePage(bytes, sequence);
                  const body = encodeE2eeRpcResponseBody({
                    requestId: unhex(request.requestId),
                    requestDigest: digest(request.frame),
                    sequence,
                    kind: sequence === count - 1 ? 'success' : 'progress',
                    payload,
                  });
                  try {
                    frames.push(yield* binding.sealResponse(body, request.epoch));
                  } finally {
                    body.fill(0);
                    payload.fill(0);
                  }
                }
              } finally {
                bytes.fill(0);
              }
              pending.set(responseId, frames);
            }
            const originals = frames;
            yield* options.originals.retainResponsePages(responseId, originals);
            pending.delete(responseId);
            return originals;
          })
        )
      )
    );
  const acceptFeatureResponse = Effect.fnUntraced(function* (
    input: E2eeFeatureInput,
    frameHex: string
  ) {
    const args = yield* attempt(() => canonical(input));
    yield* options.authorizeRequest(args);
    const saved = yield* options.originals.read('sent', key(args));
    if (
      !saved ||
      saved.target !== args.request.machineId ||
      saved.signer !== (yield* options.targetSigner(saved.target))
    )
      return yield* Effect.fail(new Error('e2ee_rpc_original_missing'));
    const original = yield* openFrames(saved.target, unpackFrames(saved.frame));
    if (original.requesterDevice !== options.requesterDevice || !equalJson(original.input, args))
      return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
    const frame = yield* attempt(() => unhex(frameSchema.parse(frameHex)));
    const checked = yield* verifyPage(original, frame, saved.signer);
    checked.page.bytes.fill(0);
    yield* options.originals.retainResponse(key(args), checked.sequence, frame);
    const complete = yield* completeResponse(original, key(args), saved.signer);
    return complete?.outcome ?? null;
  });
  return {
    verifyFeatureRequest: (request: Opened) =>
      Effect.scoped(
        openFrames(request.input.request.machineId, unpackFrames(request.frame)).pipe(Effect.asVoid)
      ),
    clearFeatureParts: () => {
      incoming.clear();
      incomingSize = 0;
    },
    retainFeatureRequest: (machineId: string, request: Opened) =>
      options.originals.retain(
        'received',
        JSON.stringify(['feature', request.requesterDevice, request.requestId]),
        { target: machineId, signer: request.requesterDevice, frame: request.frame }
      ),
    readFeatureResponse: (request: Opened) =>
      sealing.withPermits(1)(
        Effect.uninterruptible(
          Effect.scoped(
            Effect.gen(function* () {
              const responseId = resultKey(request);
              const complete = yield* completeResponse(
                request,
                responseId,
                options.requesterDevice,
                true
              );
              if (complete) {
                pending.delete(responseId);
                return complete.frames;
              }
              const retained = pending.get(responseId);
              if (!retained) return [];
              yield* options.originals.retainResponsePages(responseId, retained);
              pending.delete(responseId);
              return retained;
            })
          )
        )
      ),
    prepareFeature: (input: E2eeFeatureInput) => Effect.scoped(prepareFeature(input)),
    openFeature: (machineId: string, frameHex: string) =>
      Effect.scoped(openFeature(machineId, frameHex)),
    sealFeatureResult: (machineId: string, request: Opened, result: LocalMachineRpcResponse) =>
      Effect.scoped(sealFeatureResult(machineId, request, result)),
    acceptFeatureResponse: (input: E2eeFeatureInput, frameHex: string) =>
      Effect.scoped(acceptFeatureResponse(input, frameHex)),
  };
}
