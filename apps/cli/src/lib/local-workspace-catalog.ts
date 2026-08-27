import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Data, Effect } from 'effect';
import { z } from 'zod';
import { getServerNow } from '@lody/shared';
import { getLocalWorkspaceCatalogPath } from '@lody/shared/node/local-workspace-catalog';
import { withFileLock } from '@/utils/file-lock';

export { getLocalWorkspaceCatalogPath };

const CATALOG_VERSION = 1;
const DEFAULT_CATALOG_LOCK = 'local-workspace-catalog';

const CatalogIdentitySchema = z.object({
  userId: z.string(),
  email: z.string().optional(),
  name: z.string().nullable().optional(),
});

const CatalogMachineSchema = z.object({
  machineId: z.string(),
  machineName: z.string().optional(),
});

// Optimistic-allow cache: a snapshot exists ONLY when the backend last confirmed
// this owner may use this machine. A backend deny does not persist a "denied"
// snapshot — it clears any cached allow (see recordWorkspaceAccessSnapshot(null)).
// This makes a transient deny (e.g. a pre-registration `machine_not_registered`
// race) unable to permanently wedge dispatch: with no snapshot the policy falls
// through to a fresh remote check instead of a durable local block.
const CatalogAccessSnapshotSchema = z.object({
  ownerUserId: z.string(),
  verifiedAt: z.string(),
});

const CatalogWorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  role: z.string(),
  state: z.enum(['active', 'remote_missing']),
  cachedAt: z.number(),
  remoteMissingAt: z.number().optional(),
  machine: CatalogMachineSchema.extend({
    cachedAt: z.number(),
  }).optional(),
  accessSnapshot: CatalogAccessSnapshotSchema.optional(),
});

const CatalogSessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().optional(),
  origin: z.enum(['offline', 'online']),
  authorUserId: z.string(),
  cachedAt: z.number(),
});

const CatalogSnapshotSchema = z.object({
  version: z.literal(CATALOG_VERSION),
  identity: CatalogIdentitySchema.nullable(),
  machine: CatalogMachineSchema.nullable(),
  workspaces: z.array(CatalogWorkspaceSchema),
  sessions: z.array(CatalogSessionSchema),
});

export type LocalCatalogIdentity = z.infer<typeof CatalogIdentitySchema>;
export type LocalCatalogMachine = z.infer<typeof CatalogMachineSchema>;
export type LocalCatalogAccessSnapshot = z.infer<typeof CatalogAccessSnapshotSchema>;
export type LocalCatalogWorkspace = z.infer<typeof CatalogWorkspaceSchema>;
export type LocalCatalogSession = z.infer<typeof CatalogSessionSchema>;
export type LocalWorkspaceCatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export class CatalogMissingError extends Data.TaggedError('CatalogMissingError')<{
  path: string;
  cause?: unknown;
}> {}

export class CatalogCorruptError extends Data.TaggedError('CatalogCorruptError')<{
  path: string;
  cause?: unknown;
}> {}

export class CatalogPermissionError extends Data.TaggedError('CatalogPermissionError')<{
  path: string;
  cause?: unknown;
}> {}

export type LocalWorkspaceCatalogError =
  | CatalogMissingError
  | CatalogCorruptError
  | CatalogPermissionError;

export type CacheRemoteWorkspacesInput = {
  identity: LocalCatalogIdentity;
  machine: LocalCatalogMachine;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    role: string;
  }>;
};

export type RecordWorkspaceAccessSnapshotInput = {
  workspaceId: string;
  // `null` clears any cached allow for this workspace (backend deny / revocation).
  accessSnapshot: LocalCatalogAccessSnapshot | null;
};

export type LocalWorkspaceCatalogService = {
  read: () => Effect.Effect<LocalWorkspaceCatalogSnapshot, LocalWorkspaceCatalogError>;
  listActiveWorkspaces: () => Effect.Effect<LocalCatalogWorkspace[], LocalWorkspaceCatalogError>;
  cacheRemoteWorkspaces: (
    input: CacheRemoteWorkspacesInput
  ) => Effect.Effect<void, LocalWorkspaceCatalogError>;
  recordWorkspaceAccessSnapshot: (
    input: RecordWorkspaceAccessSnapshotInput
  ) => Effect.Effect<void, LocalWorkspaceCatalogError>;
  upsertSession: (
    session: Omit<LocalCatalogSession, 'cachedAt'>
  ) => Effect.Effect<void, LocalWorkspaceCatalogError>;
};

const emptyCatalog = (): LocalWorkspaceCatalogSnapshot => ({
  version: CATALOG_VERSION,
  identity: null,
  machine: null,
  workspaces: [],
  sessions: [],
});

const mapReadError = (filePath: string, error: unknown): LocalWorkspaceCatalogError => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new CatalogMissingError({ path: filePath, cause: error });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new CatalogPermissionError({ path: filePath, cause: error });
  }
  return new CatalogCorruptError({ path: filePath, cause: error });
};

const toCatalogError = (filePath: string, error: unknown): LocalWorkspaceCatalogError => {
  if (
    error instanceof CatalogMissingError ||
    error instanceof CatalogCorruptError ||
    error instanceof CatalogPermissionError
  ) {
    return error;
  }
  return new CatalogPermissionError({ path: filePath, cause: error });
};

async function ensureCatalogDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(dir, 0o700);
  }
}

async function readCatalogFile(filePath: string): Promise<LocalWorkspaceCatalogSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw mapReadError(filePath, error);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new CatalogCorruptError({ path: filePath, cause: error });
  }

  const parsed = CatalogSnapshotSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CatalogCorruptError({ path: filePath, cause: parsed.error });
  }
  return parsed.data;
}

async function writeCatalogFile(
  filePath: string,
  snapshot: LocalWorkspaceCatalogSnapshot
): Promise<void> {
  const parsed = CatalogSnapshotSchema.parse(snapshot);
  await ensureCatalogDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(tempPath, 0o600);
  }
  await fs.rename(tempPath, filePath);
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
  }
}

async function backupCorruptCatalog(filePath: string): Promise<void> {
  const backupPath = `${filePath}.corrupt-${process.pid}-${getServerNow()}`;
  await fs.rename(filePath, backupPath);
}

export function makeLocalWorkspaceCatalog(
  options: {
    filePath?: string;
    lockName?: string;
    cacheTtlMs?: number;
    now?: () => number;
  } = {}
): LocalWorkspaceCatalogService {
  const filePath = options.filePath ?? getLocalWorkspaceCatalogPath();
  const lockName = options.lockName ?? DEFAULT_CATALOG_LOCK;
  const cacheTtlMs = options.cacheTtlMs ?? 5_000;
  const clock = options.now ?? getServerNow;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let cacheRevision = 0;
  let cachedRead: { snapshot: LocalWorkspaceCatalogSnapshot; cachedAtMs: number } | null = null;
  let readInFlight: Promise<LocalWorkspaceCatalogSnapshot> | null = null;

  const readRecoveringFromDisk = (): Effect.Effect<
    LocalWorkspaceCatalogSnapshot,
    LocalWorkspaceCatalogError
  > =>
    Effect.tryPromise({
      try: () => readCatalogFile(filePath),
      catch: (error) => toCatalogError(filePath, error),
    }).pipe(
      Effect.catchTag('CatalogMissingError', () => Effect.succeed(emptyCatalog())),
      Effect.catchTag('CatalogCorruptError', () =>
        Effect.tryPromise({
          try: async () => {
            await backupCorruptCatalog(filePath);
            const snapshot = emptyCatalog();
            await writeCatalogFile(filePath, snapshot);
            return snapshot;
          },
          catch: (error) => mapReadError(filePath, error),
        })
      )
    );

  const refreshReadCache = (): Promise<LocalWorkspaceCatalogSnapshot> => {
    if (readInFlight) {
      return readInFlight;
    }
    const revisionAtStart = cacheRevision;
    const operation = Effect.runPromise(readRecoveringFromDisk()).then((snapshot) => {
      if (cacheRevision === revisionAtStart) {
        cachedRead = { snapshot, cachedAtMs: clock() };
        return snapshot;
      }
      return cachedRead?.snapshot ?? snapshot;
    });
    readInFlight = operation;
    const clearInFlight = () => {
      if (readInFlight === operation) readInFlight = null;
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  };

  const readCached = (): Effect.Effect<LocalWorkspaceCatalogSnapshot, LocalWorkspaceCatalogError> =>
    Effect.suspend(() => {
      const cached = cachedRead;
      if (!cached) {
        return Effect.tryPromise({
          try: refreshReadCache,
          catch: (error) => toCatalogError(filePath, error),
        });
      }
      if (Math.max(0, clock() - cached.cachedAtMs) >= cacheTtlMs) {
        void refreshReadCache().catch(() => undefined);
      }
      return Effect.succeed(cached.snapshot);
    });

  const mutate = (
    fn: (
      snapshot: LocalWorkspaceCatalogSnapshot
    ) => LocalWorkspaceCatalogSnapshot | Promise<LocalWorkspaceCatalogSnapshot>
  ): Effect.Effect<void, LocalWorkspaceCatalogError> =>
    Effect.tryPromise({
      try: async () => {
        const run = async () =>
          await withFileLock(lockName, async () => {
            const snapshot = await Effect.runPromise(readRecoveringFromDisk());
            const updated = await fn(snapshot);
            await writeCatalogFile(filePath, updated);
            cacheRevision += 1;
            cachedRead = { snapshot: updated, cachedAtMs: clock() };
          });
        writeQueue = writeQueue.then(run, run);
        await writeQueue;
      },
      catch: (error) => toCatalogError(filePath, error),
    });

  return {
    read: readCached,
    listActiveWorkspaces: () =>
      readCached().pipe(
        Effect.map((snapshot) =>
          snapshot.workspaces.filter((workspace) => workspace.state === 'active')
        )
      ),
    cacheRemoteWorkspaces: (input) =>
      mutate((snapshot) => {
        const now = getServerNow();
        const remoteIds = new Set(input.workspaces.map((workspace) => workspace.id));
        const previousById = new Map(
          snapshot.workspaces.map((workspace) => [workspace.workspaceId, workspace])
        );
        const active = input.workspaces.map((workspace): LocalCatalogWorkspace => {
          const previous = previousById.get(workspace.id);
          return {
            workspaceId: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            role: workspace.role,
            state: 'active',
            cachedAt: now,
            machine: {
              ...input.machine,
              cachedAt: now,
            },
            ...(previous?.accessSnapshot ? { accessSnapshot: previous.accessSnapshot } : {}),
          };
        });
        const remoteMissing = snapshot.workspaces
          .filter((workspace) => !remoteIds.has(workspace.workspaceId))
          .map(
            (workspace): LocalCatalogWorkspace => ({
              ...workspace,
              state: 'remote_missing',
              remoteMissingAt: workspace.remoteMissingAt ?? now,
            })
          );
        return {
          ...snapshot,
          identity: input.identity,
          machine: input.machine,
          workspaces: [...active, ...remoteMissing],
        };
      }),
    recordWorkspaceAccessSnapshot: (input) =>
      mutate((snapshot) => ({
        ...snapshot,
        workspaces: snapshot.workspaces.map((workspace) => {
          if (workspace.workspaceId !== input.workspaceId) {
            return workspace;
          }
          if (input.accessSnapshot === null) {
            const { accessSnapshot: _cleared, ...rest } = workspace;
            return rest;
          }
          return { ...workspace, accessSnapshot: input.accessSnapshot };
        }),
      })),
    upsertSession: (session) =>
      mutate((snapshot) => {
        const now = getServerNow();
        const nextSession: LocalCatalogSession = { ...session, cachedAt: now };
        return {
          ...snapshot,
          sessions: [
            ...snapshot.sessions.filter((item) => item.sessionId !== session.sessionId),
            nextSession,
          ],
        };
      }),
  };
}

export function localCatalogWorkspaceToWorkspaceListItem(workspace: LocalCatalogWorkspace): {
  id: string;
  name: string;
  slug: string | null;
  role: string;
} {
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    slug: workspace.slug,
    role: workspace.role,
  };
}
