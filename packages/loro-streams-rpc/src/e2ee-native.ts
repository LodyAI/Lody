import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Clock, Effect, type Scope } from 'effect';
import { z } from 'zod';
import type { LedgerView } from '@lody/e2ee-core/protocol';
import type { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import {
  decodeE2eeRpcRequestBody,
  decodeE2eeRpcResponseBody,
  encodeE2eeRpcRequestBody,
  encodeE2eeRpcResponseBody,
  E2EE_RPC_MAX_FRAME_BYTES,
} from './e2ee-wire';
import { E2eeRpcOriginals } from './e2ee-node-store';
import { e2eeRpcResource, e2eeRpcResponseStream } from './e2ee-resource';
import type {
  E2eeDispatchInput,
  E2eePreparedDispatch,
  E2eeDispatchAck,
} from '@lody/shared/e2ee-rpc';

const inputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  userTurnId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  timestamp: z.string().max(128),
  inputConfig: z.unknown(),
});
// Compare the wire DTO, not JS-only optional fields. Composer objects retain
// undefined properties that JSON omits; both send and ACK lookup must agree with
// the already signed original without regenerating its ID or ciphertext.
const normalizeInput = (input: unknown) =>
  inputSchema.parse(JSON.parse(JSON.stringify(inputSchema.parse(input))));
const ackSchema = z.object({
  type: z.literal('session/dispatch-turn_response'),
  sessionId: z.string(),
  userTurnId: z.string(),
  accepted: z.boolean(),
  disposition: z.enum(['accepted', 'duplicate', 'already-terminal', 'not-owned', 'error']),
});
const attempt = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new Error('e2ee_rpc_invalid') });
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const unhex = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length < 286 ||
    value.length > 2 * E2EE_RPC_MAX_FRAME_BYTES ||
    !/^(?:[0-9a-f]{2})+$/.test(value)
  )
    throw new Error('e2ee_rpc_frame');
  return Uint8Array.from(Buffer.from(value, 'hex'));
};
const key = (args: Pick<E2eeDispatchInput, 'sessionId' | 'userTurnId'>) =>
  JSON.stringify([args.sessionId, args.userTurnId]);
export const e2eeRpcDigest = (frame: Uint8Array) =>
  Uint8Array.from(createHash('sha256').update(frame).digest());
type Binding = Effect.Success<ReturnType<typeof makeRealtimeContentBinding>>;

/** Native workspace adapter. Purpose-bound preparation persists one original before
 * the caller may transmit it. Reopen/retry verifies and reuses those bytes. No
 * renderer-supplied signer, method, deadline, private export or arbitrary sign API. */
export function makeE2eeRpcNative(options: {
  workspaceId: string;
  requesterDevice: string;
  originals: E2eeRpcOriginals;
  /** Native host policy preflight. The recipient still resolves the actual project and checks at start. */
  authorizeTarget?: (machineId: string) => Effect.Effect<boolean, unknown>;
  ledger: () => Effect.Effect<LedgerView, unknown>;
  binding: (resource: string) => Effect.Effect<Binding, unknown, Scope.Scope>;
}) {
  const targetSigner = Effect.fnUntraced(function* (machineId: string) {
    const view = yield* options.ledger();
    const state = view.inspectState();
    const own = state.devices.get(options.requesterDevice);
    const candidates = [...state.devices.entries()].filter(
      ([, device]) => device.kind === 'machine' && device.machineId === machineId
    );
    const candidate = candidates[0];
    if (!own || candidates.length !== 1 || !candidate)
      return yield* Effect.fail(new Error('e2ee_machine_not_owned'));
    return candidate[0];
  });
  const open = Effect.fnUntraced(function* (targetMachineId: string, frame: Uint8Array) {
    if (frame.length > E2EE_RPC_MAX_FRAME_BYTES)
      return yield* Effect.fail(new Error('e2ee_rpc_frame'));
    const binding = yield* options.binding(e2eeRpcResource(targetMachineId));
    const opened = yield* binding.openRequest(frame);
    try {
      const body = yield* attempt(() => decodeE2eeRpcRequestBody(opened.plaintext));
      try {
        if (body.method !== 'session/dispatch-turn')
          return yield* Effect.fail(new Error('e2ee_rpc_method'));
        const args = yield* attempt(() =>
          inputSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.params))
          )
        );
        const timestamp = Date.parse(args.timestamp);
        if (
          !Number.isSafeInteger(timestamp) ||
          timestamp < 0 ||
          body.expiresAt > timestamp + 900_000
        )
          return yield* Effect.fail(new Error('e2ee_rpc_expiry'));
        return {
          args,
          requesterDevice: opened.signer,
          epoch: opened.epoch,
          requestId: hex(body.requestId),
          expiresAt: body.expiresAt,
        };
      } finally {
        body.params.fill(0);
      }
    } finally {
      opened.plaintext.fill(0);
    }
  });
  const prepareDispatch = (
    machineId: string,
    input: E2eeDispatchInput,
    authorizeTarget = options.authorizeTarget
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const args = yield* attempt(() => normalizeInput(input));
        const signer = yield* targetSigner(machineId);
        const state = (yield* options.ledger()).inspectState();
        const sameOwner = state.devices
          .get(options.requesterDevice)
          ?.membershipId.equals(state.devices.get(signer)!.membershipId);
        if (
          !sameOwner &&
          !(yield* (authorizeTarget?.(machineId) ?? Effect.succeed(false)).pipe(
            Effect.catch(() => Effect.succeed(false))
          ))
        )
          return yield* Effect.fail(new Error('e2ee_machine_not_shared'));
        let saved = yield* attempt(() => options.originals.read('sent', key(args)));
        if (!saved) {
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = Math.min(now + 900_000, Date.parse(args.timestamp) + 900_000);
          const body = yield* attempt(() =>
            encodeE2eeRpcRequestBody({
              requestId: randomBytes(16),
              expiresAt,
              method: 'session/dispatch-turn',
              params: new TextEncoder().encode(JSON.stringify(args)),
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
        if (
          saved.target !== machineId ||
          saved.signer !== signer ||
          saved.signer !== (yield* targetSigner(machineId))
        )
          return yield* Effect.fail(new Error('e2ee_rpc_target_changed'));
        const checked = yield* open(machineId, saved.frame);
        if (
          checked.requesterDevice !== options.requesterDevice ||
          !isDeepStrictEqual(checked.args, args)
        )
          return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
        return {
          requestId: checked.requestId,
          targetMachineId: machineId,
          frameHex: hex(saved.frame),
          requesterDevice: checked.requesterDevice,
          expiresAt: checked.expiresAt,
        } satisfies E2eePreparedDispatch;
      })
    );
  const acceptResponse = (machineId: string, input: E2eeDispatchInput, frameHex: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const args = yield* attempt(() => normalizeInput(input));
        const saved = yield* attempt(() => options.originals.read('sent', key(args)));
        if (
          !saved ||
          saved.target !== machineId ||
          saved.signer !== (yield* targetSigner(machineId))
        )
          return yield* Effect.fail(new Error('e2ee_rpc_original_missing'));
        const original = yield* open(machineId, saved.frame);
        if (
          !isDeepStrictEqual(original.args, args) ||
          original.requesterDevice !== options.requesterDevice
        )
          return yield* Effect.fail(new Error('e2ee_rpc_intent_conflict'));
        const frame = yield* attempt(() => unhex(frameHex));
        const binding = yield* options.binding(e2eeRpcResource(machineId));
        const opened = yield* binding.openResponse(frame, saved.signer, original.epoch);
        try {
          const response = yield* attempt(() => decodeE2eeRpcResponseBody(opened.plaintext));
          try {
            if (
              hex(response.requestId) !== original.requestId ||
              hex(response.requestDigest) !== hex(e2eeRpcDigest(saved.frame)) ||
              response.kind !== 'progress' ||
              response.sequence !== 0
            )
              return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
            const ack = yield* attempt(() =>
              ackSchema.parse(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.payload))
              )
            );
            if (ack.sessionId !== args.sessionId || ack.userTurnId !== args.userTurnId)
              return yield* Effect.fail(new Error('e2ee_rpc_response_binding'));
            yield* attempt(() =>
              options.originals.retainResponse(key(args), response.sequence, frame)
            );
            return ack;
          } finally {
            response.payload.fill(0);
          }
        } finally {
          opened.plaintext.fill(0);
        }
      })
    );
  return {
    /** Terminal native store cleanup; failed owners remain available for another close attempt. */
    close: () => attempt(() => options.originals.close()),
    prepareDispatch,
    acceptResponse,
    openDispatch: (machineId: string, frameHex: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const frame = yield* attempt(() => unhex(frameHex));
          const value = yield* open(machineId, frame);
          return { ...value, frame };
        })
      ),
    retainIncoming: (
      machineId: string,
      value: { args: E2eeDispatchInput; requesterDevice: string; frame: Uint8Array }
    ) =>
      attempt(() =>
        options.originals.retain('received', key(value.args), {
          target: machineId,
          signer: value.requesterDevice,
          frame: value.frame,
        })
      ),
    readIncoming: (intent: Pick<E2eeDispatchInput, 'sessionId' | 'userTurnId'>) =>
      attempt(() => options.originals.read('received', key(intent))),
    sealAck: (
      machineId: string,
      request: { frame: Uint8Array; requestId: string; epoch: number },
      ack: E2eeDispatchAck
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const binding = yield* options.binding(e2eeRpcResource(machineId));
          const body = yield* attempt(() =>
            encodeE2eeRpcResponseBody({
              requestId: Uint8Array.from(Buffer.from(request.requestId, 'hex')),
              requestDigest: e2eeRpcDigest(request.frame),
              kind: 'progress',
              sequence: 0,
              payload: new TextEncoder().encode(JSON.stringify(ackSchema.parse(ack))),
            })
          );
          try {
            return yield* binding.sealResponse(body, request.epoch);
          } finally {
            body.fill(0);
          }
        })
      ),
    responseStream: (requesterDevice: string) =>
      e2eeRpcResponseStream(options.workspaceId, requesterDevice),
  };
}

export { E2eeRpcOriginals } from './e2ee-node-store';
