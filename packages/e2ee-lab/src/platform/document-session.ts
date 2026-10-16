import { Context, Data, Deferred, Effect, Exit, Result, Scope, Semaphore } from 'effect';

import {
  StreamsCrdt,
  type JsonObject,
  type CrdtAdapter,
  type RemoteCursor,
  type RemoteCursorStore,
  type TransportError,
} from '@loro-dev/streams-crdt';
import type { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeLabUpdateProvider } from './content-provider';
import { LabDocumentError, makeLabDocumentStore } from './document-sqlite';
import { makeLabSdkOwner } from './sdk-owner';

export interface LabNativeDocument<TVersion extends JsonObject> {
  adapter(): CrdtAdapter<TVersion>;
  exportSnapshot(): Uint8Array;
  importSnapshot(bytes: Uint8Array): void;
  /** Capture only when a Lab replay observer owns this operation. */
  append(text: string, captureDelta?: boolean): Uint8Array | undefined;
  importUpdate(bytes: Uint8Array): void;
  text(): string;
  release(): void;
}
export interface LabLocalEditReplayHooks {
  readonly take: (model: 'loro' | 'flock', text: string) => Uint8Array | undefined;
  /** Receives an owned original input, before local persistence or encryption.
   * Loro uses native update bytes; Flock uses UTF8 native ExportBundle JSON. */
  readonly capture: (model: 'loro' | 'flock', text: string, delta: Uint8Array) => void;
}
/** Synthetic Lab replay input only. The ordinary product path has no observer. */
export const LabLocalEditReplay = Context.Reference<LabLocalEditReplayHooks | undefined>(
  'Lab/LocalEditReplay',
  { defaultValue: () => undefined }
);
const MAX_LOCAL_EDIT_BYTES = 16 * 1024 * 1024;

export class LabContentError extends Data.TaggedError('LabContentError')<{
  readonly code:
    | 'closed'
    | 'document-stopped'
    | 'storage'
    | 'native'
    | 'transport'
    | 'unauthorized'
    | 'corrupt'
    | 'snapshot-disabled'
    | 'pending-write'
    | TransportError['code']
    | import('@loro-dev/streams-crdt').PayloadProtectionFailureReason;
  readonly cause?: unknown;
}> {}
const error = (code: LabContentError['code'], cause?: unknown) =>
  new LabContentError({ code, cause });
/** One synthetic Lab document, two real SDK modes, one durable state/cursor pair.
 * Integrity/corruption failures stop this document only. Transport and permission
 * failures retain an active, retryable document. Recovery reloads its durable native
 * state and replays encrypted history from -1. Snapshot publication is explicit. */
export function makeLabDocumentSession<TVersion extends JsonObject>(
  input: Parameters<typeof makeStreamsUpdateBinding>[0] & {
    readonly binding?: import('effect').Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
    readonly path: string;
    readonly mode: 'create' | 'open';
    readonly streamUrl: string;
    readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
    /** Lab-only opt-in to the released SDK's explicit experimental snapshot uploader. */
    readonly snapshotUpload?: boolean;
  },
  createNative: () => LabNativeDocument<TVersion>
) {
  return Effect.gen(function* () {
    const path = input.path,
      mode = input.mode,
      streamUrl = input.streamUrl;
    const editReplay = yield* LabLocalEditReplay;
    const nativeFetch = input.fetch,
      snapshotUpload = input.snapshotUpload === true;
    let closed = false,
      stopped = false;
    const active = new Set<Deferred.Deferred<void>>();
    const owners = new Set<{ stop(): Effect.Effect<void> }>();
    const serial = yield* Semaphore.make(1);
    const guard = (): Effect.Effect<void, LabContentError> =>
      closed ? Effect.fail(error('closed')) : Effect.void;
    const lookup = input.ledger;
    const store = yield* makeLabDocumentStore<TVersion>({
      path,
      mode,
      streamUrl,
      genesis: Buffer.from(input.genesis.toBytes()).toString('hex'),
      resource: input.resource,
      model: input.model,
    });
    const provider = yield* makeLabUpdateProvider({
      ...input,
      sealedWrites: store.sealedWrites,
      model: input.model,
      ledger: () => guard().pipe(Effect.flatMap(() => lookup())),
    });
    let storageFailure: LabDocumentError | undefined;
    const sdkError = (cause: TransportError) => {
      if (storageFailure) return storageFailure;
      const original = provider.takeFailure();
      if (original instanceof LabDocumentError) return original;
      if (!original && cause.code === 'internal_error' && cause.context?.stage === 'payload_decode')
        return error('corrupt', cause);
      return error(
        original && (original.code === 'unauthorized' || original.code === 'pending-write')
          ? original.code
          : cause.code === 'payload_protection_error'
            ? cause.reason
            : cause.code,
        original ?? cause
      );
    };
    const allocate = () =>
      Effect.acquireUseRelease(
        Scope.make(),
        (child) =>
          Effect.gen(function* () {
            const doc = yield* Effect.acquireRelease(Effect.sync(createNative), (value) =>
              Effect.sync(() => value.release())
            ).pipe(Effect.provideService(Scope.Scope, child));
            const bytes = yield* store.restore();
            if (bytes)
              yield* Effect.acquireUseRelease(
                Effect.succeed(bytes),
                (owned) =>
                  Effect.try({
                    try: () => doc.importSnapshot(owned),
                    catch: () => error('corrupt'),
                  }),
                (owned) => Effect.sync(() => owned.fill(0))
              );
            return { doc, child };
          }),
        (child, exit) => (Exit.isFailure(exit) ? Scope.close(child, Exit.void) : Effect.void)
      );
    let current = yield* allocate();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const owner of owners) yield* owner.stop();
        for (const done of active) yield* Deferred.await(done);
        yield* Scope.close(current.child, Exit.void);
      })
    );
    const operation = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* guard();
          const done = yield* Deferred.make<void>();
          active.add(done);
          return done;
        }),
        () => serial.withPermit(guard().pipe(Effect.flatMap(() => work))),
        (done) =>
          Effect.gen(function* () {
            active.delete(done);
            yield* Deferred.succeed(done, undefined);
          })
      );
    const useSdk = <A extends { readonly ok: boolean }>(
      replay: boolean,
      work: (sdk: StreamsCrdt<TVersion>) => Promise<A>,
      before: Effect.Effect<void, unknown> = Effect.void,
      write = false
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          storageFailure = undefined;
          provider.takeFailure();
          const doc = current.doc;
          const adapter = doc.adapter();
          let recoveredCursor: RemoteCursor<TVersion> | undefined;
          if (replay) yield* Effect.addFinalizer(() => store.discardStaged());
          const cursorStore: RemoteCursorStore<TVersion> = replay
            ? {
                // Ephemeral seed only: failure does not change the last durable pair.
                load: async () => ({
                  streamUrl,
                  nextOffset: '-1',
                  serverLowerBoundVersion: await adapter.emptyVersion(),
                  updatedAtMs: 0,
                }),
                save: async (cursor) => {
                  recoveredCursor = structuredClone(cursor);
                },
              }
            : {
                load: async (url) => {
                  try {
                    return await store.cursorStore.load(url);
                  } catch (cause) {
                    if (cause instanceof LabDocumentError) storageFailure = cause;
                    throw cause;
                  }
                },
                save: async (cursor) => {
                  try {
                    return await store.cursorStore.save(cursor);
                  } catch (cause) {
                    if (cause instanceof LabDocumentError) storageFailure = cause;
                    throw cause;
                  }
                },
              };
          const owner = yield* makeLabSdkOwner(
            ({ signal, assertOpen }) =>
              new StreamsCrdt<TVersion>({
                streamUrl,
                adapter,
                remoteCursorStore: cursorStore,
                beforeRemoteCursorSave: async () => {
                  assertOpen();
                  if (closed) throw error('closed');
                  const snapshot = doc.exportSnapshot();
                  try {
                    const staged = store.stage(snapshot);
                    if (Result.isFailure(staged)) storageFailure = staged.failure;
                    Result.getOrThrow(staged);
                  } finally {
                    snapshot.fill(0);
                  }
                },
                fetch: async (url, init) => {
                  const combined = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
                  const response = await nativeFetch(url, { ...init, signal: combined });
                  try {
                    assertOpen();
                  } catch (cause) {
                    await response.body?.cancel();
                    throw cause;
                  }
                  return response;
                },
                payloadProtectionRequired: true,
                e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                snapshotUpload: { enabled: snapshotUpload, canUpload: () => snapshotUpload },
              })
          );
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              owners.add(owner);
            }),
            () =>
              Effect.sync(() => {
                owners.delete(owner);
              })
          );
          yield* before;
          provider.beginWrite();
          const result = yield* owner
            .invoke(work)
            .pipe(Effect.onExit(() => provider.checkFailure()));
          if (write && result.ok) yield* provider.confirmWrite();
          if (replay && result.ok && recoveredCursor) {
            yield* guard();
            yield* Effect.tryPromise({
              try: () => store.cursorStore.save(recoveredCursor!),
              catch: () => error('storage'),
            });
          }
          return result;
        })
      );
    const live = (): Effect.Effect<void, LabContentError> =>
      stopped ? Effect.fail(error('document-stopped')) : guard();
    const execute = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      operation(
        work.pipe(
          Effect.tapError((cause) =>
            Effect.sync(() => {
              // An expected refusal is not itself evidence of corrupt content. In
              // particular a lost ACK, permission change or native harness defect
              // must not require a full-history restore of an intact document.
              if (
                (cause instanceof LabDocumentError && cause.code === 'corrupt') ||
                (cause instanceof LabContentError &&
                  (cause.code === 'corrupt' ||
                    cause.code === 'decrypt_failed' ||
                    cause.code === 'invalid_envelope' ||
                    cause.code === 'plaintext_forbidden' ||
                    cause.code === 'wrong_payload_kind' ||
                    (cause.code === 'protocol_error' &&
                      cause.cause &&
                      typeof cause.cause === 'object' &&
                      !('status' in cause.cause))))
              )
                stopped = true;
            })
          )
        )
      );
    const editLocal = Effect.fnUntraced(function* (text: string) {
      if (provider.hasPendingWrite()) yield* error('pending-write');
      // Hook failures (including missing recorded input) retain their original
      // typed harness error instead of becoming an expected native rejection.
      yield* Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const original = editReplay?.take(input.model, text);
            if (original === undefined) return undefined;
            if (
              !(original instanceof Uint8Array) ||
              !original.length ||
              original.length > MAX_LOCAL_EDIT_BYTES
            )
              throw error('native');
            return new Uint8Array(original);
          },
          catch: (cause) => cause,
        }),
        (original) =>
          original === undefined
            ? Effect.acquireUseRelease(
                Effect.try({
                  try: () => current.doc.append(text, editReplay !== undefined),
                  catch: () => error('native'),
                }),
                (delta) =>
                  Effect.gen(function* () {
                    if (!editReplay) return yield* Effect.void;
                    if (
                      !(delta instanceof Uint8Array) ||
                      !delta.length ||
                      delta.length > MAX_LOCAL_EDIT_BYTES
                    )
                      return yield* error('native');
                    return yield* Effect.try({
                      try: () => editReplay.capture(input.model, text, new Uint8Array(delta)),
                      catch: (cause) => cause,
                    });
                  }),
                (delta) => Effect.sync(() => delta?.fill(0))
              )
            : Effect.try({
                try: () => current.doc.importUpdate(original),
                catch: () => error('native'),
              }),
        (original) => Effect.sync(() => original?.fill(0))
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => current.doc.exportSnapshot()),
        (bytes) => store.persistLocal(bytes),
        (bytes) => Effect.sync(() => bytes.fill(0))
      );
    });
    return Object.freeze({
      /** Local CRDT edit plus durable native state only; no remote cursor, key lookup
       * or network is touched. Permission is checked when these changes are sealed. */
      editOffline: (text: string) =>
        execute(
          Effect.gen(function* () {
            yield* live();
            yield* editLocal(text);
          })
        ),
      /** The released SDK exports existing local changes relative to its durable
       * remote version. It does not rely on a subscription seeing the old commit.
       * Fresh provider authorization/current epoch is selected at actual sealing. */
      flushOffline: () =>
        execute(
          Effect.gen(function* () {
            yield* live();
            const result = yield* useSdk(false, (sdk) => sdk.sync(), Effect.void, true);
            if (!result.ok) yield* sdkError(result.error);
          })
        ),
      create: () =>
        execute(
          Effect.gen(function* () {
            yield* live();
            const result = yield* useSdk(false, (sdk) => sdk.createStream());
            if (!result.ok) yield* sdkError(result.error);
          })
        ),
      append: (text: string) =>
        execute(
          Effect.gen(function* () {
            yield* live();
            if (provider.hasPendingWrite()) {
              const pending = yield* useSdk(false, (sdk) => sdk.sync(), Effect.void, true);
              if (!pending.ok) yield* sdkError(pending.error);
            }
            const result = yield* useSdk(
              false,
              (sdk) => sdk.appendWriteOnly(),
              editLocal(text),
              true
            );
            if (!result.ok) yield* sdkError(result.error);
          })
        ),
      persist: () =>
        execute(
          Effect.gen(function* () {
            yield* live();
            yield* Effect.acquireUseRelease(
              Effect.sync(() => current.doc.exportSnapshot()),
              (bytes) => store.persistLocal(bytes),
              (bytes) => Effect.sync(() => bytes.fill(0))
            );
          })
        ),
      pull: () =>
        execute(
          Effect.gen(function* () {
            yield* live();
            const result = yield* useSdk(false, (sdk) => sdk.catchup());
            if (!result.ok) yield* sdkError(result.error);
          })
        ),
      /** Uses the released SDK's public internal test hook, not a production publish API. */
      uploadSnapshot: () =>
        execute(
          Effect.gen(function* () {
            yield* live();
            if (!snapshotUpload) return yield* error('snapshot-disabled');
            const result = yield* useSdk(false, (sdk) => sdk.uploadSnapshotForTesting());
            if (!result.ok) return yield* sdkError(result.error);
            return result.value;
          })
        ),
      /** Explicit client recovery; preserves durable local edits, never deletes/changes host snapshots. */
      recoverFromFullHistory: () =>
        execute(
          Effect.gen(function* () {
            yield* guard();
            const restored = yield* allocate();
            const previous = current;
            current = restored;
            yield* Scope.close(previous.child, Exit.void);
            const result = yield* useSdk(true, (sdk) => sdk.catchup());
            if (!result.ok) yield* sdkError(result.error);
            stopped = false;
          })
        ),
      text: () =>
        operation(
          Effect.gen(function* () {
            yield* live();
            return current.doc.text();
          })
        ),
      cursor: () => operation(store.inspectCursor()),
      status: () =>
        Effect.sync(() =>
          closed
            ? ('closed' as const)
            : stopped
              ? ('document-stopped' as const)
              : ('active' as const)
        ),
    });
  });
}
