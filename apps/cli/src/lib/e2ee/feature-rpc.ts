import { Clock, Effect } from 'effect';
import { isE2eeReadQuery } from '@lody/shared/e2ee-rpc';
import type { makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import { e2eeRpcEnvelope } from '@lody/loro-streams-rpc/e2ee-streams';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import type {
  LocalMachineRpcRequest,
  LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import type { AuthorizeEncryptedExecution } from './agent-execution';
import { RealtimeJournal, type RealtimeStartPermit } from './realtime-journal';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
export type EncryptedFeatureContext = {
  requestId: string;
  requesterDevice: string;
  expiresAt: number;
  signal: AbortSignal;
  authority?: { isCurrent(): boolean; signal: AbortSignal };
};
export type EncryptedFeatureHandler = (
  request: LocalMachineRpcRequest,
  context: EncryptedFeatureContext
) => Promise<LocalMachineRpcResponse>;

/** One codec and channel; pure reads use read authority/originals, effects use
 * write authority and their execution journal. Raw work keeps its own task until settlement. */
export const makeEncryptedFeatureReceiver = Effect.fnUntraced(function* (options: {
  workspaceId: string;
  genesis: string;
  machineId: string;
  native: ReturnType<typeof makeE2eeRpcNative>;
  journal: () => RealtimeJournal;
  authorize: AuthorizeEncryptedExecution;
  authorizeRead: AuthorizeEncryptedExecution;
  /** Storage-independent exact-session authority for the Roost session/history-read
   * method, ready for future encrypted Roost support. Backend availability remains
   * a separate gate; other methods never borrow this revocable authority. */
  authorizeHistoryRead?: (
    workspaceId: string,
    requesterDevice: string,
    sessionId: string
  ) => ReturnType<AuthorizeEncryptedExecution>;
  authoritySignal?: () => AbortSignal;
  isOpen: () => boolean;
  handle: EncryptedFeatureHandler;
  client: LoroStreamsJsonStreamClient;
}) {
  const scope = yield* Effect.scope;
  const pending = new Map<string, { permit: RealtimeStartPermit; frames: Uint8Array[] }>();
  const reads = new Set<string>(),
    writes = new Set<string>();
  return Effect.fnUntraced(function* (envelope: { id: string; frame: string }) {
    if (!options.isOpen()) return true;
    const opened = yield* options.native.openFeature(options.machineId, envelope.frame);
    if (opened === null) return false;
    if (!opened) return true;
    if (opened.requestId !== envelope.id)
      return yield* Effect.fail(new Error('e2ee_rpc_request_binding'));
    const read = isE2eeReadQuery(opened.input.request.method, opened.input.request.params);
    const active = read ? reads : writes;
    if (active.has(envelope.id) || active.size >= 32) return true;
    active.add(envelope.id);
    const historyRequest =
      opened.input.request.method === 'session/history-read' ? opened.input.request : undefined;
    const authorize: AuthorizeEncryptedExecution = historyRequest
      ? (workspaceId, requesterDevice) =>
          options.authorizeHistoryRead?.(
            workspaceId,
            requesterDevice,
            historyRequest.params.sessionId
          ) ?? Effect.succeed({ _tag: 'Denied' as const, reason: 'not-authorized' as const })
      : read
        ? options.authorizeRead
        : options.authorize;
    const invoke = (authority: { isCurrent(): boolean; signal: AbortSignal } | undefined) =>
      Effect.acquireUseRelease(
        Effect.sync(() => ({
          controller: new AbortController(),
          raw: undefined as Promise<LocalMachineRpcResponse> | undefined,
        })),
        (owner) => {
          const work = Effect.tryPromise({
            try: () =>
              (owner.raw = options.handle(opened.input.request, {
                requestId: opened.requestId,
                requesterDevice: opened.requesterDevice,
                expiresAt: opened.expiresAt,
                signal: owner.controller.signal,
                authority,
              })),
            catch: (cause) => cause,
          });
          return read
            ? Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                return yield* work.pipe(
                  Effect.timeout(Math.min(45_000, Math.max(1, opened.expiresAt - now))),
                  Effect.catch(() =>
                    Effect.succeed({
                      ok: false,
                      code: 'e2ee_query_failed',
                      error: 'Query failed or exceeded its deadline.',
                    } as const)
                  )
                );
              })
            : work;
        },
        (owner) =>
          Effect.promise(async () => {
            owner.controller.abort();
            await owner.raw?.catch(() => undefined);
          })
      );
    const task = Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const authority = yield* authorize(options.workspaceId, opened.requesterDevice);
      const authoritySignal = options.authoritySignal?.();
      if (
        authority._tag !== 'Authorized' ||
        ((opened.input.request.method === 'machine/acp-interaction' ||
          opened.input.request.method === 'session/history-read') &&
          (!authority.isCurrent ||
            !authoritySignal ||
            authoritySignal.aborted ||
            !authority.isCurrent())) ||
        !options.isOpen() ||
        (yield* Clock.currentTimeMillis) >= opened.expiresAt
      )
        return yield* Effect.void;
      const admittedAuthority =
        authority.isCurrent && authoritySignal
          ? { isCurrent: authority.isCurrent, signal: authoritySignal }
          : undefined;
      const currentAdmission = () =>
        !admittedAuthority || (!admittedAuthority.signal.aborted && admittedAuthority.isCurrent());
      yield* options.native.retainFeatureRequest(options.machineId, opened);
      let frames: Uint8Array[];
      if (read) {
        frames = yield* options.native.readFeatureResponse(opened);
        if (!frames.length)
          frames = yield* options.native.sealFeatureResult(
            options.machineId,
            opened,
            yield* invoke(admittedAuthority)
          );
      } else {
        const journal = yield* attempt(options.journal);
        const request = {
          genesis: options.genesis,
          workspaceId: options.workspaceId,
          targetMachineId: options.machineId,
          requestId: opened.requestId,
          requester: opened.requesterDevice,
          expiresAt: opened.expiresAt,
          frame: Uint8Array.from(opened.frame),
        };
        const retained = yield* attempt(() => journal.receive(request));
        let owned = pending.get(opened.requestId);
        if (retained.state !== 'completed' && !owned) {
          if (pending.size >= 32) return yield* Effect.void;
          const claim = yield* attempt(() => journal.claim(request));
          if (claim.state !== 'claimed' || !options.isOpen()) return yield* Effect.void;
          owned = {
            permit: claim.permit,
            frames: yield* options.native.sealFeatureResult(
              options.machineId,
              opened,
              yield* invoke(admittedAuthority)
            ),
          };
          pending.set(opened.requestId, owned);
        }
        if (owned) {
          const selected = owned;
          for (const [index, frame] of selected.frames.entries())
            yield* attempt(() => journal.retainResponse(selected.permit, { index, frame }));
          yield* attempt(() =>
            journal.finish(selected.permit, Uint8Array.of(selected.frames.length))
          );
          pending.delete(opened.requestId);
        }
        const complete = yield* attempt(() => journal.receive(request));
        if (complete.state !== 'completed') return yield* Effect.void;
        const count = complete.outcome[0];
        if (!count || count > 128)
          return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
        frames = [];
        for (let index = 0; index < count; index++) {
          const frame = yield* attempt(() => journal.readResponse(request, index));
          if (!frame) return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
          frames.push(frame);
        }
      }
      const current = yield* authorize(options.workspaceId, opened.requesterDevice);
      if (
        current._tag !== 'Authorized' ||
        !currentAdmission() ||
        !options.isOpen() ||
        (yield* Clock.currentTimeMillis) >= opened.expiresAt
      )
        return yield* Effect.void;
      yield* options.native.verifyFeatureRequest(opened);
      const stream = options.native.responseStream(opened.requesterDevice);
      yield* Effect.tryPromise({
        try: () => options.client.ensureJsonStream(stream, 86400),
        catch: (cause) => cause,
      });
      for (const frame of frames) {
        // Metadata can change without a ledger/policy revision (for example an
        // assigned owner transfer). Re-resolve actual target access after stream I/O.
        const latest = historyRequest
          ? yield* authorize(options.workspaceId, opened.requesterDevice)
          : current;
        if (
          latest._tag !== 'Authorized' ||
          (latest.isCurrent && !latest.isCurrent()) ||
          !options.isOpen() ||
          !currentAdmission() ||
          (yield* Clock.currentTimeMillis) >= opened.expiresAt
        )
          return yield* Effect.void;
        yield* Effect.tryPromise({
          try: () => {
            if (
              !options.isOpen() ||
              !currentAdmission() ||
              (latest.isCurrent && !latest.isCurrent()) ||
              clock.currentTimeMillisUnsafe() >= opened.expiresAt
            )
              throw new Error('e2ee_history_authority_withdrawn');
            return options.client.appendJson(
              stream,
              e2eeRpcEnvelope({ id: opened.requestId, frame: Buffer.from(frame).toString('hex') })
            );
          },
          catch: (cause) => cause,
        });
      }
      return yield* Effect.void;
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.ensuring(Effect.sync(() => active.delete(envelope.id)))
    );
    yield* Effect.forkIn(task, scope);
    return true;
  });
});
