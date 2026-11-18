import type { RepoClient } from '@loro-dev/loro-repo-client';
import { META_ROOM } from '@loro-dev/loro-repo-client';
import { requireNativeFlockEntries } from './native-repo-flock-entries';
import type { NativeRepoSdkCompatibility } from './native-repo-sdk-compatibility';
import { createNativeMachineCatalogObservations } from './native-machine-catalog-observations';
import {
  projectWorkspaceDirectory,
  WorkspaceDirectoryError,
  type WorkspaceDirectory,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectoryObservation,
  type WorkspaceDirectoryAuthority,
} from '../workspace-directory';

const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((v, i) => v === b[i]);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = Object.keys(a);
    const bb = Object.keys(b);
    return (
      aa.length === bb.length &&
      aa.every(
        (key) =>
          Object.hasOwn(b, key) &&
          equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
      )
    );
  }
  return false;
};
/** Read/observe only. No ensureRoom, document-body acquisition or legacy fallback. */
export function createNativeWorkspaceDirectory(options: {
  namespace: string;
  getClient(): Promise<RepoClient>;
  sdkCompatibility?: NativeRepoSdkCompatibility;
  /** Artifact attested by this exact borrowed client generation. */
  getClientArtifactId?(client: RepoClient): Promise<string | undefined>;
  assertAccess(): void;
  authority: { get(): WorkspaceDirectoryAuthority; subscribe(listener: () => void): () => void };
  closeTimeoutMs?: number;
}): WorkspaceDirectory & { close(): Promise<void> } {
  let closed = false;
  let lastClient: RepoClient | undefined;
  let projectionSupported = false;
  const authorityListeners = new Set<() => void>();
  let offClient = () => {};
  const notifyAuthority = () => {
    for (const listener of authorityListeners) {
      try {
        listener();
      } catch {}
    }
  };
  const offAuthority = options.authority.subscribe(notifyAuthority);
  const bindClient = (client: RepoClient) => {
    if (lastClient === client) return;
    offClient();
    projectionSupported = false;
    lastClient = client;
    offClient = client.onConnectionStateChange(notifyAuthority);
    notifyAuthority();
  };
  const observationOwners = new Set<ReturnType<typeof createNativeMachineCatalogObservations>>();
  const acquisitions = new Set<Promise<unknown>>();
  const check = () => {
    if (closed) throw new Error('Workspace directory owner is closed');
    options.assertAccess();
  };
  const wait = async (work: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Workspace directory release remains pending')),
            options.closeTimeoutMs ?? 5000
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const canonical = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      value.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          !Array.isArray(row.key) ||
          typeof row.deleted !== 'boolean' ||
          !Object.hasOwn(row, 'value') ||
          row.value === undefined ||
          (row.deleted && row.value !== null)
      )
    )
      throw new Error('Malformed complete native metadata projection');
    // The explicit SDK entry projection preserves deleted leaves separately from
    // live nulls. Map them only at this legacy directory view boundary; never
    // rewrite the original registers, clocks, opaque values or binary snapshot.
    const rows = value as Array<{ key: readonly unknown[]; deleted: boolean; value: unknown }>;
    return rows.map((row) => ({ key: row.key, value: row.deleted ? undefined : row.value }));
  };
  const read = async (mode: 'full' | 'existence' = 'full') => {
    check();
    const client = await options.getClient();
    check();
    bindClient(client);
    try {
      // This is a separate SDK operation: an old engine rejects it rather than
      // silently dropping an unfamiliar query flag and resurrecting inline data.
      const entriesPort = requireNativeFlockEntries(client, {
        compatibility: options.sdkCompatibility,
        sdkArtifactId: await options.getClientArtifactId?.(client),
      });
      const snapshot = await entriesPort.scan(
        options.namespace,
        META_ROOM,
        mode === 'existence' ? { prefix: ['e'] } : {}
      );
      check();
      const entries = canonical(snapshot.entries);
      if (mode === 'full') {
        projectionSupported = true;
        notifyAuthority();
      }
      return projectWorkspaceDirectory(entries);
    } catch (error) {
      projectionSupported = false;
      notifyAuthority();
      throw error;
    }
  };
  const authority = {
    get: () => {
      const current = options.authority.get();
      let allowed = false;
      try {
        check();
        allowed = true;
      } catch {}
      return {
        ...current,
        synced:
          allowed &&
          projectionSupported &&
          lastClient?.connectionState === 'connected' &&
          current.synced,
      };
    },
    subscribe: (listener: () => void) => {
      authorityListeners.add(listener);
      return () => {
        authorityListeners.delete(listener);
      };
    },
  };
  return {
    authority,
    async listEntries() {
      const state = await read();
      return state.entries
        .filter((entry) => entry.exists === true && state.metadataIds.has(entry.docId))
        .map((entry) => ({ docId: entry.docId, meta: entry.meta, exists: true }));
    },
    async listActiveIds() {
      return (await read('existence')).activeIds;
    },
    async getEntry(id) {
      return (await read()).entries.find((entry) => entry.docId === id);
    },
    observe(listener, onError = () => {}) {
      const acquisition = (async () => {
        check();
        const client = await options.getClient();
        check();
        bindClient(client);
        let retired = false;
        let off = () => {};
        const observationOwner = createNativeMachineCatalogObservations(
          client,
          options.closeTimeoutMs ?? 5000
        );
        observationOwners.add(observationOwner);
        let previous = new Map<string, WorkspaceDirectoryEntry>();
        let initial = true;
        const update = (value: unknown, by = 'remote', reset = false) => {
          if (retired) return;
          try {
            check();
            const rows = canonical(value);
            projectionSupported = true;
            notifyAuthority();
            const entries = projectWorkspaceDirectory(rows).entries;
            const next = new Map(entries.map((entry) => [entry.docId, entry]));
            if (initial || reset) {
              initial = false;
              previous = next;
              listener({ kind: 'snapshot-reset', entries });
              return;
            }
            for (const id of new Set([...previous.keys(), ...next.keys()])) {
              const before = previous.get(id);
              const after = next.get(id);
              const a = before?.exists;
              const b = after?.exists;
              if (a !== b)
                listener({
                  kind: 'doc-existence-changed',
                  docId: id,
                  to: b === true ? 'active' : b === false ? 'deleted' : 'missing',
                });
              const patch: Record<string, unknown> = {};
              for (const key of new Set([
                ...Object.keys(before?.meta ?? {}),
                ...Object.keys(after?.meta ?? {}),
              ]))
                if (!equal(before?.meta[key], after?.meta[key]))
                  Object.defineProperty(patch, key, {
                    value: after && Object.hasOwn(after.meta, key) ? after.meta[key] : null,
                    enumerable: true,
                  });
              if (Object.keys(patch).length)
                listener({ kind: 'doc-metadata', docId: id, patch, by });
            }
            previous = next;
          } catch (error) {
            projectionSupported = false;
            notifyAuthority();
            onError(error);
          }
        };
        const entriesPort = requireNativeFlockEntries(client, {
          compatibility: options.sdkCompatibility,
          sdkArtifactId: await options.getClientArtifactId?.(client),
        });
        const acquired = await observationOwner.acquire(
          () =>
            entriesPort.subscribe(options.namespace, META_ROOM, {}, (value, info) =>
              update(value, info.origin, !!info.resetReason)
            ),
          () => {
            retired = true;
            off();
          }
        );
        off = client.onConnectionStateChange((state) => {
          if (!retired && state === 'closed')
            onError(
              new WorkspaceDirectoryError(
                'restart_required',
                'Workspace directory restart required'
              )
            );
        });
        const lease: WorkspaceDirectoryObservation = {
          async unsubscribe() {
            await observationOwner.close();
            observationOwners.delete(observationOwner);
          },
        };
        try {
          check();
          canonical(acquired.currentValue());
          update(acquired.currentValue());
          return lease;
        } catch (error) {
          try {
            await lease.unsubscribe();
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'Workspace directory observation cleanup unconfirmed'
            );
          }
          throw error;
        }
      })();
      acquisitions.add(acquisition);
      void acquisition.finally(() => acquisitions.delete(acquisition)).catch(() => {});
      return acquisition;
    },
    async close() {
      closed = true;
      offClient();
      offAuthority();
      notifyAuthority();
      const failures: unknown[] = [];
      for (const owner of observationOwners) owner.retire();
      try {
        await wait(Promise.allSettled([...acquisitions]));
      } catch (error) {
        failures.push(error);
      }
      const results = await Promise.allSettled(
        [...observationOwners].map(async (owner) => {
          await owner.close();
          observationOwners.delete(owner);
        })
      );
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length)
        throw new AggregateError(failures, 'Workspace directory cleanup unconfirmed');
    },
  };
}
