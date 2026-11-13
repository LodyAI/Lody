import { Clock, Deferred, Effect } from 'effect';
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
import type { EncryptedReplySink } from './realtime-rpc';
import type { makeCliE2eeExecutionAuthorization } from './execution-authorization';

/** Shared authorization wiring for Streams and sink-carrying Iroh receivers.
 * Resolve the actual session target on every check, including before publication. */
export function makeEncryptedFeatureAuthorization(options: {
  authorization: Pick<
    Effect.Success<ReturnType<typeof makeCliE2eeExecutionAuthorization>>,
    | 'authorizeOwnedExecution'
    | 'authorizeRead'
    | 'authorizeExecution'
    | 'authorizeSessionRead'
    | 'authoritySignal'
  >;
  executionAuthoritySignal: () => AbortSignal;
  resolveHistoryTarget?: (
    sessionId: string
  ) => Promise<{ rootSessionId: string; sessionOwnerUserId?: string; localProjectId?: string }>;
  /** Every local project a session's execution can reach, resolved on this machine. */
  resolveSessionExecutionScope?: (sessionId: string) => Promise<readonly string[]>;
  /** The verified signer's account and execution identity, from the ledger. */
  requesterIdentity?: (
    requesterDevice: string
  ) => Effect.Effect<EncryptedFeatureRequester | undefined, unknown>;
}) {
  const { authorization, resolveHistoryTarget, resolveSessionExecutionScope } = options;
  return {
    /** Work on one session with the same sharing authority as sending to it: the owner,
     * or a member allowed on this machine and on every project the session reaches. */
    authorizeSessionExecution: Effect.fnUntraced(function* (
      workspaceId: string,
      requester: string,
      sessionId: string
    ) {
      if (!resolveSessionExecutionScope)
        return { _tag: 'Denied' as const, reason: 'not-authorized' as const };
      const scope = yield* Effect.tryPromise({
        try: () => resolveSessionExecutionScope(sessionId),
        catch: (cause) => cause,
      });
      const targets: readonly (string | undefined)[] = scope.length
        ? [...new Set(scope)]
        : [undefined];
      const fences: (() => boolean)[] = [];
      let owner = true;
      for (const target of targets) {
        const result = yield* authorization.authorizeExecution(workspaceId, requester, target);
        if (result._tag !== 'Authorized') return result;
        if (result.isCurrent) fences.push(result.isCurrent);
        if (result.principal !== 'owner') owner = false;
      }
      return {
        _tag: 'Authorized' as const,
        isCurrent: () => fences.every((current) => current()),
        ...(owner ? { principal: 'owner' as const } : {}),
      };
    }),
    ...(options.requesterIdentity ? { requesterIdentity: options.requesterIdentity } : {}),
    authorize: authorization.authorizeOwnedExecution,
    authorizeRead: authorization.authorizeRead,
    authorizeHistoryRead: Effect.fnUntraced(function* (
      workspaceId: string,
      requester: string,
      sessionId: string
    ) {
      if (!resolveHistoryTarget)
        return { _tag: 'Denied' as const, reason: 'not-authorized' as const };
      const target = yield* Effect.tryPromise({
        try: () => resolveHistoryTarget(sessionId),
        catch: (cause) => cause,
      });
      const editing = yield* authorization.authorizeExecution(
        workspaceId,
        requester,
        target.localProjectId
      );
      if (editing._tag === 'Authorized') return editing;
      return yield* authorization.authorizeSessionRead(
        workspaceId,
        requester,
        target.rootSessionId,
        target.sessionOwnerUserId
      );
    }),
    authoritySignal: () =>
      AbortSignal.any([options.executionAuthoritySignal(), authorization.authoritySignal]),
  };
}

/** A reply sink that owns its stream: `end` finishes it once no reply will follow. */
export type EncryptedFeatureReplySink = EncryptedReplySink & { end(): Promise<void> };

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
/** Who signed a request, from the verified ledger; never from request parameters. */
export type EncryptedFeatureRequester = {
  /** The signer's account, which a request's `requestedByUserId` must name. */
  accountId: string;
  /** The identity execution runs under: the machine owner's account or `e2ee-member:`. */
  executionUserId: string;
};
export type EncryptedFeatureContext = {
  requestId: string;
  requesterDevice: string;
  expiresAt: number;
  signal: AbortSignal;
  authority?: { isCurrent(): boolean; signal: AbortSignal };
  /** Set for session execution methods (`session/fork`) after their scope authorization. */
  requester?: EncryptedFeatureRequester;
};
export type EncryptedFeatureHandler = (
  request: LocalMachineRpcRequest,
  context: EncryptedFeatureContext
) => Promise<LocalMachineRpcResponse>;

type PendingFeatureWrite = { permit: RealtimeStartPermit; frames: Uint8Array[] };
// Both transports borrow the same workspace journal. A live claim is not crash
// evidence; keep its completion signal and sealed retry frames across receivers.
const featureWrites = new WeakMap<
  RealtimeJournal,
  {
    pending: Map<string, PendingFeatureWrite>;
    active: Map<string, Deferred.Deferred<void>>;
  }
>();

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
  /** Session execution methods (`session/fork`): owner or shared member, per project. */
  authorizeSessionExecution?: (
    workspaceId: string,
    requesterDevice: string,
    sessionId: string
  ) => ReturnType<AuthorizeEncryptedExecution>;
  requesterIdentity?: (
    requesterDevice: string
  ) => Effect.Effect<EncryptedFeatureRequester | undefined, unknown>;
  authoritySignal?: () => AbortSignal;
  isOpen: () => boolean;
  handle: EncryptedFeatureHandler;
  /** Streams replies; absent for a receiver that only serves sink-carrying routes. */
  client?: LoroStreamsJsonStreamClient;
}) {
  const scope = yield* Effect.scope;
  const reads = new Set<string>(),
    writes = new Set<string>();
  const receive = Effect.fnUntraced(function* (
    envelope: { id: string; frame: string },
    sink: EncryptedFeatureReplySink | undefined,
    state: { forked: boolean }
  ) {
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
    const forkRequest =
      opened.input.request.method === 'session/fork' ? opened.input.request : undefined;
    const authorize: AuthorizeEncryptedExecution = historyRequest
      ? (workspaceId, requesterDevice) =>
          options.authorizeHistoryRead?.(
            workspaceId,
            requesterDevice,
            historyRequest.params.sessionId
          ) ?? Effect.succeed({ _tag: 'Denied' as const, reason: 'not-authorized' as const })
      : forkRequest
        ? (workspaceId, requesterDevice) =>
            options.authorizeSessionExecution?.(
              workspaceId,
              requesterDevice,
              forkRequest.params.sourceSessionId
            ) ?? Effect.succeed({ _tag: 'Denied' as const, reason: 'not-authorized' as const })
        : read
          ? options.authorizeRead
          : options.authorize;
    let requester: EncryptedFeatureRequester | undefined;
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
                ...(requester ? { requester } : {}),
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
      if (forkRequest) {
        // Execution identity comes from the verified signer, never from the request.
        requester = options.requesterIdentity
          ? yield* options.requesterIdentity(opened.requesterDevice)
          : undefined;
        if (!requester) return yield* Effect.void;
      }
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
        let shared = featureWrites.get(journal);
        if (!shared) {
          shared = { pending: new Map(), active: new Map() };
          featureWrites.set(journal, shared);
        }
        const { pending, active } = shared;
        const writeKey = JSON.stringify([
          options.genesis,
          options.workspaceId,
          options.machineId,
          opened.requestId,
        ]);
        const uncertain = () =>
          options.native.sealFeatureResult(options.machineId, opened, {
            ok: false,
            code: 'e2ee_outcome_uncertain',
            error:
              'Previous execution of this request was interrupted before completion and will not be replayed automatically.',
          });
        const response = yield* Effect.acquireUseRelease(
          attempt(() => {
            // Validate exact retry bytes and publish ownership without a yield
            // between the durable claim and the process-local completion signal.
            const retained = journal.receive(request);
            const running = active.get(writeKey);
            if (running) return { kind: 'join' as const, done: running };
            if (retained.state === 'completed') return { kind: 'completed' as const };
            const owned = pending.get(writeKey);
            if (!owned && retained.state === 'uncertain') return { kind: 'uncertain' as const };
            if (active.size >= 32 || (!owned && pending.size >= 32))
              return { kind: 'busy' as const };
            const claim = owned ? undefined : journal.claim(request);
            if (!owned && claim?.state !== 'claimed')
              return {
                kind:
                  claim?.state === 'existing' && claim.record.state === 'uncertain'
                    ? ('uncertain' as const)
                    : ('busy' as const),
              };
            const done = Deferred.makeUnsafe<void>();
            active.set(writeKey, done);
            return {
              kind: 'owner' as const,
              done,
              owned,
              permit: owned?.permit ?? (claim?.state === 'claimed' ? claim.permit : undefined),
            };
          }),
          (admission) =>
            Effect.gen(function* () {
              if (admission.kind === 'busy') return undefined;
              if (admission.kind === 'uncertain') return yield* uncertain();
              if (admission.kind === 'join') {
                const completed = yield* Deferred.await(admission.done).pipe(
                  Effect.as(true),
                  Effect.timeout(Math.max(1, opened.expiresAt - (yield* Clock.currentTimeMillis))),
                  Effect.catch(() => Effect.succeed(false))
                );
                if (!completed) return undefined;
              }
              if (admission.kind === 'owner') {
                if (!options.isOpen() || !admission.permit) return undefined;
                const owned = admission.owned ?? {
                  permit: admission.permit,
                  frames: yield* options.native.sealFeatureResult(
                    options.machineId,
                    opened,
                    yield* invoke(admittedAuthority)
                  ),
                };
                pending.set(writeKey, owned);
                for (const [index, frame] of owned.frames.entries())
                  yield* attempt(() => journal.retainResponse(owned.permit, { index, frame }));
                yield* attempt(() =>
                  journal.finish(owned.permit, Uint8Array.of(owned.frames.length))
                );
                pending.delete(writeKey);
              }
              const complete = yield* attempt(() => journal.receive(request));
              if (complete.state !== 'completed') {
                // A failed persistence attempt retains sealed originals for retry.
                // Only a settled owner without those frames has an unknown outcome.
                return pending.has(writeKey) ? undefined : yield* uncertain();
              }
              const count = complete.outcome[0];
              if (!count || count > 128)
                return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
              const frames: Uint8Array[] = [];
              for (let index = 0; index < count; index++) {
                const frame = yield* attempt(() => journal.readResponse(request, index));
                if (!frame) return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
                frames.push(frame);
              }
              return frames;
            }),
          (admission) =>
            Effect.sync(() => {
              if (admission.kind !== 'owner') return;
              active.delete(writeKey);
              Deferred.doneUnsafe(admission.done, Effect.void);
            })
        );
        if (!response) return yield* Effect.void;
        frames = response;
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
      const client = options.client;
      if (!sink && !client) return yield* Effect.fail(new Error('e2ee_rpc_unavailable'));
      const stream = options.native.responseStream(opened.requesterDevice);
      if (!sink)
        yield* Effect.tryPromise({
          try: () => client!.ensureJsonStream(stream, 86400),
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
          try: async () => {
            if (
              !options.isOpen() ||
              !currentAdmission() ||
              (latest.isCurrent && !latest.isCurrent()) ||
              clock.currentTimeMillisUnsafe() >= opened.expiresAt
            )
              throw new Error('e2ee_history_authority_withdrawn');
            if (sink) return await sink.deliver(opened.requestId, frame);
            await client!.appendJson(
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
      Effect.ensuring(
        Effect.sync(() => active.delete(envelope.id)).pipe(
          Effect.andThen(
            sink ? Effect.promise(() => sink.end().catch(() => undefined)) : Effect.void
          )
        )
      )
    );
    state.forked = true;
    yield* Effect.forkIn(task, scope);
    return true;
  });
  // A claimed request's sink is always finished: by the forked task, or here when
  // it ends without one (duplicate, refused or failed early). `false` hands the
  // still-open sink back to the caller for the dispatch receiver.
  return (envelope: { id: string; frame: string }, sink?: EncryptedFeatureReplySink) => {
    const state = { forked: false };
    return receive(envelope, sink, state).pipe(
      Effect.onExit((exit) =>
        sink && !state.forked && !(exit._tag === 'Success' && exit.value === false)
          ? Effect.promise(() => sink.end().catch(() => undefined))
          : Effect.void
      )
    );
  };
});
