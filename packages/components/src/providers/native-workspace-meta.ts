import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  EXTERNAL_DOCS_CAPABILITY,
  EXTERNAL_FLOCK_DOCS_CAPABILITY,
  type ExternalDocsAdapter,
  ExternalMetadataNotCommittedError,
  INCREMENTAL_EXTERNAL_METADATA_CAPABILITY,
  type ExternalFlockDocsAdapter,
  type IncrementalExternalMetadataAdapter,
  type JsonObject,
  type StorageAdapter,
} from 'loro-repo';
import {
  NATIVE_DOC_PATHS_CHANNEL,
  NATIVE_DOC_CHANNEL,
  NATIVE_FLOCK_CHANNEL,
  isNativeDocId,
  NATIVE_META_CHANNEL,
  isNativeFlockDocId,
  ownedLegacyFlockDocIds,
} from '@lody/shared/native-workspace-meta-ipc';
import { registersToBundle } from '@lody/shared/native-flock-bundle';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import {
  RemoteWriteConflictError,
  RemoteWriteIndeterminateError,
  type RemoteSessionDocPort,
} from '@lody/shared/session-data';

/** A receipt's revision normally arrives before the IPC reply; bound the gap. */
const RECEIPT_VISIBILITY_MS = 10_000;

/**
 * Native Workspace Meta for an Electron local renderer, through main's domain
 * IPC. Returns null unless main reports the mode enabled for this workspace.
 * This window's frozen legacy replica is offered once for an LWW merge.
 */
export async function openRendererNativeWorkspaceMeta(
  workspaceId: string,
  legacyStorage: StorageAdapter,
  replicaName: string
): Promise<IncrementalExternalMetadataAdapter<JsonObject> | null> {
  const api = getIpcServices()?.nativeWorkspaceMeta;
  if (!api || !(await api.available({ workspaceId }))) return null;

  const source = `renderer:${replicaName.replace(/[^\w.-]/g, '_').slice(0, 128)}`;
  const importedKey = `lody.nativeWorkspaceMeta.imported.v3.${workspaceId}.${source}`;
  if (localStorage.getItem(importedKey) !== '1') {
    const empty = { version: 0, entries: {} };
    const legacy = await legacyStorage.loadMeta();
    await api.importLegacy({ workspaceId, source, bundle: legacy ? legacy.exportJson() : empty });
    const stored = (await legacyStorage.inventory?.())?.flockDocIds ?? [];
    for (const flockDocId of ownedLegacyFlockDocIds(workspaceId, stored)) {
      const body = await legacyStorage.loadFlockDoc?.(flockDocId);
      await api.importLegacy({
        workspaceId,
        flockDocId,
        source,
        bundle: body ? body.exportJson() : empty,
      });
    }
    localStorage.setItem(importedKey, '1');
  }

  let delivered = -1;
  const waiters = new Set<{ revision: number; resolve: () => void }>();
  return {
    capability: INCREMENTAL_EXTERNAL_METADATA_CAPABILITY,
    async open(listener) {
      const observationId = crypto.randomUUID();
      const stop = onIpcEvent(NATIVE_META_CHANNEL, (event) => {
        if (event.observationId !== observationId) return;
        const update = event.update;
        delivered = update.kind === 'snapshot' ? update.snapshot.revision : update.changes.revision;
        listener(update);
        for (const waiter of waiters)
          if (waiter.revision <= delivered) {
            waiters.delete(waiter);
            waiter.resolve();
          }
      });
      try {
        const snapshot = await api.open({ workspaceId, observationId });
        delivered = Math.max(delivered, snapshot.revision);
        return {
          snapshot,
          unsubscribe: () => {
            stop();
            void api.release({ observationId }).catch(() => {});
          },
        };
      } catch (error) {
        stop();
        throw error;
      }
    },
    async commit(command) {
      const receipt = await api.commit({ workspaceId, command });
      if (receipt.outcome === 'not-committed')
        throw new ExternalMetadataNotCommittedError(receipt.reason);
      if (receipt.revision > delivered)
        await new Promise<void>((resolve, reject) => {
          const waiter = { revision: receipt.revision, resolve };
          waiters.add(waiter);
          setTimeout(() => {
            if (waiters.delete(waiter)) reject(new Error('native_meta_receipt_not_visible'));
          }, RECEIPT_VISIBILITY_MS);
        });
      return receipt;
    },
    flush: async () => ({ outcome: 'committed', revision: delivered }),
  };
}

/** Owned named Flock documents for this renderer, loaded from and committed through main. */
export function createRendererNativeFlockDocs(workspaceId: string): ExternalFlockDocsAdapter {
  const api = getIpcServices()?.nativeWorkspaceMeta;
  if (!api) throw new Error('native_meta_ipc_unavailable');
  return {
    capability: EXTERNAL_FLOCK_DOCS_CAPABILITY,
    owns: (id) => isNativeFlockDocId(workspaceId, id),
    async open(flockDocId, onChange) {
      const observationId = crypto.randomUUID();
      let snapshot: Uint8Array | undefined;
      let loaded!: () => void;
      const firstSnapshot = new Promise<void>((resolve) => (loaded = resolve));
      const stop = onIpcEvent(NATIVE_FLOCK_CHANNEL, ({ observationId: id, event }) => {
        if (id !== observationId) return;
        if (event.kind === 'snapshot') {
          // A later snapshot is a reload after reconnect: merge it by clock.
          if (snapshot === undefined) {
            snapshot = event.file;
            loaded();
          } else onChange(Flock.fromFile(event.file).exportJson());
        } else if (event.kind === 'changes' && event.registers.length) {
          onChange(registersToBundle(event.registers));
        }
      });
      try {
        // Main sends the snapshot before its reply; both share one ordered channel.
        await api.openFlockDoc({ workspaceId, flockDocId, observationId });
        await firstSnapshot;
      } catch (error) {
        stop();
        throw error;
      }
      return {
        snapshot,
        close: async () => {
          stop();
          await api.release({ observationId });
        },
      };
    },
    commit: (flockDocId, payloads) =>
      api.commitFlockDoc({ workspaceId, flockDocId, payloads: [...payloads] }),
  };
}

/**
 * Owned Loro documents (Sessions) for this renderer, through main. This
 * window's own IndexedDB replica of a document is imported once, on first open.
 */
/**
 * Imports this window's own IndexedDB replica of one document, once. The legacy
 * replica is read only for this and never kept.
 */
export async function migrateRendererLegacyDoc(
  workspaceId: string,
  legacyStorage: StorageAdapter,
  replicaName: string,
  docId: string
) {
  const api = getIpcServices()?.nativeWorkspaceMeta;
  if (!api) throw new Error('native_meta_ipc_unavailable');
  const source = `renderer:${replicaName.replace(/[^\w.-]/g, '_').slice(0, 128)}`;
  if (!(await api.needsLegacyDoc({ workspaceId, docId, source }))) return;
  const legacy = (await legacyStorage.loadDoc(docId)) ?? new LoroDoc();
  await api.importLegacyDoc({
    workspaceId,
    docId,
    source,
    snapshot: legacy.export({ mode: 'snapshot' }),
    version: Object.fromEntries(legacy.oplogVersion().toJSON()),
  });
}

export function createRendererNativeDocs(
  workspaceId: string,
  legacyStorage: StorageAdapter,
  replicaName: string
): ExternalDocsAdapter {
  const api = getIpcServices()?.nativeWorkspaceMeta;
  if (!api) throw new Error('native_meta_ipc_unavailable');
  const migrate = (docId: string) =>
    migrateRendererLegacyDoc(workspaceId, legacyStorage, replicaName, docId);
  return {
    capability: EXTERNAL_DOCS_CAPABILITY,
    owns: isNativeDocId,
    async open(docId, onUpdate, known) {
      await migrate(docId);
      const observationId = crypto.randomUUID();
      let first: Uint8Array | undefined;
      let loaded!: () => void;
      const firstSnapshot = new Promise<void>((resolve) => (loaded = resolve));
      const stop = onIpcEvent(NATIVE_DOC_CHANNEL, ({ observationId: id, event }) => {
        if (id !== observationId) return;
        if (event.kind === 'snapshot') {
          // A later snapshot is a reload after reconnect: it imports as an update.
          if (first === undefined) {
            first = event.file;
            loaded();
          } else onUpdate(event.file);
        } else if (event.kind === 'changes') {
          for (const update of event.updates) onUpdate(update);
        }
      });
      try {
        // Main sends the snapshot before its reply; both share one ordered channel.
        await api.openDoc({
          workspaceId,
          docId,
          observationId,
          ...(known ? { since: { ...known.version } } : {}),
        });
        await firstSnapshot;
      } catch (error) {
        stop();
        throw error;
      }
      const close = async () => {
        stop();
        await api.release({ observationId });
      };
      // With `known`, main sent only the ops past that version.
      if (!first?.byteLength) return { close };
      return known ? { update: first, close } : { snapshot: first, close };
    },
    commit: (docId, updates) => api.commitDoc({ workspaceId, docId, updates: [...updates] }),
  };
}

/**
 * A remote Session document for this renderer, through main: bounded reads,
 * one changed-path view per call, and checked patch commits. No replica.
 */
export function createRendererRemoteSessionPort(
  workspaceId: string,
  docId: string
): RemoteSessionDocPort {
  const api = getIpcServices()?.nativeWorkspaceMeta;
  if (!api) throw new Error('native_meta_ipc_unavailable');
  const readPathAt = (path: readonly (string | number)[]) =>
    api.readDocPath({ workspaceId, docId, path: [...path] });
  return {
    readListFields: (start, end, fields) =>
      api.readDocListFields({
        workspaceId,
        docId,
        start,
        ...(end !== undefined ? { end } : {}),
        fields: fields.map((field) => ({
          path: [...field.path],
          ...(field.shape ? { shape: true } : {}),
        })),
      }),
    readPathAt,
    readPath: async (path) => (await readPathAt(path)).value,
    async applyPatch(ops, precondition) {
      try {
        return await api.applyDocPatch({
          workspaceId,
          docId,
          ops: ops as never,
          precondition,
        });
      } catch (error) {
        const message = String((error as Error | undefined)?.message ?? error);
        if (message.includes('native_doc_write_conflict')) throw new RemoteWriteConflictError();
        if (message.includes('native_doc_write_indeterminate'))
          throw new RemoteWriteIndeterminateError(error);
        // A reply lost between main and this window is also an unknown outcome.
        if (/ipc|disconnected|destroyed|timed? ?out/i.test(message))
          throw new RemoteWriteIndeterminateError(error);
        throw error;
      }
    },
    observePaths(listener) {
      const observationId = crypto.randomUUID();
      const stop = onIpcEvent(NATIVE_DOC_PATHS_CHANNEL, ({ observationId: id, event }) => {
        if (id === observationId) listener(event);
      });
      const ready = api.observeDocPaths({ workspaceId, docId, observationId }).catch((error) => {
        stop();
        throw error;
      });
      return {
        ready,
        close() {
          stop();
          void api.release({ observationId }).catch(() => {});
        },
      };
    },
  };
}
