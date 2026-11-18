import { createNativeSessionLosslessQueries } from './native-session-lossless';
import type { NativeSessionSdkCompatibility } from './native-session-compatibility';
import type { SessionHistoryReader } from '../session-data/types';
import { createNativeMachineCatalogObservations } from './native-machine-catalog-observations';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { LoroDoc, isContainer, type LoroMap, type LoroList, type LoroMovableList } from 'loro-crdt';
import { z } from 'zod';
import { createAgentHistoryWindow } from '../history-agent-window';
import { prepareReplacement } from '../history-writer';
import { historyValuesEqual } from '../history-values-equal';
import type { AgentHistoryTargets, AgentHistoryPatch, SessionHistoryInput } from '../index';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { createLoroSessionHistoryReader } from '../session-data/loro-reader';

const tx = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const endpointSchema = z.object({ protocol_version: z.literal(2), run_id: z.string().min(1) });
const roomSchema = z.object({ head: tx, compacted: tx, encryption: z.literal(0) });
const snapshotSchema = z.object({ txId: tx, bytes: z.instanceof(Uint8Array) });
const oplogSchema = z.array(z.object({ txId: tx, bytes: z.instanceof(Uint8Array) }));

export class NativeSessionReaderUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeSessionReaderUnavailable';
  }
}

type ReaderOptions = {
  readonly dataDir: string;
  readonly namespace: string;
  readonly sessionId: string;
  readonly cleanupTimeoutMs?: number;
  /** Receives content-free lifecycle state; it must not throw. */
  readonly onFailure?: (error: NativeSessionReaderUnavailable) => void;
};

export type NativeSessionQueryPort = {
  query<A>(operation: (view: NativeSessionReadView) => A): {
    value: A;
    checkpoint: { runId: string; roomTxId: number };
  };
};
export type NativeSessionReadView = {
  readonly history: ReturnType<typeof createLoroSessionHistoryReader>['history'];
  readonly readQuery: ReturnType<typeof createLoroSessionHistoryReader>['readQuery'];
  planAgentUpdate(
    id: string,
    targets: AgentHistoryTargets,
    updater: (rows: SessionHistoryInput[]) => SessionHistoryInput[]
  ): { handled: boolean; patches: readonly AgentHistoryPatch[] };
  positionOfTurn(turnId: string): number | undefined;
  lengthAt(path: readonly (string | number)[]): number;
  valueAt(path: readonly (string | number)[]): unknown;
  kindAt(
    path: readonly (string | number)[]
  ): 'map' | 'list' | 'movable_list' | 'text' | 'value' | 'missing';
};

/**
 * Exact 0.1.0 / 1d80000 compatibility projection. SQL is strictly read-only.
 * backend.rs::export_since persists raw Loro Updates; import_oplog_entry imports
 * those exact bytes. v2.rs::load_room reads snapshot plus tx-ordered oplog in one
 * transaction. This mirrors that read path, never its writes or checkpoints.
 */
function openProjection(options: ReaderOptions) {
  const roomId = `session-${options.sessionId}`;
  const endpointPath = path.join(options.dataDir, 'engine.json');
  const readGeneration = () =>
    endpointSchema.parse(JSON.parse(readFileSync(endpointPath, 'utf8'))).run_id;
  const runId = readGeneration();
  const database = new DatabaseSync(
    path.join(
      options.dataDir,
      'namespaces',
      `ns_${Buffer.from(options.namespace).toString('hex')}.sqlite3`
    ),
    { readOnly: true, timeout: 0 }
  );
  const readTransaction = <A>(operation: () => A): A => {
    database.exec('BEGIN');
    try {
      const value = operation();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'Native Session readonly transaction failed');
      }
      throw error;
    }
  };
  const doc = new LoroDoc();
  let reader: ReturnType<typeof createLoroSessionHistoryReader> | undefined;
  let roomTxId = -1;
  let anchorTxId = -1;
  let compactedTxId = 0;
  let refreshing = false;
  let closed = false;
  let failed: NativeSessionReaderUnavailable | undefined;
  const controlListeners = new Set<() => void>();
  let controlDirty = false;
  let detachControl = () => {};

  const invalidate = (cause: unknown) => {
    if (closed)
      return cause instanceof NativeSessionReaderUnavailable
        ? cause
        : new NativeSessionReaderUnavailable('Native Session reader is closed', { cause });
    if (!failed) {
      failed =
        cause instanceof NativeSessionReaderUnavailable
          ? cause
          : new NativeSessionReaderUnavailable('Native Session read projection failed', { cause });
      try {
        options.onFailure?.(failed);
      } catch {
        /* Failure observers cannot own this reader. */
      }
    }
    return failed;
  };
  const assertCurrent = () => {
    if (closed) throw new NativeSessionReaderUnavailable('Native Session reader is closed');
    if (failed) throw failed;
    if (readGeneration() !== runId)
      throw new NativeSessionReaderUnavailable('Native Session reader generation changed');
  };
  const close = () => {
    if (closed) return;
    closed = true;
    detachControl();
    controlListeners.clear();
    try {
      reader?.dispose();
      reader = undefined;
    } finally {
      try {
        database.close();
      } finally {
        doc.free();
      }
    }
  };
  const refresh = () => {
    try {
      assertCurrent();
      if (refreshing) return;
      const state = readTransaction(() => {
        z.object({ v: z.literal(1) }).parse(
          database.prepare("SELECT v FROM v2_meta WHERE k = 'schema_version'").get()
        );
        const meta = roomSchema.parse(
          database
            .prepare(`
          SELECT head_tx_id AS head, compacted_through_tx AS compacted, encryption
          FROM v2_rooms WHERE room_kind = 1 AND room_id = ?
        `)
            .get(roomId)
        );
        if (meta.head < roomTxId || meta.compacted > meta.head || meta.compacted < compactedTxId)
          throw new NativeSessionReaderUnavailable('Native Session causal generation changed');
        if (
          anchorTxId > meta.compacted &&
          !database
            .prepare(`
          SELECT 1 FROM v2_room_oplog WHERE room_kind = 1 AND room_id = ? AND tx_id = ?
        `)
            .get(roomId, anchorTxId)
        )
          throw new NativeSessionReaderUnavailable('Native Session reader lost its causal anchor');
        if (meta.head === roomTxId)
          return { head: meta.head, compacted: meta.compacted, entries: [], snapshot: undefined };
        const needsSnapshot = meta.compacted > 0 && roomTxId < meta.compacted;
        const snapshot = needsSnapshot
          ? snapshotSchema.parse(
              database
                .prepare(`
          SELECT tx_id AS txId, snapshot AS bytes FROM v2_room_snapshots
          WHERE room_kind = 1 AND room_id = ?
        `)
                .get(roomId)
            )
          : undefined;
        if (snapshot && (snapshot.txId !== meta.compacted || snapshot.bytes.length === 0))
          throw new NativeSessionReaderUnavailable(
            'Native Session compacted snapshot is incomplete'
          );
        const entries = oplogSchema.parse(
          database
            .prepare(`
          SELECT tx_id AS txId, payload AS bytes FROM v2_room_oplog
          WHERE room_kind = 1 AND room_id = ? AND tx_id > ? ORDER BY tx_id ASC
        `)
            .all(roomId, Math.max(roomTxId, meta.compacted))
        );
        if (entries.some((entry) => entry.txId > meta.head || entry.bytes.length === 0))
          throw new NativeSessionReaderUnavailable('Native Session oplog is invalid');
        return { head: meta.head, compacted: meta.compacted, snapshot, entries };
      });
      // No SQL read transaction remains pinned while WASM imports or observers run.
      assertCurrent();
      refreshing = true;
      try {
        if (state.snapshot) {
          // A room deleted/recreated under the same name must not merge an old
          // projection into its replacement. A normal compaction covers every
          // previously observed causal operation, even when visible JSON is equal.
          if (roomTxId >= 0) {
            const baseline = new LoroDoc();
            try {
              baseline.import(state.snapshot.bytes);
              const before = doc.version();
              const next = baseline.version();
              try {
                const relation = next.compare(before);
                if (relation === undefined || relation < 0)
                  throw new NativeSessionReaderUnavailable(
                    'Native Session snapshot does not cover its reader'
                  );
              } finally {
                before.free();
                next.free();
              }
            } finally {
              baseline.free();
            }
          }
          roomTxId = state.snapshot.txId;
          const imported = doc.import(state.snapshot.bytes);
          if (imported.pending?.size)
            throw new NativeSessionReaderUnavailable(
              'Native Session snapshot is causally incomplete'
            );
        }
        for (const entry of state.entries) {
          roomTxId = entry.txId;
          const imported = doc.import(entry.bytes);
          if (imported.pending?.size)
            throw new NativeSessionReaderUnavailable('Native Session oplog is causally incomplete');
          anchorTxId = entry.txId;
        }
        roomTxId = state.head;
        compactedTxId = state.compacted;
      } finally {
        refreshing = false;
      }
      if (controlDirty) {
        controlDirty = false;
        for (const listener of [...controlListeners]) {
          try {
            listener();
          } catch {}
        }
      }
    } catch (error) {
      throw invalidate(error);
    }
  };

  try {
    refresh();
    reader = createLoroSessionHistoryReader(doc);
    detachControl = doc.subscribe((batch) => {
      if (batch.events.some((event) => event.path[0] !== 'history')) controlDirty = true;
    });
  } catch (error) {
    close();
    throw error;
  }
  const read = <A>(operation: (source: NonNullable<typeof reader>) => A): A => {
    refresh();
    if (!reader) throw new NativeSessionReaderUnavailable('Native Session reader is closed');
    return operation(reader);
  };
  const rawAt = (segments: readonly (string | number)[]): unknown => {
    if (typeof segments[0] !== 'string') throw new Error('Native Session path requires a root');
    let value: unknown = doc.getByPath(segments[0]);
    for (const segment of segments.slice(1)) {
      if (isContainer(value)) {
        if (value.kind() === 'Map' && typeof segment === 'string')
          value = (value as LoroMap).get(segment);
        else if (
          (value.kind() === 'List' || value.kind() === 'MovableList') &&
          typeof segment === 'number'
        )
          value = (value as LoroList | LoroMovableList).get(segment);
        else return undefined;
      } else if (Array.isArray(value) && typeof segment === 'number') value = value[segment];
      else if (value && typeof value === 'object' && typeof segment === 'string')
        value = (value as Record<string, unknown>)[segment];
      else return undefined;
    }
    return value;
  };
  let planningPatches: AgentHistoryPatch[] | undefined;
  const agentWindow = createAgentHistoryWindow(
    doc,
    prepareReplacement,
    historyValuesEqual,
    (patch) => {
      if (!planningPatches) throw new Error('Native Session agent plan is not active');
      planningPatches.push(patch);
    }
  );
  const view = (source: NonNullable<typeof reader>): NativeSessionReadView => ({
    history: source.history,
    positionOfTurn: source.positionOfTurn,
    lengthAt: (segments) => {
      const value = rawAt(segments);
      return Array.isArray(value)
        ? value.length
        : isContainer(value) && (value.kind() === 'List' || value.kind() === 'MovableList')
          ? (value as LoroList).length
          : 0;
    },
    readQuery: source.readQuery,
    planAgentUpdate(id, targets, updater) {
      if (planningPatches) throw new Error('Nested native Session agent plans are unsupported');
      const patches: AgentHistoryPatch[] = [];
      planningPatches = patches;
      try {
        // The shared window only reads/plans. It never authors or commits this doc.
        return { handled: agentWindow.update(id, targets, updater), patches };
      } finally {
        planningPatches = undefined;
      }
    },
    valueAt(segments) {
      if (closed || failed)
        throw failed ?? new NativeSessionReaderUnavailable('Native Session reader is closed');
      const value = rawAt(segments);
      if (segments[0] === 'mq') {
        const row = (entry: unknown) =>
          isContainer(entry) && entry.kind() === 'Map'
            ? { ...entry.toJSON(), $cid: entry.id }
            : entry;
        if (segments.length === 1 && isContainer(value) && value.kind() === 'MovableList')
          return Array.from({ length: (value as LoroMovableList).length }, (_, index) =>
            row((value as LoroMovableList).get(index))
          );
        if (segments.length === 2) return row(value);
        if (segments.length === 3 && segments[2] === '$cid') {
          const entry = rawAt(segments.slice(0, 2));
          if (isContainer(entry) && entry.kind() === 'Map') return entry.id;
        }
      }
      return isContainer(value) ? value.toJSON() : value;
    },
    kindAt(segments) {
      if (closed || failed)
        throw failed ?? new NativeSessionReaderUnavailable('Native Session reader is closed');
      const value = rawAt(segments);
      if (value === undefined) return 'missing';
      if (!isContainer(value)) return 'value';
      const kind = value.kind();
      if (kind === 'Map') return 'map';
      if (kind === 'List') return 'list';
      if (kind === 'MovableList') return 'movable_list';
      if (kind === 'Text') return 'text';
      throw new NativeSessionReaderUnavailable('Unsupported native Session container');
    },
  });
  const history = {
    count: () => read((source) => source.history.count()),
    readAt: (position: number) => read((source) => source.history.readAt(position)),
    readTurn: (turnId: string) => read((source) => source.history.readTurn(turnId)),
    readTurnForDisplay: (turnId: string) =>
      read((source) => source.history.readTurnForDisplay(turnId)),
    readSubagentRun: (turnId: string, sessionId: string, runId: string) =>
      read((source) => source.history.readSubagentRun(turnId, sessionId, runId)),
    readRange: (from: number, to: number) => read((source) => source.history.readRange(from, to)),
    readDirectory: (from: number, to: number) =>
      read((source) => source.history.readDirectory(from, to)),
    readAll: () => read((source) => source.history.readAll()),
    readTurnOutput: (turnId: string) => read((source) => source.history.readTurnOutput(turnId)),
    readModelSummaryAt: (position: number) =>
      read((source) => source.history.readModelSummaryAt(position)),
    observe: (listener: Parameters<NonNullable<typeof reader>['history']['observe']>[0]) =>
      read((source) => source.history.observe(listener)),
  };
  return {
    history,
    observeControl(listener: () => void) {
      read(() => {
        controlListeners.add(listener);
      });
      return () => {
        controlListeners.delete(listener);
      };
    },
    readLatestGoal: () => read((source) => source.readLatestGoal()),
    readLatestUserId: () => read((source) => source.readLatestUserId()),
    checkpoint: () => read(() => ({ runId, roomTxId })),
    frontiers: () => read(() => doc.frontiers()),
    causalVersion: () => read(() => `${runId}:${roomTxId}`),
    hasCausalFrontiers: (frontiers: readonly { peer: string; counter: number }[]) =>
      read(() => {
        const version = doc.version();
        try {
          return frontiers.every(
            ({ peer, counter }) =>
              Number.isSafeInteger(counter) &&
              counter >= 0 &&
              (version.get(BigInt(peer)) ?? 0) > counter
          );
        } finally {
          version.free();
        }
      }),
    query: <A>(operation: (view: NativeSessionReadView) => A) =>
      read((source) => {
        const value = operation(view(source));
        assertCurrent();
        return { value, checkpoint: { runId, roomTxId } };
      }),
    refresh,
    invalidate,
    close,
  };
}

/**
 * One active room belongs to the caller's per-room Scope. Compose that Scope
 * under the daemon's bounded session cache; this module owns no global cache.
 * Only a tiny session/id projection crosses SDK IPC. whenVisible is woken by
 * namespace watermarks even when history edits leave that selected id unchanged.
 */
export const makeNativeSessionReader = Effect.fnUntraced(function* (
  options: ReaderOptions & {
    readonly client: Pick<
      RepoClient,
      'subscribeDoc' | 'onConnectionStateChange' | 'connectionState'
    > &
      Partial<Pick<RepoClient, 'readDoc' | 'transactCas'>>;
    readonly compatibility?: NativeSessionSdkCompatibility;
  }
) {
  z.string().min(1).parse(options.namespace);
  z.string().min(1).parse(options.sessionId);
  const subscriptions = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createNativeMachineCatalogObservations(options.client, options.cleanupTimeoutMs)
    ),
    (owner) => Effect.promise(() => owner.close())
  );
  const acquired = yield* Effect.tryPromise({
    try: () =>
      subscriptions.acquire(
        () =>
          options.client.subscribeDoc(
            options.namespace,
            { kind: 'loro_doc', id: `session-${options.sessionId}` },
            ['session', 'id']
          ),
        () => {}
      ),
    catch: (cause) => cause,
  });
  const subscription = acquired.handle;
  const projection = yield* Effect.acquireRelease(
    Effect.try({ try: () => openProjection(options), catch: (cause) => cause }),
    (owner) => Effect.sync(() => owner.close())
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      options.client.onConnectionStateChange((state) => {
        if (state !== 'connected') return;
        // A replacement engine can reset namespace tx IDs below the old waiter.
        // Reconnect must check the run identity without waiting to pass that ID.
        try {
          projection.refresh();
        } catch (error) {
          projection.invalidate(error);
        }
      })
    ),
    (unsubscribe) => Effect.sync(unsubscribe)
  );
  yield* Effect.forever(
    Effect.gen(function* () {
      const next = subscription.lastTxId + 1;
      yield* Effect.tryPromise({
        try: () => subscription.whenVisible(next),
        catch: (cause) => cause,
      });
      yield* Effect.try({ try: () => projection.refresh(), catch: (cause) => cause });
    })
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        projection.invalidate(error);
      })
    ),
    Effect.forkScoped
  );
  const base = {
    history: projection.history,
    observeControl: projection.observeControl,
    readLatestGoal: projection.readLatestGoal,
    readLatestUserId: projection.readLatestUserId,
    checkpoint: projection.checkpoint,
    frontiers: projection.frontiers,
    causalVersion: projection.causalVersion,
    hasCausalFrontiers: projection.hasCausalFrontiers,
    query: projection.query,
  };
  const queryLossless = createNativeSessionLosslessQueries({
    reader: () => base,
    client: options.client,
    namespace: options.namespace,
    sessionId: options.sessionId,
    compatibility: options.compatibility,
  });
  const historyLossless: SessionHistoryReader = {
    ...base.history,
    readAt: async (position) =>
      (await queryLossless((view) => view.history.readAt(position))).value,
    readTurn: async (id) => (await queryLossless((view) => view.history.readTurn(id))).value,
    readTurnForDisplay: async (id) =>
      (await queryLossless((view) => view.history.readTurnForDisplay(id))).value,
    readSubagentRun: async (id, sessionId, runId) =>
      (await queryLossless((view) => view.history.readSubagentRun(id, sessionId, runId))).value,
    readRange: async (from, to) =>
      (await queryLossless((view) => view.history.readRange(from, to))).value,
    readAll: async () => (await queryLossless((view) => view.history.readAll())).value,
    readTurnOutput: async (id) =>
      (await queryLossless((view) => view.history.readTurnOutput(id))).value,
  };
  return { ...base, queryLossless, historyLossless };
});

export type NativeSessionReader = Effect.Success<ReturnType<typeof makeNativeSessionReader>>;
