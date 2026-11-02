import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Data, Effect } from 'effect';
import { z } from 'zod';
import { getServerNow } from '@lody/shared';
import { getLocalWorkspaceCatalogPath } from '@lody/shared/node/local-workspace-catalog';
import { FileLocks, withFileLock } from '@/utils/file-lock';

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

// Bounded optimistic-allow cache for workspace members who are NOT the machine
// owner. The owner snapshot above never expires; a member allow is trusted only
// for MEMBER_ACCESS_SNAPSHOT_TTL_MS after the backend last confirmed it, and is
// keyed by the local project because project sharing is part of the verdict.
// Each grant is bound to the CLI account and Machine that verified it: a grant
// for another machine owner says nothing about the current one.
export const MEMBER_ACCESS_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const MEMBER_ACCESS_SNAPSHOT_LIMIT = 64;

const CatalogMemberAccessSnapshotSchema = z.object({
  requesterUserId: z.string(),
  localProjectId: z.string().optional(),
  // Optional only so an unbound entry parses (and never matches) instead of
  // making the whole catalog corrupt.
  ownerUserId: z.string().optional(),
  machineId: z.string().optional(),
  verifiedAt: z.string(),
});

const CatalogWorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  role: z.string(),
  contentMode: z.enum(['e2ee', 'plaintext']).optional(),
  genesisHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  state: z.enum(['active', 'remote_missing']),
  cachedAt: z.number(),
  remoteMissingAt: z.number().optional(),
  machine: CatalogMachineSchema.extend({
    cachedAt: z.number(),
  }).optional(),
  accessSnapshot: CatalogAccessSnapshotSchema.optional(),
  memberAccessSnapshots: z.array(CatalogMemberAccessSnapshotSchema).optional(),
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
export type LocalCatalogMemberAccessSnapshot = z.infer<typeof CatalogMemberAccessSnapshotSchema>;
export type LocalCatalogWorkspace = z.infer<typeof CatalogWorkspaceSchema>;
export type LocalCatalogSession = z.infer<typeof CatalogSessionSchema>;
export type LocalWorkspaceCatalogSnapshot = z.infer<typeof CatalogSnapshotSchema> & {
  /** Derived from the new-owned invalid marker, never an old-writer field. */
  encryptedCatalogUnavailable?: true;
  /** In-memory recovery evidence, never serialized or included in diagnostics. */
  encryptedCatalogError?: LocalWorkspaceCatalogError;
};

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
  /** Only the authenticated complete online-list owner may rebuild a corrupt
   * encrypted index. Local provisioning and offline reads cannot grant this. */
  authenticatedOnline?: true;
  identity: LocalCatalogIdentity;
  machine: LocalCatalogMachine;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    role: string;
    contentMode?: string;
    genesisHash?: string;
  }>;
};

export type RecordWorkspaceAccessSnapshotInput = {
  workspaceId: string;
  // `null` clears any cached allow for this workspace (backend deny / revocation).
  accessSnapshot: LocalCatalogAccessSnapshot | null;
};

export type RecordMemberAccessSnapshotInput = {
  workspaceId: string;
  requesterUserId: string;
  localProjectId?: string;
  // The CLI account and Machine whose backend check produced this verdict.
  ownerUserId: string;
  machineId: string;
  // Confirmed backend allow time; `null` clears the entry after a definitive deny.
  verifiedAt: string | null;
};

export function isMemberAccessSnapshotFresh(
  snapshot: Pick<LocalCatalogMemberAccessSnapshot, 'verifiedAt'>,
  nowMs: number
): boolean {
  const ageMs = nowMs - Date.parse(snapshot.verifiedAt);
  // A future timestamp (clock moved backwards) is not trusted either.
  return ageMs >= 0 && ageMs < MEMBER_ACCESS_SNAPSHOT_TTL_MS;
}

export type LocalWorkspaceCatalogService = {
  read: () => Effect.Effect<LocalWorkspaceCatalogSnapshot, LocalWorkspaceCatalogError>;
  listActiveWorkspaces: () => Effect.Effect<LocalCatalogWorkspace[], LocalWorkspaceCatalogError>;
  cacheRemoteWorkspaces: (
    input: CacheRemoteWorkspacesInput
  ) => Effect.Effect<
    void | { encryptedCatalogError: LocalWorkspaceCatalogError },
    LocalWorkspaceCatalogError,
    FileLocks
  >;
  recordWorkspaceAccessSnapshot: (
    input: RecordWorkspaceAccessSnapshotInput
  ) => Effect.Effect<void, LocalWorkspaceCatalogError, FileLocks>;
  recordMemberAccessSnapshot: (
    input: RecordMemberAccessSnapshotInput
  ) => Effect.Effect<void, LocalWorkspaceCatalogError, FileLocks>;
  upsertSession: (
    session: Omit<LocalCatalogSession, 'cachedAt'>
  ) => Effect.Effect<void, LocalWorkspaceCatalogError, FileLocks>;
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

async function readCatalogSnapshot(filePath: string): Promise<LocalWorkspaceCatalogSnapshot> {
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

// Released CLIs strip unknown fields from v1 workspace rows. An encrypted row
// must never enter their workspaces array: they would bootstrap it as plaintext.
// A sibling file also survives an older CLI rewriting its ordinary catalog.
const encryptedCatalogPath = (filePath: string) => `${filePath}.e2ee`;
const encryptedInvalidPath = (filePath: string) => `${filePath}.e2ee-invalid`;
async function readCatalogFile(filePath: string): Promise<LocalWorkspaceCatalogSnapshot> {
  const ordinary = await readCatalogSnapshot(filePath);
  try {
    const invalid = await readCatalogSnapshot(encryptedInvalidPath(filePath));
    if (
      invalid.identity?.userId === ordinary.identity?.userId &&
      invalid.machine?.machineId === ordinary.machine?.machineId
    )
      ordinary.encryptedCatalogUnavailable = true;
  } catch (error) {
    if (!(error instanceof CatalogMissingError))
      return {
        ...ordinary,
        encryptedCatalogUnavailable: true,
        encryptedCatalogError: toCatalogError(encryptedInvalidPath(filePath), error),
      };
  }
  let encrypted: LocalWorkspaceCatalogSnapshot;
  try {
    encrypted = await readCatalogSnapshot(encryptedCatalogPath(filePath));
  } catch (error) {
    if (error instanceof CatalogMissingError) return ordinary;
    // The encrypted index owns its failure. Keep the original for recovery and
    // leave its bytes untouched, while ordinary offline work remains usable.
    return {
      ...ordinary,
      encryptedCatalogUnavailable: true,
      encryptedCatalogError: toCatalogError(encryptedCatalogPath(filePath), error),
    };
  }
  if (
    ordinary.encryptedCatalogUnavailable ||
    !ordinary.identity ||
    ordinary.identity.userId !== encrypted.identity?.userId ||
    ordinary.machine?.machineId !== encrypted.machine?.machineId
  )
    return ordinary;
  const encryptedWorkspaces = encrypted.workspaces.filter(
    (workspace) => workspace.contentMode === 'e2ee'
  );
  const ids = new Set(encryptedWorkspaces.map((workspace) => workspace.workspaceId));
  return {
    ...ordinary,
    workspaces: [
      ...ordinary.workspaces.filter((workspace) => !ids.has(workspace.workspaceId)),
      ...encryptedWorkspaces,
    ],
    sessions: [
      ...ordinary.sessions.filter((session) => !ids.has(session.workspaceId)),
      ...encrypted.sessions.filter((session) => ids.has(session.workspaceId)),
    ],
  };
}

async function writeCatalogSnapshot(
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

async function writeCatalogFile(
  filePath: string,
  snapshot: LocalWorkspaceCatalogSnapshot,
  previous?: LocalWorkspaceCatalogSnapshot,
  allowDegradedEncryptedCache = false,
  rebuildCorruptEncryptedCache = false
): Promise<LocalWorkspaceCatalogSnapshot> {
  const ids = new Set(
    snapshot.workspaces
      .filter((workspace) => workspace.contentMode === 'e2ee')
      .map((workspace) => workspace.workspaceId)
  );
  const encryptedPath = encryptedCatalogPath(filePath);
  const invalidPath = encryptedInvalidPath(filePath);
  const encryptedSnapshot = {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((workspace) => ids.has(workspace.workspaceId)),
    sessions: snapshot.sessions.filter((session) => ids.has(session.workspaceId)),
  };
  const priorEncryptedIds = new Set(
    previous?.workspaces
      .filter((workspace) => workspace.contentMode === 'e2ee')
      .map((workspace) => workspace.workspaceId)
  );
  const encryptedChanged = previous
    ? JSON.stringify({
        identity: snapshot.identity,
        machine: snapshot.machine,
        workspaces: encryptedSnapshot.workspaces,
        sessions: encryptedSnapshot.sessions,
      }) !==
      JSON.stringify({
        identity: previous.identity,
        machine: previous.machine,
        workspaces: previous.workspaces.filter((workspace) =>
          priorEncryptedIds.has(workspace.workspaceId)
        ),
        sessions: previous.sessions.filter((session) => priorEncryptedIds.has(session.workspaceId)),
      })
    : ids.size > 0;
  // Persist encrypted discovery first, then remove those rows from the legacy
  // file. Both writes remain under the existing catalog lock. A partial write
  // reports failure; an identity mismatch never adopts the other account's rows.
  let encryptedError = snapshot.encryptedCatalogError;
  const refreshEncrypted =
    (encryptedChanged && (ids.size || priorEncryptedIds.size)) ||
    (allowDegradedEncryptedCache && snapshot.encryptedCatalogUnavailable);
  let invalidMarkerPublished = false;
  // The fence belongs to new clients, outside the v1 file an old CLI rewrites.
  // Publish before changing the encrypted slice: a failed update or crash must
  // never make old active rows authoritative again on an offline reopen.
  if (refreshEncrypted || encryptedError) {
    try {
      await writeCatalogSnapshot(invalidPath, {
        version: CATALOG_VERSION,
        identity: snapshot.identity,
        machine: snapshot.machine,
        workspaces: [],
        sessions: [],
      });
      invalidMarkerPublished = true;
    } catch (error) {
      if (!allowDegradedEncryptedCache && refreshEncrypted) throw error;
      encryptedError = toCatalogError(
        invalidPath,
        encryptedError
          ? new AggregateError(
              [encryptedError, error],
              'Encrypted cache fence could not be published'
            )
          : error
      );
    }
  }
  if (refreshEncrypted && invalidMarkerPublished) {
    // Only an authenticated remote-list reconciliation can rebuild discovery.
    // Publish the fence before archiving, so a crash or failed publication can
    // never make stale encrypted rows usable. Permission/marker errors stay errors.
    try {
      if (
        rebuildCorruptEncryptedCache &&
        encryptedError instanceof CatalogCorruptError &&
        encryptedError.path === encryptedPath
      ) {
        await fs.rename(encryptedPath, `${encryptedPath}.corrupt-${crypto.randomUUID()}`);
        encryptedError = undefined;
      }
      if (encryptedError) throw encryptedError;
      await writeCatalogSnapshot(encryptedPath, encryptedSnapshot);
    } catch (error) {
      if (!allowDegradedEncryptedCache) throw error;
      encryptedError = toCatalogError(encryptedPath, error);
    }
  }
  const ordinarySnapshot: LocalWorkspaceCatalogSnapshot = {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((workspace) => !ids.has(workspace.workspaceId)),
    sessions: snapshot.sessions.filter((session) => !ids.has(session.workspaceId)),
    encryptedCatalogUnavailable: encryptedError
      ? true
      : allowDegradedEncryptedCache
        ? undefined
        : snapshot.encryptedCatalogUnavailable,
  };
  await writeCatalogSnapshot(filePath, ordinarySnapshot);
  if (invalidMarkerPublished && !encryptedError) {
    try {
      await fs.unlink(invalidPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Both cache results are durable. Keep the fence and report only its
        // unresolved cleanup; the next reconciliation owns that retry.
        encryptedError = toCatalogError(invalidPath, error);
        ordinarySnapshot.encryptedCatalogUnavailable = true;
      }
    }
  }
  const { encryptedCatalogError: _previousError, ...reconciledSnapshot } = snapshot;
  return encryptedError
    ? { ...ordinarySnapshot, encryptedCatalogError: encryptedError }
    : {
        ...reconciledSnapshot,
        encryptedCatalogUnavailable: ordinarySnapshot.encryptedCatalogUnavailable,
      };
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
      Effect.catchTag('CatalogCorruptError', (corruptError) =>
        corruptError.path !== filePath
          ? Effect.fail(corruptError)
          : Effect.tryPromise({
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
    fn: (snapshot: LocalWorkspaceCatalogSnapshot) => LocalWorkspaceCatalogSnapshot,
    allowDegradedEncryptedCache = false,
    rebuildCorruptEncryptedCache = false
  ): Effect.Effect<LocalWorkspaceCatalogSnapshot, LocalWorkspaceCatalogError, FileLocks> =>
    withFileLock(
      lockName,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const snapshot = yield* readRecoveringFromDisk();
          const updated = fn(snapshot);
          const persisted = yield* Effect.tryPromise({
            try: () =>
              writeCatalogFile(
                filePath,
                updated,
                snapshot,
                allowDegradedEncryptedCache,
                rebuildCorruptEncryptedCache
              ),
            catch: (error) => toCatalogError(filePath, error),
          });
          cacheRevision += 1;
          cachedRead = { snapshot: persisted, cachedAtMs: clock() };
          return persisted;
        })
      )
    ).pipe(Effect.mapError((error) => toCatalogError(filePath, error)));
  const mutateUnit = (
    fn: (snapshot: LocalWorkspaceCatalogSnapshot) => LocalWorkspaceCatalogSnapshot
  ) => mutate(fn).pipe(Effect.asVoid);

  return {
    read: readCached,
    listActiveWorkspaces: () =>
      readCached().pipe(
        Effect.map((snapshot) =>
          snapshot.workspaces.filter((workspace) => workspace.state === 'active')
        )
      ),
    cacheRemoteWorkspaces: (input) =>
      mutate(
        (snapshot) => {
          const now = getServerNow();
          const remoteIds = new Set(input.workspaces.map((workspace) => workspace.id));
          // Member grants were verified for the previous account and Machine.
          const keepMemberGrants =
            snapshot.identity?.userId === input.identity.userId &&
            snapshot.machine?.machineId === input.machine.machineId;
          const previousById = new Map(
            snapshot.workspaces.map((workspace) => [workspace.workspaceId, workspace])
          );
          // A mode this client does not implement is never cached: a row without
          // `contentMode` means plaintext, so an offline restart would fail open.
          const supported = input.workspaces.filter(
            (workspace) =>
              workspace.contentMode === undefined ||
              workspace.contentMode === 'plaintext' ||
              workspace.contentMode === 'e2ee'
          );
          const active = supported.map((workspace): LocalCatalogWorkspace => {
            const previous = previousById.get(workspace.id);
            return {
              workspaceId: workspace.id,
              name: workspace.name,
              slug: workspace.slug,
              role: workspace.role,
              ...(workspace.contentMode === 'e2ee'
                ? { contentMode: 'e2ee' as const, genesisHash: workspace.genesisHash }
                : {}),
              state: 'active',
              cachedAt: now,
              machine: {
                ...input.machine,
                cachedAt: now,
              },
              ...(previous?.accessSnapshot ? { accessSnapshot: previous.accessSnapshot } : {}),
              ...(keepMemberGrants && previous?.memberAccessSnapshots
                ? { memberAccessSnapshots: previous.memberAccessSnapshots }
                : {}),
            };
          });
          const remoteMissing = snapshot.workspaces
            .filter((workspace) => !remoteIds.has(workspace.workspaceId))
            .map((workspace): LocalCatalogWorkspace => ({
              ...workspace,
              state: 'remote_missing',
              remoteMissingAt: workspace.remoteMissingAt ?? now,
            }));
          return {
            ...snapshot,
            identity: input.identity,
            machine: input.machine,
            workspaces: [...active, ...remoteMissing],
          };
        },
        true,
        input.authenticatedOnline === true
      ).pipe(
        Effect.map((snapshot) =>
          snapshot.encryptedCatalogError
            ? { encryptedCatalogError: snapshot.encryptedCatalogError }
            : undefined
        )
      ),
    recordWorkspaceAccessSnapshot: (input) =>
      mutateUnit((snapshot) => ({
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
    recordMemberAccessSnapshot: (input) =>
      mutateUnit((snapshot) => {
        const nowMs = clock();
        return {
          ...snapshot,
          workspaces: snapshot.workspaces.map((workspace) => {
            if (workspace.workspaceId !== input.workspaceId) {
              return workspace;
            }
            const others = (workspace.memberAccessSnapshots ?? []).filter(
              (entry) =>
                (entry.requesterUserId !== input.requesterUserId ||
                  entry.localProjectId !== input.localProjectId) &&
                isMemberAccessSnapshotFresh(entry, nowMs)
            );
            const next =
              input.verifiedAt === null
                ? others
                : [
                    ...others,
                    {
                      requesterUserId: input.requesterUserId,
                      ...(input.localProjectId ? { localProjectId: input.localProjectId } : {}),
                      ownerUserId: input.ownerUserId,
                      machineId: input.machineId,
                      verifiedAt: input.verifiedAt,
                    },
                  ].slice(-MEMBER_ACCESS_SNAPSHOT_LIMIT);
            const { memberAccessSnapshots: _previous, ...rest } = workspace;
            return next.length > 0 ? { ...rest, memberAccessSnapshots: next } : rest;
          }),
        };
      }),
    upsertSession: (session) =>
      mutateUnit((snapshot) => {
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
  contentMode?: string;
  genesisHash?: string;
} {
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    slug: workspace.slug,
    role: workspace.role,
    ...(workspace.contentMode
      ? { contentMode: workspace.contentMode, genesisHash: workspace.genesisHash }
      : {}),
  };
}
