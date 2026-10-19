import { useSessionWorkspacePath } from './use-session-workspace-path';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import {
  getSessionRoomId,
  getCodeCollabFileIndexFlockDocId,
  codeCollabFileIndexToSharedState,
  type CodeCollabAllChangesScope,
  type CodeCollabFileSourceState,
  type CodeCollabRole,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2Error,
  type CodeCollabV2FileIndexSnapshot,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeState,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  type CodeCollabFileIndexCache,
  type CodeCollabFileIndexLoadState,
  type CodeCollabFileIndexResource,
} from '@/lib/code-collab-file-index-cache';
import { describeCodeCollabError, warnCodeCollab } from '@/lib/code-collab-debug';
import {
  CodeCollabSessionFileProvider,
  codeCollabFileTreeToSessionFileEntries,
  createCodeCollabSessionFileProviderTextState,
  resolveCodeCollabSessionFileProviderSourceState,
  type CodeCollabSessionFileProviderRuntime,
  type CodeCollabSessionFileProviderTextState,
} from '@/lib/code-collab-session-file-provider';
import type { SessionFileProvider, SessionFileProviderEntry } from '@/lib/session-file-provider';

export type CodeCollabSessionFileProviderStatus =
  | 'disabled'
  | 'checking'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'unavailable'
  | 'error';

export type UseCodeCollabSessionFileProviderOptions = {
  readonly workspaceId?: WorkspaceId | string | null;
  readonly sessionId: SessionId | string;
  readonly enabled?: boolean;
  readonly requestedRole?: CodeCollabRole;
  readonly httpBaseUrl?: string;
  readonly serverBaseUrl?: string;
  readonly machineId?: MachineId | string | null;
  readonly requestedByUserId?: string | null;
  readonly githubRepoFullName?: string | null;
  readonly debugLabel?: string;
};

export type UseCodeCollabSessionFileProviderResult = {
  readonly provider: SessionFileProvider | null;
  readonly status: CodeCollabSessionFileProviderStatus;
  readonly space: null;
  readonly role?: CodeCollabRole;
  readonly message?: string;
  readonly error?: unknown;
};

export const CODE_COLLAB_NO_OWNING_MACHINE_MESSAGE =
  'No CLI machine is available for this Code Collab session.';
export const CODE_COLLAB_UNSUPPORTED_SESSION_MESSAGE =
  'Code Collab v2 file browsing is not available for this session.';
export const CODE_COLLAB_CHECKING_MESSAGE = 'Checking Code Collab session...';
export const CODE_COLLAB_SHARED_STATE_LOADING_MESSAGE = 'Loading Code Collab shared file state...';

const disabledResult: UseCodeCollabSessionFileProviderResult = {
  provider: null,
  status: 'disabled',
  space: null,
};

export type CodeCollabV2MaterializedSharedState = {
  readonly fileTree: CodeCollabV2FileTreeState;
  readonly allChanges: CodeCollabV2AllChangesState;
  readonly files: readonly SessionFileProviderEntry[];
  readonly filesByPath: ReadonlyMap<string, SessionFileProviderEntry>;
  readonly version: number;
  readonly snapshotVersion: number;
  readonly sourceState: CodeCollabFileSourceState;
  readonly updatedAtMs?: number;
};

function entriesByPath(
  files: readonly SessionFileProviderEntry[]
): ReadonlyMap<string, SessionFileProviderEntry> {
  return new Map(files.map((entry) => [entry.path, entry]));
}

function sortedEntriesFromMap(
  filesByPath: ReadonlyMap<string, SessionFileProviderEntry>
): readonly SessionFileProviderEntry[] {
  return [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function materializeCodeCollabV2FileIndexForFileProvider(args: {
  readonly fileIndex?: CodeCollabV2FileIndexState | null;
  readonly revision: number;
  readonly updatedAtMs?: number;
  readonly sourceState: CodeCollabFileSourceState;
  readonly previous?: CodeCollabV2MaterializedSharedState | null;
}): CodeCollabV2MaterializedSharedState | null {
  if (!args.fileIndex) return null;
  if (
    args.previous?.snapshotVersion === args.revision &&
    args.previous.sourceState === args.sourceState &&
    args.previous.updatedAtMs === args.updatedAtMs
  ) {
    return args.previous;
  }

  const { fileTree, allChanges } = codeCollabFileIndexToSharedState(args.fileIndex);
  const filesByPath = entriesByPath(
    codeCollabFileTreeToSessionFileEntries(fileTree, args.sourceState)
  );
  const files = sortedEntriesFromMap(filesByPath);
  return {
    fileTree,
    allChanges,
    files,
    filesByPath,
    version: args.revision,
    snapshotVersion: args.revision,
    sourceState: args.sourceState,
    updatedAtMs: args.updatedAtMs,
  };
}

type ProviderTextStateRef = {
  readonly key: string;
  readonly state: CodeCollabSessionFileProviderTextState;
};

type ProviderSharedStateRef = {
  readonly key: string;
  readonly resourceKey: object | null;
  readonly state: CodeCollabV2MaterializedSharedState | null;
};

const IDLE_FILE_INDEX_STATE = Object.freeze({ status: 'idle' as const });
const LOADING_FILE_INDEX_STATE = Object.freeze({ status: 'loading' as const });

type HookFileIndexLoadState = typeof IDLE_FILE_INDEX_STATE | CodeCollabFileIndexLoadState;

type FileIndexTargetPlane = 'local' | 'cloud';

type AcquiredFileIndexResource = {
  readonly requestKey: object;
  readonly cache: CodeCollabFileIndexCache;
  readonly flockDocId: string;
  readonly targetPlane: FileIndexTargetPlane;
  readonly resource: CodeCollabFileIndexResource;
};

type KeyedFileIndexLoadState = {
  readonly requestKey: object;
  readonly state: HookFileIndexLoadState;
};

type LocalCodeCollabFileIndexSnapshot = CodeCollabV2FileIndexSnapshot | CodeCollabV2Error | null;

const isCodeCollabFileIndexSnapshot = (
  result: LocalCodeCollabFileIndexSnapshot
): result is CodeCollabV2FileIndexSnapshot => result?.status === 'ok';

function codeCollabFileIndexErrorMessage(error: unknown): string {
  const codeCollabError = error as { readonly message?: unknown };
  return error instanceof Error
    ? error.message
    : typeof codeCollabError.message === 'string'
      ? codeCollabError.message
      : CODE_COLLAB_UNSUPPORTED_SESSION_MESSAGE;
}

function useCodeCollabFileIndexLoadState(args: {
  readonly enabled: boolean;
  readonly cache: CodeCollabFileIndexCache | null;
  readonly workspaceId: WorkspaceId | string | null | undefined;
  readonly ownerSessionId: SessionId;
  readonly prepareTarget?: () => Promise<FileIndexTargetPlane>;
  readonly loadLocalSnapshot?: () => Promise<LocalCodeCollabFileIndexSnapshot>;
}): HookFileIndexLoadState {
  const [acquired, setAcquired] = useState<AcquiredFileIndexResource | null>(null);
  const [fallbackState, setFallbackState] = useState<KeyedFileIndexLoadState | null>(null);
  const [acquireError, setAcquireError] = useState<KeyedFileIndexLoadState | null>(null);
  const { enabled, cache, workspaceId, ownerSessionId, prepareTarget, loadLocalSnapshot } = args;
  const flockDocId =
    enabled && workspaceId
      ? getCodeCollabFileIndexFlockDocId(workspaceId as WorkspaceId, ownerSessionId)
      : null;
  const requestKey = useMemo<object>(
    () => ({ cache, flockDocId, loadLocalSnapshot, prepareTarget }),
    [cache, flockDocId, loadLocalSnapshot, prepareTarget]
  );

  useEffect(() => {
    setAcquired(null);
    setAcquireError(null);
    if (!flockDocId || (!cache && !loadLocalSnapshot)) {
      setFallbackState({ requestKey, state: IDLE_FILE_INDEX_STATE });
      return undefined;
    }

    let cancelled = false;
    let release: (() => Promise<void>) | null = null;
    let targetPlane: FileIndexTargetPlane = 'cloud';
    let localSnapshotPublished = false;
    const releaseSafely = async (releaseLease: () => Promise<void>): Promise<void> => {
      try {
        await releaseLease();
      } catch (error) {
        warnCodeCollab('file-index cache lease release failed', {
          flockDocId,
          error: describeCodeCollabError(error),
        });
      }
    };

    setFallbackState({ requestKey, state: LOADING_FILE_INDEX_STATE });
    void (async () => {
      targetPlane = (await prepareTarget?.()) ?? 'cloud';
      if (cancelled) return;

      let localSnapshot: CodeCollabV2FileIndexSnapshot | null = null;
      if (targetPlane === 'local') {
        const result = await loadLocalSnapshot?.();
        if (cancelled) return;
        if (result == null) {
          throw new Error('Local Code Collab file-index snapshot is unavailable.');
        }
        if (!isCodeCollabFileIndexSnapshot(result)) {
          throw new Error(codeCollabFileIndexErrorMessage(result));
        }
        localSnapshot = result;
        localSnapshotPublished = true;
        setFallbackState({
          requestKey,
          state: {
            status: 'ready',
            snapshot: {
              resourceKey: requestKey,
              fileIndex: result.fileIndex,
              revision: 1,
              updatedAtMs: result.updatedAtMs,
            },
          },
        });
      }

      if (!cache) {
        if (targetPlane === 'local') return;
        throw new Error('Code Collab shared file state is unavailable.');
      }

      const lease = await cache.acquire(flockDocId);
      release = lease.release;
      if (cancelled) {
        await releaseSafely(lease.release);
        return;
      }
      if (localSnapshot) {
        lease.resource.seed(localSnapshot.fileIndex, localSnapshot.updatedAtMs);
      }
      setAcquired({ requestKey, cache, flockDocId, targetPlane, resource: lease.resource });
    })().catch(async (error: unknown) => {
      if (release) {
        const releaseLease = release;
        release = null;
        await releaseSafely(releaseLease);
      }
      if (cancelled) return;
      if (targetPlane === 'local' && localSnapshotPublished) {
        warnCodeCollab('file-index local flock subscription failed', {
          workspaceId,
          ownerSessionId,
          flockDocId,
          error: describeCodeCollabError(error),
        });
        return;
      }
      setAcquireError({ requestKey, state: { status: 'error', error } });
    });

    return () => {
      cancelled = true;
      if (release) void releaseSafely(release);
    };
  }, [
    cache,
    flockDocId,
    loadLocalSnapshot,
    ownerSessionId,
    prepareTarget,
    requestKey,
    workspaceId,
  ]);

  const activeResource = acquired?.requestKey === requestKey ? acquired : null;
  const subscribe = useCallback(
    (listener: () => void) => activeResource?.resource.subscribe(listener) ?? (() => undefined),
    [activeResource]
  );
  const getSnapshot = useCallback<() => HookFileIndexLoadState>(() => {
    if (!flockDocId) return IDLE_FILE_INDEX_STATE;
    const fallback =
      fallbackState?.requestKey === requestKey ? fallbackState.state : LOADING_FILE_INDEX_STATE;
    if (acquireError?.requestKey === requestKey) return acquireError.state;
    if (!activeResource) return fallback;
    const resourceState = activeResource.resource.getSnapshot();
    if (activeResource.targetPlane === 'local' && resourceState.status !== 'ready') {
      return fallback;
    }
    return resourceState;
  }, [acquireError, activeResource, fallbackState, flockDocId, requestKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCodeCollabSessionFileProvider(
  options: UseCodeCollabSessionFileProviderOptions
): UseCodeCollabSessionFileProviderResult {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const sessionId = options.sessionId as SessionId;
  const sessionRoomId = getSessionRoomId(sessionId);
  const parentSessionId = useAtomValue(
    useMemo(
      () => selectAtom(sessionMetaAtomFamily(sessionRoomId), (meta) => meta?.parentSessionId),
      [sessionRoomId]
    )
  );
  const ownerSessionId = (parentSessionId ?? sessionId) as SessionId;
  const ownerMeta = useAtomValue(
    useMemo(
      () =>
        selectAtom(
          sessionMetaAtomFamily(getSessionRoomId(ownerSessionId)),
          (meta) => meta,
          (a, b) =>
            a?.id === b?.id &&
            a?.machineId === b?.machineId &&
            a?.parentSessionId === b?.parentSessionId &&
            a?.project === b?.project &&
            a?.isWorktree === b?.isWorktree &&
            a?.repoFullName === b?.repoFullName
        ),
      [ownerSessionId]
    )
  );
  const desktopPreview = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const workspaceRoot = useSessionWorkspacePath(desktopPreview ? ownerMeta : null);
  const workspaceId = options.workspaceId ?? runtime?.workspaceId ?? null;
  const machineId = options.machineId as MachineId | null | undefined;
  const textStateRef = useRef<ProviderTextStateRef | null>(null);
  const sharedStateRef = useRef<ProviderSharedStateRef | null>(null);
  const textStateKey = [workspaceId ?? '', machineId ?? '', ownerSessionId, sessionId].join(
    '\u0000'
  );
  if (textStateRef.current?.key !== textStateKey) {
    textStateRef.current = {
      key: textStateKey,
      state: createCodeCollabSessionFileProviderTextState(),
    };
  }
  const providerTextState = textStateRef.current.state;
  const role = options.requestedRole ?? 'write';
  const sourceState = resolveCodeCollabSessionFileProviderSourceState(role);
  const prepareFileIndexTarget = useMemo(
    () =>
      runtime && machineId
        ? async () => await runtime.prepareSessionTarget(ownerSessionId, machineId)
        : undefined,
    [machineId, ownerSessionId, runtime]
  );
  const loadLocalFileIndexSnapshot = useMemo(
    () =>
      runtime && machineId
        ? async () =>
            await runtime.requestLocalCodeCollabFileIndex(
              machineId,
              { sessionId },
              { ownerSessionId }
            )
        : undefined,
    [machineId, ownerSessionId, runtime, sessionId]
  );
  const fileIndexLoadState = useCodeCollabFileIndexLoadState({
    enabled: options.enabled !== false && !!machineId,
    cache: runtime?.codeCollabFileIndexCache ?? null,
    workspaceId,
    ownerSessionId,
    prepareTarget: prepareFileIndexTarget,
    loadLocalSnapshot: loadLocalFileIndexSnapshot,
  });
  const fileIndexSnapshot =
    fileIndexLoadState.status === 'ready' ? fileIndexLoadState.snapshot : null;
  const sharedStateKey = [workspaceId ?? '', machineId ?? '', ownerSessionId, sourceState].join(
    '\u0000'
  );
  const previousSharedState =
    sharedStateRef.current?.key === sharedStateKey &&
    sharedStateRef.current.resourceKey === (fileIndexSnapshot?.resourceKey ?? null)
      ? sharedStateRef.current.state
      : null;
  const materializedSharedState = materializeCodeCollabV2FileIndexForFileProvider({
    fileIndex: fileIndexSnapshot?.fileIndex ?? null,
    revision: fileIndexSnapshot?.revision ?? 0,
    updatedAtMs: fileIndexSnapshot?.updatedAtMs,
    sourceState,
    previous: previousSharedState,
  });
  sharedStateRef.current = {
    key: sharedStateKey,
    resourceKey: fileIndexSnapshot?.resourceKey ?? null,
    state: materializedSharedState,
  };

  const rpcRuntime = useMemo<CodeCollabSessionFileProviderRuntime | undefined>(() => {
    if (!runtime || !machineId) return undefined;
    const requestedByUserId = options.requestedByUserId?.trim();
    return {
      sessionId,
      previewFile: async (path, knownDigest) =>
        await runtime.requestFilePreview(
          machineId,
          { sessionId, path, ...(knownDigest === undefined ? {} : { knownDigest }) },
          { ownerSessionId, workspaceRoot }
        ),
      openText: async (path) =>
        await runtime.requestCodeCollabOpenText(machineId, { sessionId, path }, { ownerSessionId }),
      refreshText: async (path, digest) =>
        await runtime.requestCodeCollabRefreshText(
          machineId,
          { sessionId, path, digest },
          { ownerSessionId }
        ),
      saveText: async (path, baseDigest, text, format) =>
        requestedByUserId
          ? await runtime.requestCodeCollabSaveText(
              machineId,
              {
                sessionId,
                requestedByUserId,
                path,
                baseDigest,
                text,
                ...(format === undefined ? {} : { format }),
              },
              { ownerSessionId }
            )
          : {
              status: 'error',
              code: 'permission_denied',
              message: 'Code Collab save requires a signed-in user.',
            },
      openCurrentDiff: async (path, scope: CodeCollabAllChangesScope | undefined) =>
        await runtime.requestCodeCollabOpenCurrentDiff(
          machineId,
          { sessionId, path, ...(scope === undefined ? {} : { scope }) },
          { ownerSessionId }
        ),
      openAllChangesDiff: async (focusPath, scope: CodeCollabAllChangesScope | undefined) =>
        await runtime.requestCodeCollabOpenAllChangesDiff(
          machineId,
          {
            sessionId,
            ...(focusPath === undefined ? {} : { focusPath }),
            ...(scope === undefined ? {} : { scope }),
          },
          { ownerSessionId }
        ),
      openTurnDiff: async (path, turnId) =>
        await runtime.requestCodeCollabOpenTurnDiff(
          machineId,
          { sessionId, turnId, path },
          { ownerSessionId }
        ),
      initDirectory: async (path) =>
        await runtime.requestCodeCollabInitDirectory(
          machineId,
          { sessionId, path },
          { ownerSessionId }
        ),
      lspDefinition: async (path, position) =>
        await runtime.requestCodeCollabLspDefinition(
          machineId,
          { sessionId, path, ...position },
          { ownerSessionId }
        ),
      lspReferences: async (path, position) =>
        await runtime.requestCodeCollabLspReferences(
          machineId,
          { sessionId, path, ...position },
          { ownerSessionId }
        ),
    };
  }, [machineId, options.requestedByUserId, ownerSessionId, runtime, sessionId, workspaceRoot]);

  const provider = useMemo<SessionFileProvider | null>(() => {
    const sharedState = materializedSharedState;
    if (!rpcRuntime || (!sharedState && !desktopPreview)) return null;
    return new CodeCollabSessionFileProvider({
      runtime: rpcRuntime,
      role,
      sourceState,
      files: sharedState?.files ?? [],
      allChanges: sharedState?.allChanges ?? {},
      updatedAtMs: sharedState?.updatedAtMs,
      textState: providerTextState,
    });
  }, [desktopPreview, materializedSharedState, providerTextState, role, rpcRuntime, sourceState]);

  return useMemo<UseCodeCollabSessionFileProviderResult>(() => {
    if (options.enabled === false) {
      return disabledResult;
    }
    if (!runtime) {
      return {
        provider: null,
        status: 'checking',
        space: null,
        message: CODE_COLLAB_CHECKING_MESSAGE,
      };
    }
    if (!machineId) {
      return {
        provider: null,
        status: 'unavailable',
        space: null,
        message: CODE_COLLAB_NO_OWNING_MACHINE_MESSAGE,
      };
    }
    const sharedState = materializedSharedState;
    if (sharedState && provider) {
      const fileCount = sharedState.files.length;
      return {
        provider,
        status: fileCount === 0 ? 'empty' : 'ready',
        space: null,
        role,
      };
    }
    if (fileIndexLoadState.status === 'error') {
      return {
        provider,
        status: 'error',
        space: null,
        error: fileIndexLoadState.error,
        message: codeCollabFileIndexErrorMessage(fileIndexLoadState.error),
      };
    }

    return {
      provider,
      status: fileIndexLoadState.status === 'loading' ? 'loading' : 'checking',
      space: null,
      message: CODE_COLLAB_SHARED_STATE_LOADING_MESSAGE,
    };
  }, [
    fileIndexLoadState,
    machineId,
    materializedSharedState,
    options.enabled,
    provider,
    role,
    runtime,
  ]);
}
