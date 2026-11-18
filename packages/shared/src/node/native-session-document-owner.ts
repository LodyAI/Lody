import { createHash, randomUUID } from 'node:crypto';
import { Cause, Context, Effect, Layer } from 'effect';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { makeApplicationRuntime } from './application-runtime';
import { latestPendingUserHistoryId } from './native-session-auto-read';
import {
  attachSessionModelSummary,
  latestSessionModelFromReader,
} from './native-session-model-summary';
import { makeNativeSessionReader } from './native-session-reader';
import { createNativeSessionWriter } from './native-session-writer';
import { createNativeSessionBackend } from './native-session-backend';
import { createNativeSessionBackendHost } from './native-session-backend-host';
import { createNativeSessionDocumentControl } from './native-session-document-control';
import {
  supportsNativeSessionLiteralValues,
  type NativeSessionSdkCompatibility,
} from './native-session-compatibility';
import type {
  NativeSessionControlPort,
  NativeSessionDocumentFactory,
  NativeSessionDocumentOwner,
  NativeSessionMetadataPort,
} from './native-session-document';
import type { SessionId } from '@lody/shared';

export type NativeSessionRoomGrant = {
  readonly dataDir: string;
  readonly namespace: string;
  readonly client: RepoClient;
  readonly writer: string;
  readonly contentMode: 'plaintext';
  readonly compatibility: NativeSessionSdkCompatibility;
  /** From the actual host lease generation, not merely its package metadata. */
  readonly requiredSdkArtifactId: string;
  readonly closeTimeoutMs: number;
  readonly editingLeaseMs: number;
  readonly now: () => number;
  assertCurrent(): void;
  waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean>;
  onBackgroundFailure(error: unknown): void;
};
export class NativeSessionOwnerCleanupError extends AggregateError {
  readonly code = 'native_session_cleanup_unconfirmed';
  constructor(
    errors: readonly unknown[],
    readonly retryCleanup: () => Promise<void>
  ) {
    super(errors, 'Native Session owner cleanup unconfirmed');
  }
}
class NativeRoomData extends Context.Service<NativeRoomData, NativeSessionDocumentOwner>()(
  'lody/cli/session/NativeRoomData'
) {}

function openRoomOwner(
  sessionId: SessionId,
  grant: NativeSessionRoomGrant,
  metadata: NativeSessionMetadataPort,
  released: () => void
) {
  let retired = false;
  const jobs = new Set<Promise<unknown>>();
  const stops = new Set<() => void>();
  const assertCurrent = () => {
    if (retired) throw new Error('Native Session owner is retired');
    grant.assertCurrent();
    if (grant.client.connectionState !== 'connected')
      throw new Error('Native Session engine is unavailable');
  };
  const track = async <A>(operation: () => Promise<A>): Promise<A> => {
    assertCurrent();
    const work = Promise.resolve().then(() => {
      assertCurrent();
      return operation();
    });
    jobs.add(work);
    void work.finally(() => jobs.delete(work)).catch(() => undefined);
    return work;
  };
  const report = (error: unknown) => {
    try {
      grant.onBackgroundFailure(error);
    } catch {}
  };
  const fence = () => {
    retired = true;
    const failures: unknown[] = [];
    for (const stop of stops) {
      try {
        stop();
        stops.delete(stop);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new NativeSessionOwnerCleanupError(failures, cleanupLocal);
  };
  const drain = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw = Promise.allSettled([...jobs]).then(() => undefined);
    try {
      await Promise.race([
        raw,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new NativeSessionOwnerCleanupError([], drain)),
            grant.closeTimeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  async function cleanupLocal() {
    const failures: unknown[] = [];
    try {
      fence();
    } catch (error) {
      failures.push(error);
    }
    try {
      await drain();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new NativeSessionOwnerCleanupError(failures, cleanupLocal);
  }
  const recover = (cause: Cause.Cause<unknown>) =>
    Effect.tryPromise({
      try: async () => {
        const retry = cause.reasons.flatMap((reason) => {
          const error = Cause.isDieReason(reason)
            ? reason.defect
            : Cause.isFailReason(reason)
              ? reason.error
              : undefined;
          return error &&
            typeof error === 'object' &&
            'retryCleanup' in error &&
            typeof error.retryCleanup === 'function'
            ? [() => (error.retryCleanup as () => Promise<void>).call(error)]
            : [];
        });
        if (!retry.length) throw new Error('Native Session release has no recovery owner');
        await Promise.all(retry.map((operation) => operation()));
      },
      catch: (error) => error,
    });
  const layer = Layer.effect(
    NativeRoomData,
    Effect.gen(function* () {
      const reader = yield* makeNativeSessionReader({
        dataDir: grant.dataDir,
        namespace: grant.namespace,
        sessionId,
        client: grant.client,
        compatibility: grant.compatibility,
        cleanupTimeoutMs: grant.closeTimeoutMs,
        onFailure: report,
      });
      const writer = createNativeSessionWriter({
        client: grant.client,
        namespace: grant.namespace,
        sessionId,
        writer: grant.writer,
        reader: () => {
          assertCurrent();
          return reader;
        },
        compatibility: grant.compatibility,
        assertCurrent,
      });
      const rawControl = createNativeSessionDocumentControl({
        ...grant,
        sessionId,
        reader,
        assertCurrent,
      });
      const control = Object.fromEntries(
        Object.entries(rawControl).map(([key, method]) => [
          key,
          key === 'getForkOperation' ||
          key === 'observe' ||
          key === 'causalVersion' ||
          key === 'hasCausalFrontiers' ||
          key === 'frontiers' ||
          key === 'readDirectorySnapshot'
            ? method
            : (...args: unknown[]) =>
                track(() => (method as (...values: unknown[]) => Promise<unknown>)(...args)),
        ])
      ) as NativeSessionControlPort;
      control.observe = (listener) => {
        assertCurrent();
        const detach = rawControl.observe(() => {
          if (!retired) listener();
        });
        let active = true;
        const stop = () => {
          if (!active) return;
          detach();
          active = false;
          stops.delete(stop);
        };
        stops.add(stop);
        return stop;
      };
      let policies = false;
      const marking = new Map<string, Promise<boolean>>();
      let summary: ReturnType<typeof attachSessionModelSummary> | undefined;
      const initialize = async ({ skipAutoRead }: { skipAutoRead: boolean }) => {
        assertCurrent();
        if (skipAutoRead || policies) return;
        policies = true;
        const seen = () => {
          if (retired) return undefined;
          const id = latestPendingUserHistoryId(reader.history);
          if (!id) return undefined;
          const existing = marking.get(id);
          if (existing) return existing;
          const work = track(() => writer.markTurnSeen(id));
          marking.set(id, work);
          void work.catch(report).finally(() => marking.delete(id));
          return work;
        };
        const watch = reader.history.observe(seen);
        stops.add(() => watch.unsubscribe());
        summary = attachSessionModelSummary(
          {
            subscribe(listener) {
              const sub = reader.history.observe(listener);
              return () => sub.unsubscribe();
            },
            latestModel: () => latestSessionModelFromReader(reader.history),
          },
          (lastModel, active) =>
            track(async () => {
              const current = await metadata.read();
              if (!active() || retired || !current || current.id !== sessionId) return false;
              if (JSON.stringify(current.lastModel) !== JSON.stringify(lastModel)) {
                assertCurrent();
                await metadata.patch({ lastModel });
              }
              return true;
            }),
          report
        );
        stops.add(() => summary?.dispose());
        await seen();
        if (reader.history.count()) void summary.sync();
      };
      let backend!: ReturnType<typeof createNativeSessionBackend>;
      const flush = async () => {
        assertCurrent();
        await summary?.flush();
        await Promise.all([...jobs]);
        assertCurrent();
        await metadata.flush();
      };
      const host = createNativeSessionBackendHost({
        sessionId,
        reader,
        writer,
        control,
        metadata,
        backend: () => backend,
        now: grant.now,
        initialize,
        assertCurrent,
        flush,
        waitUntilSynced: grant.waitUntilSynced,
        dispose: close,
      });
      const rawBackend = createNativeSessionBackend({
        reader: () => {
          assertCurrent();
          return reader;
        },
        writer,
        host,
      });
      backend = Object.create(rawBackend) as typeof rawBackend;
      for (const key of Object.keys(rawBackend)) {
        if (
          key === 'history' ||
          key === 'dispose' ||
          key === 'flushLocalWrites' ||
          key === 'initialize' ||
          key === 'getQueueOperationId' ||
          key === 'subscribeHistory'
        )
          continue;
        const method = rawBackend[key as keyof typeof rawBackend];
        if (typeof method === 'function')
          Object.defineProperty(backend, key, {
            value: (...args: unknown[]) =>
              track(() =>
                (method as (...values: unknown[]) => Promise<unknown>).apply(rawBackend, args)
              ),
          });
      }
      backend.subscribeHistory = (listener) => {
        assertCurrent();
        const detach = rawBackend.subscribeHistory(() => {
          if (!retired) listener();
        });
        let active = true;
        const stop = () => {
          if (!active) return;
          detach();
          active = false;
          stops.delete(stop);
        };
        stops.add(stop);
        return stop;
      };
      yield* Effect.addFinalizer(() => Effect.promise(cleanupLocal));
      return {
        assertCurrent,
        generation: createHash('sha256')
          .update(
            JSON.stringify([grant.requiredSdkArtifactId, reader.checkpoint().runId, randomUUID()])
          )
          .digest('hex'),
        backend,
        control,
        async initialize(initial, options) {
          assertCurrent();
          await track(() => writer.initializeDocument(initial));
          await initialize(options);
        },
        flush,
        close,
      } satisfies NativeSessionDocumentOwner;
    })
  );
  const application = makeApplicationRuntime(layer, {
    recover,
    project: (cause) => new NativeSessionOwnerCleanupError([cause], close),
  });
  function close(): Promise<void> {
    try {
      fence();
    } catch {
      /* The owned Scope also retries local fencing. */
    }
    return application.closeLegacy().then(released);
  }
  return {
    async acquire() {
      try {
        return await application.runtime.runPromise(NativeRoomData);
      } catch (cause) {
        try {
          await close();
        } catch (cleanup) {
          throw new NativeSessionOwnerCleanupError([cause, cleanup], close);
        }
        throw cause;
      }
    },
    close,
    isRetired: () => retired,
  };
}

/** One factory belongs to one manager scope. Failed retirement keeps the actual
 * owner for retry and blocks replacement only for that exact Session room. */
export function createNativeSessionDocumentFactory(options: {
  readonly binding: NativeSessionDocumentFactory['binding'];
  /** Returns a borrowed grant; its data-host lease belongs to the outer scope. */
  acquire(sessionId: SessionId): Promise<NativeSessionRoomGrant | undefined>;
  ownsRoom(roomId: string): boolean | Promise<boolean>;
}): NativeSessionDocumentFactory {
  const active = new Set<{ id: SessionId; room: ReturnType<typeof openRoomOwner> }>();
  let closed = false;
  const factory = Object.assign(
    async (
      sessionId: SessionId,
      metadata: NativeSessionMetadataPort,
      backend: { historyBackend: 'loro' | 'roost' }
    ) => {
      if (closed) throw new Error('Native Session factory is closed');
      // An unresolved retired scope blocks replacement only for its own room.
      for (const entry of active)
        if (entry.id === sessionId && entry.room.isRetired()) await entry.room.close();
      const grant = await options.acquire(sessionId);
      if (closed) throw new Error('Native Session factory closed during selection');
      if (!grant) return;
      if (
        backend.historyBackend !== 'loro' ||
        grant.contentMode !== 'plaintext' ||
        !supportsNativeSessionLiteralValues(grant.compatibility) ||
        grant.compatibility.artifactId !== grant.requiredSdkArtifactId ||
        !Number.isFinite(grant.closeTimeoutMs) ||
        grant.closeTimeoutMs <= 0
      )
        throw new Error('Native Session artifact/owner compatibility required');
      grant.assertCurrent();
      let entry!: { id: SessionId; room: ReturnType<typeof openRoomOwner> };
      const room = openRoomOwner(sessionId, grant, metadata, () => {
        active.delete(entry);
      });
      entry = { id: sessionId, room };
      active.add(entry);
      return await room.acquire();
    },
    {
      binding: Object.freeze({
        accountId: options.binding.accountId,
        workspaceId: options.binding.workspaceId,
      }),
      ownsRoom: options.ownsRoom,
      assertLegacyRoom(roomId:string){
        const selected=options.ownsRoom(roomId);
        if(typeof selected!=='boolean'){void selected.catch(()=>undefined);throw new Error('Synchronous legacy Session ownership proof required');}
        if(selected||closed)throw new Error('Legacy Session body is frozen');
      },
      async retireRoom(sessionId:SessionId){
        const result=await Promise.allSettled([...active].filter(entry=>entry.id===sessionId).map(entry=>entry.room.close()));
        const failures=result.flatMap(entry=>entry.status==='rejected'?[entry.reason]:[]);
        if(failures.length)throw new NativeSessionOwnerCleanupError(failures,()=>factory.retireRoom(sessionId));
      },
      async close() {
        closed = true;
        const result = await Promise.allSettled([...active].map((entry) => entry.room.close()));
        const failures = result.flatMap((entry) =>
          entry.status === 'rejected' ? [entry.reason] : []
        );
        if (failures.length)
          throw new NativeSessionOwnerCleanupError(failures, () => factory.close());
      },
    }
  );
  return factory;
}
