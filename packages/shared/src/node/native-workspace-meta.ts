import { isDeepStrictEqual } from 'node:util';
import {
  META_ROOM,
  RepoRpcError,
  type FlockOp,
  type JsonValue,
  type RepoClient,
} from '@loro-dev/loro-repo-client';
import { projectWorkspaceDirectory } from '../workspace-directory';
import {
  requireNativeFlockEntries,
  exportNativeFlockRaw,
  type NativeFlockStateEntry,
} from './native-repo-flock-entries';
import type { NativeRepoSdkCompatibility } from './native-repo-sdk-compatibility';
import { createNativeMachineCatalogObservations } from './native-machine-catalog-observations';

export type NativeWorkspaceMetaSnapshot = {
  revision: number;
  docs: readonly { docId: string; deleted: boolean; meta: Record<string, unknown> }[];
  flockDocs: readonly { flockDocId: string; deleted: boolean; expiresAtMs?: number }[];
};
export type NativeWorkspaceMetaCommand =
  | { kind: 'ensure-doc' | 'delete-doc' | 'restore-doc' | 'purge-doc'; docId: string }
  | { kind: 'upsert-doc'; docId: string; patch: Record<string, unknown> }
  | { kind: 'ensure-flock'; flockDocId: string; expiresAtMs?: number }
  | { kind: 'delete-flock' | 'restore-flock' | 'purge-flock'; flockDocId: string };
type Update = { snapshot: NativeWorkspaceMetaSnapshot; by: 'local' | 'sync' | 'live' };
const documentFamilies = new Set(['e', 'm', 'f', 'ld', 'ts']);
const hasDocumentRegisters = (rows: readonly NativeFlockStateEntry[], docId: string) =>
  rows.some(row => row.key[1] === docId && typeof row.key[0] === 'string' && documentFamilies.has(row.key[0]));
/** Node-only whole-workspace Meta owner. Its client, journal grant and engine
 * artifact are borrowed from one trusted generation; it never creates a room,
 * retries an unknown write, or writes a legacy cache. */
export function createNativeWorkspaceMeta(options: {
  binding: { accountId: string; workspaceId: string };
  generation: string;
  client: RepoClient;
  sdkCompatibility: NativeRepoSdkCompatibility | undefined;
  sdkArtifactId: string | undefined;
  assertCurrent(): void;
  closeTimeoutMs?: number;
}) {
  const { client } = options;
  const port = requireNativeFlockEntries(client, {
    compatibility: options.sdkCompatibility,
    sdkArtifactId: options.sdkArtifactId,
  });
  const observations = createNativeMachineCatalogObservations(
    client,
    options.closeTimeoutMs ?? 5000
  );
  let retired = false;
  let revision = 0;
  let roomTxId = -1;
  let snapshot: NativeWorkspaceMetaSnapshot = { revision, docs: [], flockDocs: [] };
  let failure: unknown;
  let failed = false;
  const listeners = new Set<(update: Update) => void>();
  const operations = new Set<Promise<unknown>>();
  const check = () => {
    if (retired || client.connectionState !== 'connected')
      throw new Error('Native Meta owner requires a fresh generation');
    options.assertCurrent();
  };
  const clone = () => structuredClone(snapshot);
  const project = (
    rows: NativeFlockStateEntry[],
    nextRevision: number
  ): NativeWorkspaceMetaSnapshot => {
    const projected = projectWorkspaceDirectory(
      rows.map((row) => ({ key: row.key, value: row.deleted ? undefined : row.value }))
    );
    const flock = new Map<string, { flockDocId: string; deleted: boolean; expiresAtMs?: number }>();
    for (const row of rows) {
      if (row.key.length !== 2 || typeof row.key[1] !== 'string') continue;
      const id = row.key[1];
      if (row.key[0] === 'ef' && !row.deleted && typeof row.value === 'boolean')
        flock.set(id, { flockDocId: id, deleted: !row.value });
    }
    for (const row of rows) {
      if (
        row.key[0] === 'efx' &&
        row.key.length === 2 &&
        typeof row.key[1] === 'string' &&
        !row.deleted &&
        typeof row.value === 'number' &&
        Number.isFinite(row.value) &&
        row.value >= 0
      ) {
        const entry = flock.get(row.key[1]);
        if (entry) entry.expiresAtMs = row.value;
      }
    }
    return {
      revision: nextRevision,
      docs: projected.entries
        .filter((row) => row.exists !== undefined)
        .map((row) => ({ docId: row.docId, deleted: row.exists === false, meta: row.meta })),
      flockDocs: [...flock.values()],
    };
  };
  const accept = (rows: NativeFlockStateEntry[], txId: number, by: Update['by']) => {
    check();
    if (txId <= roomTxId) return;
    roomTxId = txId;
    snapshot = project(rows, ++revision);
    for (const listener of listeners) {
      try {
        listener({ snapshot: clone(), by });
      } catch {}
    }
  };
  const read = async () => {
    check();
    const result = await port.scan(options.binding.workspaceId, META_ROOM);
    check();
    accept(result.entries, result.roomTxId, 'live');
    return clone();
  };
  const feed = observations
    .acquire(
      async () => {
        return port.subscribe(options.binding.workspaceId, META_ROOM, {}, (rows, info) => {
          if (retired) return;
          try {
            accept(rows, info.roomTxId, info.origin === 'local' ? 'local' : 'sync');
          } catch (error) {
            failed = true;
            failure = error;
          }
        });
        // The complete scan below is after registration. Older in-flight callbacks
        // cannot roll it back because accept compares the actual room transaction.
      },
      () => {}
    )
    .then(async (lease) => {
      await read();
      return lease;
    });
  void feed.catch(() => {});
  const own = <A>(body: () => Promise<A>): Promise<A> => {
    const work = body();
    operations.add(work);
    void work.finally(() => operations.delete(work)).catch(() => {});
    return work;
  };
  const commit = (
    command: NativeWorkspaceMetaCommand,
    mustBeAlive = false,
    planPatch?: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
    authorize?: (current: NativeWorkspaceMetaSnapshot) => void,
    pristineDocument = false
  ) =>
    own(async () => {
      const intent = structuredClone(command);
      check();
      if (failed) throw failure;
      await feed;
      const id = 'docId' in intent ? intent.docId : intent.flockDocId;
      if (!id || id.length > 4096) throw new Error('Invalid native Meta document id');
      if (
        intent.kind === 'ensure-flock' &&
        intent.expiresAtMs !== undefined &&
        (!Number.isFinite(intent.expiresAtMs) || intent.expiresAtMs < 0)
      )
        throw new Error('Invalid native Meta expiry');
      const family = 'docId' in intent ? 'e' : 'ef';
      for (let attempt = 0; attempt < 8; attempt++) {
        check();
        const state = await port.scan(options.binding.workspaceId, META_ROOM);
        check();
        const authorization: unknown = authorize?.(
          structuredClone(project(state.entries, revision))
        );
        if (authorization !== undefined)
          throw new Error('Native Meta authorization must be synchronous');
        if (pristineDocument && hasDocumentRegisters(state.entries, id))
          throw new Error('Native Meta document already has register history');
        const existence = state.entries.find(
          (row) => row.key.length === 2 && row.key[0] === family && row.key[1] === id
        );
        const exists = existence && !existence.deleted ? existence.value : undefined;
        if (mustBeAlive && exists !== true) throw new Error('Native Meta document is not active');
        const patch =
          intent.kind === 'upsert-doc' && planPatch
            ? planPatch(
                structuredClone(
                  projectWorkspaceDirectory(
                    state.entries.map((row) => ({
                      key: row.key,
                      value: row.deleted ? undefined : row.value,
                    }))
                  ).entries.find((row) => row.docId === id)?.meta ?? {}
                )
              )
            : intent.kind === 'upsert-doc'
              ? intent.patch
              : undefined;
        if (
          patch !== undefined &&
          (patch === null ||
            typeof patch !== 'object' ||
            (Object.getPrototypeOf(patch) !== Object.prototype &&
              Object.getPrototypeOf(patch) !== null))
        )
          throw new Error('Native Meta planner must return a synchronous field patch');
        if (planPatch && patch === undefined) {
          accept(state.entries, state.roomTxId, 'live');
          return { outcome: 'committed' as const, snapshot: clone() };
        }
        const ops: FlockOp[] = [];
        const put = (key: string[], value: unknown) => {
          const before = state.entries.find((row) => isDeepStrictEqual(row.key, key));
          if (!before || before.deleted || !isDeepStrictEqual(before.value, value))
            ops.push({ op: 'put', key, value: structuredClone(value) as JsonValue });
        };
        if (intent.kind === 'purge-doc' || intent.kind === 'purge-flock') {
          const families =
            intent.kind === 'purge-doc' ? ['e', 'm', 'f', 'ld', 'ts'] : ['ef', 'efx'];
          for (const row of state.entries)
            if (!row.deleted && row.key[1] === id && typeof row.key[0] === 'string' && families.includes(row.key[0]))
              ops.push({ op: 'delete', key: row.key as JsonValue[] });
        } else if (intent.kind === 'delete-doc' || intent.kind === 'delete-flock')
          put([family, id], false);
        else if (intent.kind === 'restore-doc' || intent.kind === 'restore-flock') {
          if (exists === false) put([family, id], true);
        } else {
          if (exists === undefined) put([family, id], true);
          if (intent.kind === 'upsert-doc')
            for (const [field, value] of Object.entries(patch ?? {})) {
              if (value === undefined) {
                const leaf = state.entries.find((row) =>
                  isDeepStrictEqual(row.key, ['m', id, field])
                );
                const inline = state.entries.find((row) => isDeepStrictEqual(row.key, ['m', id]));
                // A delete of a never-existing key is a Flock no-op. Establish and
                // delete this one owned field in the same atomic batch so a legacy
                // inline value remains masked by an actual tombstone after restart.
                if (
                  !leaf &&
                  inline &&
                  !inline.deleted &&
                  inline.value &&
                  typeof inline.value === 'object' &&
                  !Array.isArray(inline.value) &&
                  Object.hasOwn(inline.value, field)
                )
                  ops.push({ op: 'put', key: ['m', id, field], value: null });
                if (!leaf?.deleted) ops.push({ op: 'delete', key: ['m', id, field] });
              } else put(['m', id, field], value);
            }
          if (intent.kind === 'ensure-flock' && intent.expiresAtMs !== undefined) {
            const ttl = state.entries.find(
              (row) => row.key.length === 2 && row.key[0] === 'efx' && row.key[1] === id
            );
            if (
              !ttl ||
              ttl.deleted ||
              typeof ttl.value !== 'number' ||
              intent.expiresAtMs > ttl.value
            )
              put(['efx', id], intent.expiresAtMs);
          }
        }
        if (!ops.length) {
          accept(state.entries, state.roomTxId, 'live');
          return { outcome: 'committed' as const, snapshot: clone() };
        }
        try {
          await client.flockBatch(options.binding.workspaceId, META_ROOM, ops, {
            precondition: { mode: 'cas', expected_room_tx_id: state.roomTxId },
          });
          check();
          return { outcome: 'committed' as const, snapshot: await read() };
        } catch (error) {
          if (error instanceof RepoRpcError && error.code === 'precondition_failed') continue;
          // A sent intent with unknown outcome is never submitted again by this
          // owner, including through body persistence or shutdown flush.
          failed = true;
          failure = error;
          throw error;
        }
      }
      throw new Error('Native Meta changed during bounded CAS retries');
    });
  const flush = () =>
    own(async () => {
      check();
      if (failed) throw failure;
      await Promise.all([...operations]);
      await feed;
      return { outcome: 'committed' as const, snapshot: await read() };
    });
  const externalMetadata = {
    capability: 'loro-external-metadata-v1' as const,
    async open(onUpdate: (update: Update) => void) {
      check();
      listeners.add(onUpdate);
      try {
        await feed;
        return {
          snapshot: await read(),
          unsubscribe: () => {
            listeners.delete(onUpdate);
          },
        };
      } catch (error) {
        listeners.delete(onUpdate);
        throw error;
      }
    },
    read,
    commit,
    flush,
  };
  return {
    binding: Object.freeze({ ...options.binding }),
    generation: options.generation,
    assertCurrent: check,
    /** Read-only recovery signal. Replacement requires confirmed close and a
     * fresh authoritative read; this instance never resubmits a failed intent. */
    isWriteBlocked: () => failed,
    externalMetadata,
    commitAuthorized(
      command: NativeWorkspaceMetaCommand,
      authorize: (current: NativeWorkspaceMetaSnapshot) => void
    ) {
      return commit(command, false, undefined, authorize);
    },
    /** Trusted new-Session reservation only: orphan/tombstone history is not
     * absence. The complete assertion and initial fields share one room CAS. */
    createDocumentIfPristine(docId: string, patch: Record<string, unknown>, authorize: (current: NativeWorkspaceMetaSnapshot) => void) {
      return commit({kind: 'upsert-doc', docId, patch}, false, undefined, authorize, true);
    },
    async readDocumentCreationState(docId: string) {
      check();
      const state = await port.scan(options.binding.workspaceId, META_ROOM);
      check();
      return {pristine: !hasDocumentRegisters(state.entries, docId), roomTxId: state.roomTxId, snapshot: structuredClone(project(state.entries, revision))};
    },
    /** Trusted Node backup/migration only; never a renderer DTO. */
    async exportRaw() {
      check();
      const raw = await exportNativeFlockRaw(
        client,
        { compatibility: options.sdkCompatibility, sdkArtifactId: options.sdkArtifactId },
        options.binding.workspaceId,
        META_ROOM
      );
      check();
      return raw.bytes;
    },
    document(docId: string) {
      return {
        async read() {
          const row = (await read()).docs.find((row) => row.docId === docId);
          return row && !row.deleted ? row.meta : undefined;
        },
        async patch(fields: Record<string, unknown>) {
          await commit({ kind: 'upsert-doc', docId, patch: fields }, true);
        },
        /** Pure Node-only planner; the exact complete read and changed leaves
         * are protected by one room-head CAS across all processes. */
        async update(
          transform: (current: Record<string, unknown>) => Record<string, unknown> | undefined
        ) {
          await commit({ kind: 'upsert-doc', docId, patch: {} }, true, transform);
        },
        async flush() {
          await flush();
        },
      };
    },
    async close() {
      retired = true;
      listeners.clear();
      const cleanup = observations.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.allSettled([cleanup, ...operations]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native Meta operations remain pending')),
            options.closeTimeoutMs ?? 5000
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const errors = settled
        .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        .map((item) => item.reason);
      if (errors.length) throw new AggregateError(errors, 'Native Meta cleanup is unconfirmed');
    },
  };
}
