import { Clock, Effect } from 'effect';
import type { E2eeDispatchInput, E2eeDispatchAck } from '@lody/shared/e2ee-rpc';
import { e2eeRpcEnvelope, type E2eeRpcTiming } from '@lody/loro-streams-rpc/e2ee-streams';
import type { makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import type { AuthorizeEncryptedExecution } from './agent-execution';
import { RealtimeJournal, type RealtimeStartPermit } from './realtime-journal';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
/** Delivery receipt owner only. Actual execution always enters agent-start:userTurnId
 * through SessionExecutionService, including when history beats this offer. */
export function makeEncryptedRpcReceiver(options: {
  workspaceId: string;
  genesis: string;
  machineId: string;
  native: ReturnType<typeof makeE2eeRpcNative>;
  journal: () => RealtimeJournal;
  authorize: AuthorizeEncryptedExecution;
  isOpen: () => boolean;
  offer: (input: E2eeDispatchInput) => Promise<E2eeDispatchAck>;
  client: LoroStreamsJsonStreamClient;
  trace?: (event: E2eeRpcTiming) => void;
}) {
  const pendingResponses = new Map<string, { permit: RealtimeStartPermit; frame: Uint8Array }>();
  const responseStreams = new Set<string>();
  return Effect.fnUntraced(function* (envelope: { id: string; frame: string }) {
    const mark = (stage: E2eeRpcTiming['stage'], userTurnId?: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        try {
          options.trace?.({ stage, requestId: envelope.id, at, userTurnId });
        } catch {
          /* Observation only. */
        }
      });
    if (!options.isOpen()) return;
    const opened = yield* options.native.openDispatch(options.machineId, envelope.frame);
    if (opened.requestId !== envelope.id) yield* Effect.fail(new Error('e2ee_rpc_request_binding'));
    yield* mark('verified', opened.args.userTurnId);
    const authorization = yield* options.authorize(options.workspaceId, opened.requesterDevice);
    if (authorization._tag !== 'Authorized' || !options.isOpen()) return;
    const journal = yield* attempt(options.journal);
    const request = {
      genesis: options.genesis,
      workspaceId: options.workspaceId,
      targetMachineId: options.machineId,
      requestId: opened.requestId,
      requester: opened.requesterDevice,
      expiresAt: opened.expiresAt,
      frame: opened.frame,
    };
    yield* attempt(() => journal.receive(request));
    const prior = yield* attempt(() => journal.readResponse(request, 0));
    let response = prior;
    if (!response) {
      const pending = pendingResponses.get(opened.requestId);
      if (pending) {
        response = yield* attempt(() =>
          journal.retainResponse(pending.permit, { index: 0, frame: pending.frame })
        );
        pendingResponses.delete(opened.requestId);
      }
    }
    if (!response) {
      if (pendingResponses.size >= 32) return;
      yield* options.native.retainIncoming(options.machineId, opened);
      const claim = yield* attempt(() => journal.claim(request));
      if (claim.state !== 'claimed' || !options.isOpen()) return;
      yield* mark('journal', opened.args.userTurnId);
      const ack = yield* Effect.tryPromise({
        try: () => options.offer(opened.args),
        catch: (cause) => cause,
      });
      response = yield* options.native.sealAck(options.machineId, opened, ack);
      const originalResponse = response;
      pendingResponses.set(opened.requestId, { permit: claim.permit, frame: originalResponse });
      yield* attempt(() =>
        journal.retainResponse(claim.permit, { index: 0, frame: originalResponse })
      );
      pendingResponses.delete(opened.requestId);
      // ACK remains progress. Never finish the distinct agent-start execution claim here.
    }
    if (!options.isOpen()) return;
    const stream = options.native.responseStream(opened.requesterDevice);
    const saved = response;
    yield* Effect.tryPromise({
      try: async () => {
        if (!responseStreams.has(stream)) {
          await options.client.ensureJsonStream(stream, 86400);
          if (responseStreams.size >= 128) responseStreams.clear();
          responseStreams.add(stream);
        }
        try {
          await options.client.appendJson(
            stream,
            e2eeRpcEnvelope({ id: opened.requestId, frame: Buffer.from(saved).toString('hex') })
          );
        } catch (cause) {
          responseStreams.delete(stream);
          throw cause;
        }
      },
      catch: (cause) => cause,
    });
  });
}

/** Read tasks have their own bounded owner, leaving dispatch intake and journals independent.
 * Deadline/close aborts the raw handler and waits for its actual settlement before release. */
export const makeEncryptedQueryReceiver = Effect.fnUntraced(function* (options: {
  workspaceId: string;
  machineId: string;
  native: ReturnType<typeof makeE2eeRpcNative>;
  authorize: AuthorizeEncryptedExecution;
  isOpen: () => boolean;
  client: LoroStreamsJsonStreamClient;
  query: (
    input: import('@lody/shared/e2ee-rpc').E2eeQueryInput,
    expiresAt: number,
    signal: AbortSignal
  ) => Promise<import('@lody/shared/e2ee-rpc').E2eeQueryResult>;
}) {
  const scope = yield* Effect.scope;
  const active = new Set<string>();
  return Effect.fnUntraced(function* (envelope: { id: string; frame: string }) {
    if (!options.isOpen()) return;
    const request = yield* options.native.openQuery(options.machineId, envelope.frame);
    if (request.requestId !== envelope.id || active.has(envelope.id)) return;
    if (active.size >= 32) return;
    active.add(envelope.id);
    const task = Effect.gen(function* () {
      const allowed = yield* options.authorize(options.workspaceId, request.requesterDevice);
      if (allowed._tag !== 'Authorized' || !options.isOpen()) return;
      yield* options.native.retainQueryRequest(options.machineId, request);
      let frames = yield* options.native.readQueryResponse(request);
      if (!frames.length) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= request.expiresAt || request.expiresAt > now + 60_000) return;
        const result = yield* Effect.acquireUseRelease(
          Effect.sync(() => ({
            controller: new AbortController(),
            raw: undefined as Promise<import('@lody/shared/e2ee-rpc').E2eeQueryResult> | undefined,
          })),
          (owner) =>
            Effect.tryPromise({
              try: () => {
                owner.raw = options.query(
                  request.input,
                  request.expiresAt,
                  owner.controller.signal
                );
                return owner.raw;
              },
              catch: () => new Error('e2ee_query_failed'),
            }).pipe(
              Effect.timeout(Math.min(45_000, request.expiresAt - now)),
              Effect.catch(() =>
                Effect.succeed({
                  error: {
                    code: 'e2ee_query_failed',
                    message: 'Query failed or exceeded its deadline.',
                  },
                } as const)
              )
            ),
          (owner) =>
            Effect.promise(async () => {
              owner.controller.abort();
              await owner.raw?.catch(() => undefined);
            })
        );
        if (!options.isOpen()) return;
        frames = yield* options.native.queryResponse(options.machineId, request, result);
      }
      // A later revocation or incompatible epoch cannot use a retained result as authority.
      const current = yield* options.authorize(options.workspaceId, request.requesterDevice);
      if (current._tag !== 'Authorized' || !options.isOpen()) return;
      yield* options.native.openQuery(options.machineId, envelope.frame);
      yield* Effect.tryPromise({
        try: async () => {
          const stream = options.native.responseStream(request.requesterDevice);
          await options.client.ensureJsonStream(stream, 86400);
          for (const frame of frames) {
            if (!options.isOpen()) return;
            await options.client.appendJson(
              stream,
              e2eeRpcEnvelope({ id: request.requestId, frame: Buffer.from(frame).toString('hex') })
            );
          }
        },
        catch: () => new Error('e2ee_query_publish'),
      });
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.ensuring(Effect.sync(() => active.delete(envelope.id)))
    );
    yield* Effect.forkIn(task, scope);
  });
});
