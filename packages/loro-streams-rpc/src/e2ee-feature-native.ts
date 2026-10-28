import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Clock, Effect, type Scope } from 'effect';
import { z } from 'zod';
import type { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import {
  E2eeFeatureInputSchema,
  isE2eeFeatureMethod,
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
import type { E2eeRpcOriginals } from './e2ee-node-store';

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
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const frameSchema = z
  .string()
  .min(286)
  .max(2 * E2EE_RPC_MAX_FRAME_BYTES)
  .regex(/^(?:[0-9a-f]{2})+$/);
const digest = (frame: Uint8Array) => Uint8Array.from(createHash('sha256').update(frame).digest());
const key = (input: E2eeFeatureInput) => `feature:${input.requestId}`;
const canonical = (input: unknown) =>
  E2eeFeatureInputSchema.parse(JSON.parse(JSON.stringify(input)));
const chunkBytes = 256 * 1024;
export const E2EE_FEATURE_MAX_RESULT_BYTES = 32 * 1024 * 1024;

/** Existing RPC wire/key domain, with a fixed product-method allowlist. No arbitrary signing. */
export function makeE2eeFeatureRpcNative(options: {
  workspaceId: string;
  requesterDevice: string;
  originals: E2eeRpcOriginals;
  targetSigner: (machineId: string) => Effect.Effect<string, unknown>;
  binding: (resource: string) => Effect.Effect<Binding, unknown, Scope.Scope>;
}) {
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
    const frame = yield* attempt(() =>
      Uint8Array.from(Buffer.from(frameSchema.parse(frameHex), 'hex'))
    );
    const binding = yield* options.binding(e2eeRpcResource(machineId));
    const opened = yield* binding.openRequest(frame);
    try {
      const body = yield* attempt(() => decodeE2eeRpcRequestBody(opened.plaintext));
      try {
        if (body.method === 'session/dispatch-turn') return null;
        if (
          !isE2eeFeatureMethod(body.method) ||
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
        return {
          frame,
          index,
          count,
          method: body.method,
          bytes: Uint8Array.from(body.params.subarray(8)),
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
          part.expiresAt !== first.expiresAt)
      )
        return yield* Effect.fail(new Error('e2ee_feature_part_binding'));
      parts.push(part);
      length += part.bytes.length;
    }
    const first = parts[0];
    if (!first || length > E2EE_FEATURE_MAX_RESULT_BYTES)
      return yield* Effect.fail(new Error('e2ee_feature_size'));
    const bytes = new Uint8Array(length);
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
    if (part.expiresAt <= now || part.expiresAt > now + 900_000)
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
      if (incomingSize + part.frame.length > E2EE_FEATURE_MAX_RESULT_BYTES)
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
    if (args.request.workspaceId !== options.workspaceId)
      return yield* Effect.fail(new Error('e2ee_feature_scope'));
    const machineId = args.request.machineId;
    const signer = yield* options.targetSigner(machineId);
    let saved = yield* attempt(() => options.originals.read('sent', key(args)));
    if (!saved) {
      const now = yield* Clock.currentTimeMillis;
      const bytes = yield* attempt(() => new TextEncoder().encode(JSON.stringify(args)));
      const frames: Uint8Array[] = [];
      try {
        if (bytes.length > E2EE_FEATURE_MAX_RESULT_BYTES)
          return yield* Effect.fail(new Error('e2ee_feature_size'));
        const count = Math.ceil(bytes.length / chunkBytes);
        const binding = yield* options.binding(e2eeRpcResource(machineId));
        for (let index = 0; index < count; index++) {
          const chunk = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
          const params = new Uint8Array(8 + chunk.length);
          const view = new DataView(params.buffer);
          view.setUint32(0, index);
          view.setUint32(4, count);
          params.set(chunk, 8);
          const body = yield* attempt(() =>
            encodeE2eeRpcRequestBody({
              requestId: Uint8Array.from(Buffer.from(args.requestId, 'hex')),
              expiresAt: now + 900_000,
              method: args.request.method,
              params,
            })
          );
          try {
            frames.push(yield* binding.sealRequest(body));
          } finally {
            body.fill(0);
            params.fill(0);
          }
        }
        saved = yield* attempt(() =>
          options.originals.retain('sent', key(args), {
            target: machineId,
            signer,
            frame: packFrames(frames),
          })
        );
      } finally {
        bytes.fill(0);
      }
    }

    if (saved.target !== machineId || saved.signer !== signer)
      return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
    const checked = yield* openFrames(machineId, unpackFrames(saved.frame));
    if (
      !checked ||
      checked.requesterDevice !== options.requesterDevice ||
      !isDeepStrictEqual(checked.input, args)
    )
      return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
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
  const sealFeatureResult = Effect.fnUntraced(function* (
    machineId: string,
    request: Opened,
    result: LocalMachineRpcResponse
  ) {
    const bytes = yield* attempt(() =>
      new TextEncoder().encode(JSON.stringify(LocalMachineRpcResponseSchema.parse(result)))
    );
    try {
      if (bytes.length > E2EE_FEATURE_MAX_RESULT_BYTES)
        return yield* Effect.fail(new Error('e2ee_feature_result_too_large'));
      const binding = yield* options.binding(e2eeRpcResource(machineId));
      const frames: Uint8Array[] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        const body = yield* attempt(() =>
          encodeE2eeRpcResponseBody({
            requestId: Uint8Array.from(Buffer.from(request.requestId, 'hex')),
            requestDigest: digest(request.frame),
            sequence: frames.length,
            kind: offset + chunkBytes >= bytes.length ? 'success' : 'progress',
            payload: bytes.subarray(offset, offset + chunkBytes),
          })
        );
        try {
          frames.push(yield* binding.sealResponse(body, request.epoch));
        } finally {
          body.fill(0);
        }
      }
      return frames;
    } finally {
      bytes.fill(0);
    }
  });
  const acceptFeatureResponse = Effect.fnUntraced(function* (
    input: E2eeFeatureInput,
    frameHex: string
  ) {
    const args = yield* attempt(() => canonical(input));
    const saved = yield* attempt(() => options.originals.read('sent', key(args)));
    if (
      !saved ||
      saved.target !== args.request.machineId ||
      saved.signer !== (yield* options.targetSigner(saved.target))
    )
      return yield* Effect.fail(new Error('e2ee_rpc_original_missing'));
    const original = yield* openFrames(saved.target, unpackFrames(saved.frame));
    if (
      !original ||
      original.requesterDevice !== options.requesterDevice ||
      !isDeepStrictEqual(original.input, args)
    )
      return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
    const frame = yield* attempt(() =>
      Uint8Array.from(Buffer.from(frameSchema.parse(frameHex), 'hex'))
    );
    const binding = yield* options.binding(e2eeRpcResource(saved.target));
    const opened = yield* binding.openResponse(frame, saved.signer, original.epoch);
    try {
      const response = yield* attempt(() => decodeE2eeRpcResponseBody(opened.plaintext));
      try {
        if (
          hex(response.requestId) !== args.requestId ||
          hex(response.requestDigest) !== hex(digest(saved.frame)) ||
          response.sequence >= E2EE_FEATURE_MAX_RESULT_BYTES / chunkBytes ||
          response.kind === 'error' ||
          response.payload.length > chunkBytes
        )
          return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
        yield* attempt(() => options.originals.retainResponse(key(args), response.sequence, frame));
        return {
          sequence: response.sequence,
          final: response.kind === 'success',
          bytes: Uint8Array.from(response.payload),
        };
      } finally {
        response.payload.fill(0);
      }
    } finally {
      opened.plaintext.fill(0);
    }
  });
  return {
    clearFeatureParts: () => {
      incoming.clear();
      incomingSize = 0;
    },
    prepareFeature: (input: E2eeFeatureInput) => Effect.scoped(prepareFeature(input)),
    openFeature: (machineId: string, frameHex: string) =>
      Effect.scoped(openFeature(machineId, frameHex)),
    sealFeatureResult: (machineId: string, request: Opened, result: LocalMachineRpcResponse) =>
      Effect.scoped(sealFeatureResult(machineId, request, result)),
    acceptFeatureResponse: (input: E2eeFeatureInput, frameHex: string) =>
      Effect.scoped(acceptFeatureResponse(input, frameHex)),
  };
}
