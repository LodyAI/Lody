import { LoroDoc, isContainer, type LoroMap, type LoroList, type LoroMovableList } from 'loro-crdt';
import { historyValuesEqual } from '../history-values-equal';
import {
  createNativeMachineCatalogObservations,
  NativeMachineCatalogCleanupError,
} from './native-machine-catalog-observations';
import type { NativeSessionSdkCompatibility } from './native-session-compatibility';
import { nativeDocumentWireValue } from './native-history-patch';
import type { DocSchema, RepoClient } from '@loro-dev/loro-repo-client';
import { createNativeHistoryPatchPlan } from './native-history-patch';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export type NativeLoroDocumentOptions = {
  readonly client: RepoClient;
  readonly namespace: string;
  readonly roomId: string;
  readonly writer: string;
  readonly schema: DocSchema;
  readonly compatibility?: NativeSessionSdkCompatibility;
  /** Composition-owned local authority/fence; no request field can grant this. */
  readonly assertAccess: () => void;
};

/** One small document read/planning cut. The WASM replica only imports native
 * bytes; it never commits/authors/exports updates back into the engine. */
export async function queryNativeLoroDocument<A>(
  options: NativeLoroDocumentOptions,
  query: (
    value: Record<string, unknown>,
    plan: ReturnType<typeof createNativeHistoryPatchPlan>
  ) => A
) {
  options.assertAccess();
  const room = { kind: 'loro_doc' as const, id: options.roomId };
  // Structural bytes and lossless values must describe exactly the same room cut.
  // A busy peer can invalidate a read, but never turn a rounded WASM value into a write.
  let cut: Awaited<ReturnType<typeof options.client.exportLoroRaw>> | undefined;
  let exact: Awaited<ReturnType<typeof options.client.readDoc>> | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const exported = await options.client.exportLoroRaw(options.namespace, room);
    const value = await options.client.readDoc(options.namespace, room);
    options.assertAccess();
    if (exported.roomTxId === value.roomTxId) {
      cut = exported;
      exact = value;
      break;
    }
  }
  if (!cut || !exact) throw new Error('Native document read cut changed');
  const exported = cut;
  const value = nativeDocumentWireValue(exact.value, options.compatibility);
  if (!record(value)) throw new Error('Invalid native document root');
  const exactAt = (path: readonly (string | number)[]) => {
    let item: unknown = value;
    for (const key of path) {
      if (Array.isArray(item) && typeof key === 'number') item = item[key];
      else if (record(item) && typeof key === 'string') item = item[key];
      else return undefined;
    }
    return item;
  };
  options.assertAccess();
  const doc = new LoroDoc();
  try {
    const imported = doc.import(exported.bytes);
    if (imported.pending?.size) throw new Error('Native document snapshot is causally incomplete');
    const rawAt = (path: readonly (string | number)[]) => {
      let value: unknown = doc.getByPath(String(path[0]));
      for (const segment of path.slice(1)) {
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
        else if (record(value) && typeof segment === 'string') value = value[segment];
        else return undefined;
      }
      return value;
    };
    const plan = createNativeHistoryPatchPlan(
      {
        valueAt(path) {
          return exactAt(path);
        },
        kindAt(path) {
          let value: unknown;
          try {
            value = rawAt(path);
          } catch {
            // The WASM facade rejects scalar i64 values it cannot represent.
            // Its parent still establishes that this is an atomic value.
            if (exactAt(path) !== undefined) return 'value';
            throw new Error('Native document structure is unavailable');
          }
          if (value === undefined) return 'missing';
          if (!isContainer(value)) return 'value';
          const kind = value.kind();
          if (kind === 'Map') return 'map';
          if (kind === 'List') return 'list';
          if (kind === 'MovableList') return 'movable_list';
          if (kind === 'Text') return 'text';
          throw new Error('Unsupported native document container');
        },
      },
      options.schema,
      options.compatibility
    );
    return { result: query(value, plan), roomTxId: exported.roomTxId, ...plan.finish() };
  } finally {
    doc.free();
  }
}

export async function mutateNativeLoroDocument<A>(
  options: NativeLoroDocumentOptions,
  prepare: (
    value: Record<string, unknown>,
    plan: ReturnType<typeof createNativeHistoryPatchPlan>
  ) => A
): Promise<A> {
  return options.client.transactCas(async () => {
    const planned = await queryNativeLoroDocument(options, prepare);
    options.assertAccess();
    if (planned.patch.length)
      await options.client.applyDocPatch(
        options.namespace,
        { kind: 'loro_doc', id: options.roomId },
        planned.patch,
        {
          writer: options.writer,
          docSchema: planned.docSchema,
          precondition: { mode: 'cas', expected_room_tx_id: planned.roomTxId },
        }
      );
    return planned.result;
  });
}

/** Partial root updates retain peer roots and every unchanged nested container. */
export function planNativeDocumentFields(
  plan: ReturnType<typeof createNativeHistoryPatchPlan>,
  before: Record<string, unknown>,
  next: Record<string, unknown>
) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)]))
    if (!historyValuesEqual(before[key], next[key]))
      plan.sparse({ path: [key], before: before[key], next: next[key] });
}

/** Each observer owns its actual acquisition/unsubscribe until ACK or transport
 * loss. Retiring delivery never destroys the borrowed RepoClient. */
export async function observeNativeLoroDocument<A>(
  options: NativeLoroDocumentOptions,
  project: (value: unknown) => A,
  listener: (value: A) => void,
  onError: (error: unknown) => void
) {
  options.assertAccess();
  const owner = createNativeMachineCatalogObservations(options.client);
  let closed = false,
    published = false;
  const publish = (value: unknown) => {
    if (closed) return;
    try {
      options.assertAccess();
      listener(project(value));
      published = true;
    } catch (error) {
      closed = true;
      owner.retire();
      try {
        onError(error);
      } catch {
        /* Domain listener failures do not escape into the shared SDK transport. */
      }
    }
  };
  try {
    const acquired = await owner.acquire(
      () =>
        options.client.subscribeDoc(
          options.namespace,
          { kind: 'loro_doc', id: options.roomId },
          [],
          publish
        ),
      () => {
        closed = true;
      }
    );
    options.assertAccess();
    if (!published) publish(acquired.currentValue());
    const handle = acquired.handle;
    // Namespace watermarks only wake this watcher. They never publish a snapshot.
    void (async () => {
      try {
        while (!closed) await handle.whenVisible(handle.lastTxId + 1);
      } catch (error) {
        if (!closed) {
          closed = true;
          owner.retire();
          try {
            onError(error);
          } catch {
            /* The observer is already retired. */
          }
        }
      }
    })();
    return { close: () => owner.close(), retryCleanup: () => owner.retryCleanup() };
  } catch (error) {
    try {
      await owner.close();
    } catch (cleanup) {
      throw new NativeMachineCatalogCleanupError([error, cleanup], () => owner.close());
    }
    throw error;
  }
}
