import type { LoroRepo } from 'loro-repo';

/** Read-only directory data; opening a document body is never part of a query. */
export type WorkspaceDirectoryEntry = {
  docId: string;
  meta: Record<string, unknown>;
  exists?: boolean;
  deleted?: boolean;
};

/** Initial P1 query boundary. Live observation and authority remain with their existing owners. */
export interface WorkspaceDirectoryReader {
  listEntries(): Promise<WorkspaceDirectoryEntry[]>;
  listActiveIds(): Promise<string[]>;
}

export type WorkspaceDirectoryChange =
  | { kind: 'snapshot-reset'; entries: WorkspaceDirectoryEntry[] }
  | { kind: 'doc-metadata'; docId: string; patch: Record<string, unknown>; by: string }
  | { kind: 'doc-existence-changed'; docId: string; to: 'active' | 'deleted' | 'missing' };

export class WorkspaceDirectoryError extends Error {
  constructor(
    readonly code: 'restart_required' | 'unsupported_inline_metadata',
    message: string
  ) {
    super(message);
  }
}
export type WorkspaceDirectoryAuthority = { synced: boolean; generation: string };
export type WorkspaceDirectoryObservation = { unsubscribe(): void | Promise<void> };

/** Borrowed local projection. Readiness and remote authority belong to the runtime. */
export interface WorkspaceDirectory extends WorkspaceDirectoryReader {
  getEntry(docId: string): Promise<WorkspaceDirectoryEntry | undefined>;
  observe(
    listener: (change: WorkspaceDirectoryChange) => void,
    onError?: (error: unknown) => void
  ): WorkspaceDirectoryObservation | Promise<WorkspaceDirectoryObservation>;
  /** Local projection availability never substitutes for remote authority. */
  readonly authority?: {
    get(): WorkspaceDirectoryAuthority;
    subscribe(listener: () => void): () => void;
  };
}

type Row = { readonly key: readonly unknown[]; readonly value?: unknown };
/** Complete legacy-compatible Meta projection, including inline maps and removed fields. */
export function projectWorkspaceDirectory(rows: Iterable<Row>): {
  entries: WorkspaceDirectoryEntry[];
  activeIds: string[];
  metadataIds: Set<string>;
} {
  const metadata = new Map<string, Record<string, unknown>>();
  const existence = new Map<string, boolean>();
  for (const row of rows) {
    if (
      row.key[0] === 'e' &&
      row.key.length === 2 &&
      typeof row.key[1] === 'string' &&
      typeof row.value === 'boolean'
    ) {
      existence.set(row.key[1], row.value);
      continue;
    }
    if (row.key[0] !== 'm' || typeof row.key[1] !== 'string') continue;
    const id = row.key[1];
    const fields =
      row.key.length === 2 &&
      row.value &&
      typeof row.value === 'object' &&
      !Array.isArray(row.value) &&
      !(row.value instanceof Uint8Array)
        ? Object.entries(row.value as Record<string, unknown>)
        : row.key.length === 3 && typeof row.key[2] === 'string'
          ? [[row.key[2], row.value] as const]
          : undefined;
    if (!fields) continue;
    const meta = metadata.get(id) ?? {};
    metadata.set(id, meta);
    for (const [field, value] of fields)
      Object.defineProperty(meta, field, {
        value: value === undefined ? null : value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return {
    metadataIds: new Set(metadata.keys()),
    activeIds: [...existence].filter(([, active]) => active).map(([id]) => id),
    entries: [...new Set([...metadata.keys(), ...existence.keys()])].map((docId) => ({
      docId,
      meta: metadata.get(docId) ?? {},
      ...(existence.has(docId)
        ? { exists: existence.get(docId), deleted: !existence.get(docId) }
        : {}),
    })),
  };
}
type Scan = (prefix: readonly string[]) => Promise<Iterable<Row>>;

/**
 * Adapter composition only: the scanner stays private to the backend, while
 * callers receive directory records. A local scan is not a remote baseline receipt.
 */
export function createWorkspaceDirectoryReader(scan: Scan): WorkspaceDirectoryReader {
  const readExistence = async () => {
    const state = new Map<string, boolean>();
    for (const row of await scan(['e'])) {
      if (!Array.isArray(row.key) || row.key[0] !== 'e' || typeof row.key[1] !== 'string') continue;
      if (typeof row.value === 'boolean') state.set(row.key[1], row.value);
      else if (row.value === undefined) state.delete(row.key[1]);
    }
    return state;
  };
  return {
    async listActiveIds() {
      return [...(await readExistence())].filter(([, active]) => active).map(([id]) => id);
    },
    async listEntries() {
      const [rows, existence] = await Promise.all([scan(['m']), readExistence()]);
      const metadata = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        if (!Array.isArray(row.key) || row.key.length < 2) continue;
        const [family, id, field] = row.key;
        if (family !== 'm' || typeof id !== 'string') continue;
        if (
          row.key.length === 2 &&
          (!row.value || typeof row.value !== 'object' || Array.isArray(row.value))
        )
          continue;
        if (row.key.length > 2 && typeof field !== 'string') continue;
        const patch = metadata.get(id) ?? {};
        metadata.set(id, patch);
        const fields =
          row.key.length === 2
            ? Object.entries(row.value as Record<string, unknown>)
            : [[field as string, row.value] as const];
        for (const [name, value] of fields) {
          Object.defineProperty(patch, name, {
            value: value === undefined ? null : value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
      return [...metadata]
        .filter(([id]) => existence.get(id) === true)
        .map(([docId, meta]) => ({ docId, meta, exists: true }));
    },
  };
}

/**
 * Legacy adapter over the already-owned Repo. It acquires no replica, room or
 * subscription. Only listEntries preserves the renderer's existing listDoc fallback;
 * existence enumeration must never materialize document metadata or bodies.
 */
export function createLegacyWorkspaceDirectoryReader(
  repo: Pick<LoroRepo, 'getMeta' | 'listDoc'>
): WorkspaceDirectoryReader {
  const scanner = repo.getMeta?.();
  const reader =
    scanner &&
    createWorkspaceDirectoryReader(async (prefix) =>
      scanner.scan({ prefix: [...prefix], includeRaw: false })
    );
  return {
    async listActiveIds() {
      return reader ? reader.listActiveIds() : [];
    },
    async listEntries() {
      if (reader) {
        try {
          return await reader.listEntries();
        } catch {
          /* Preserve the old fallback. */
        }
      }
      return (await repo.listDoc()).map((entry) => ({
        ...entry,
        meta: entry.meta as Record<string, unknown>,
      }));
    },
  };
}

/** No document acquisition, extra subscription owner, or remote baseline inference. */
export function createLegacyWorkspaceDirectory(
  repo: Pick<LoroRepo, 'getMeta' | 'listDoc' | 'getDocMeta' | 'watch'>
) {
  return createObservedWorkspaceDirectory(repo, createLegacyWorkspaceDirectoryReader(repo));
}

/** Keep the existing Repo event owner while selecting an explicit directory source.
 * External metadata callers supply their authoritative snapshot reader; raw legacy
 * Meta access is never attempted or used as an error fallback. */
export function createObservedWorkspaceDirectory(
  repo: Pick<LoroRepo, 'getDocMeta' | 'watch'>,
  reader: WorkspaceDirectoryReader
): WorkspaceDirectory & {
  observe(listener: (change: WorkspaceDirectoryChange) => void): { unsubscribe(): void };
} {
  return {
    ...reader,
    async getEntry(docId) {
      const entry = await repo.getDocMeta(docId);
      return entry
        ? {
            docId,
            ...entry,
            meta: entry.meta as Record<string, unknown>,
          }
        : undefined;
    },
    observe(listener) {
      return repo.watch(
        (event) => {
          if (event.kind === 'doc-metadata') {
            listener({ kind: event.kind, docId: event.docId, patch: event.patch, by: event.by });
          } else if (event.kind === 'doc-existence-changed') {
            listener({ kind: event.kind, docId: event.docId, to: event.to });
          }
        },
        { kinds: ['doc-metadata', 'doc-existence-changed'] }
      );
    },
  };
}
