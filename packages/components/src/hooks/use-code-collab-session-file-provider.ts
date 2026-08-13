import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { Flock } from '@loro-dev/flock-wasm';
import type { RepoRoomSubscription } from 'loro-repo';
import {
  getSessionRoomId,
  getCodeCollabFileIndexFlockDocId,
  getServerNow,
  applyCodeCollabFileIndexFlockEvents,
  codeCollabFileIndexToSharedState,
  codeCollabFileIndexStatesEqual,
  readCodeCollabFileIndexFromFlock,
  type CodeCollabFileSourceState,
  type CodeCollabRole,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeState,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  describeCodeCollabError,
  logCodeCollabInfo,
  warnCodeCollab,
} from '@/lib/code-collab-debug';
import {
  CodeCollabSessionFileProvider,
  codeCollabFileTreeToSessionFileEntries,
  createCodeCollabSessionFileProviderTextState,
  resolveCodeCollabSessionFileProviderSourceState,
  type CodeCollabSessionFileProviderRuntime,
  type CodeCollabSessionFileProviderTextState,
} from '@/lib/code-collab-session-file-provider';
import { readinessBinding } from '@/lib/room-readiness';
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
  readonly state: CodeCollabV2MaterializedSharedState | null;
};

type CodeCollabFileIndexSnapshot = {
  readonly sourceId: string;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly revision: number;
  readonly updatedAtMs: number;
};

type CodeCollabFileIndexLoadState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly snapshot: CodeCollabFileIndexSnapshot }
  | { readonly status: 'error'; readonly error: unknown };

type CodeCollabFileIndexRuntimeRepo = {
  openFlockDoc: (flockDocId: string) => Promise<{
    readonly flock: Flock;
    readonly joinRoom: () => Promise<RepoRoomSubscription>;
  }>;
};

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
  readonly runtimeRepo: CodeCollabFileIndexRuntimeRepo | null;
  readonly workspaceId: WorkspaceId | string | null | undefined;
  readonly ownerSessionId: SessionId;
  readonly prepareTarget?: () => Promise<unknown>;
}): CodeCollabFileIndexLoadState {
  const [state, setState] = useState<CodeCollabFileIndexLoadState>({ status: 'idle' });
  const { enabled, runtimeRepo, workspaceId, ownerSessionId, prepareTarget } = args;

  useEffect(() => {
    if (!enabled || !runtimeRepo || !workspaceId) {
      setState({ status: 'idle' });
      return undefined;
    }

    const flockDocId = getCodeCollabFileIndexFlockDocId(workspaceId as WorkspaceId, ownerSessionId);
    let cancelled = false;
    let revision = 0;
    let lastPublishedFileIndex: CodeCollabV2FileIndexState | null = null;
    let currentFileIndex: CodeCollabV2FileIndexState = {};
    let unsubscribeFlock: (() => void) | null = null;
    let roomSub: { readonly unsubscribe: () => void } | null = null;
    let remoteSynced = false;

    const publishSnapshot = (
      fileIndex: CodeCollabV2FileIndexState,
      options: { readonly allowEmpty: boolean }
    ): void => {
      currentFileIndex = fileIndex;
      if (!options.allowEmpty && Object.keys(fileIndex).length === 0) {
        return;
      }
      if (
        lastPublishedFileIndex !== null &&
        codeCollabFileIndexStatesEqual(lastPublishedFileIndex, fileIndex)
      ) {
        return;
      }
      lastPublishedFileIndex = fileIndex;
      revision += 1;
      setState({
        status: 'ready',
        snapshot: {
          sourceId: flockDocId,
          fileIndex,
          revision,
          updatedAtMs: getServerNow(),
        },
      });
    };

    setState({ status: 'loading' });
    void (async () => {
      await prepareTarget?.();
      if (cancelled) {
        return;
      }
      logCodeCollabInfo('file-index flock open', {
        workspaceId,
        ownerSessionId,
        flockDocId,
      });
      const handle = await runtimeRepo.openFlockDoc(flockDocId);
      if (cancelled) {
        return;
      }
      const refreshFromFlock = (options: { readonly allowEmpty: boolean }): void => {
        publishSnapshot(readCodeCollabFileIndexFromFlock(handle.flock), options);
      };
      const refreshFromRemoteThenFlock = async (): Promise<void> => {
        const joined = await handle.joinRoom();
        if (cancelled) {
          joined.unsubscribe();
          return;
        }
        roomSub = joined;
        // Dual-homed rooms reject the merged `firstSyncedWithRemote`;
        // readiness is the selected binding's first sync.
        await readinessBinding(joined).firstSyncedWithRemote;
        if (cancelled) return;
        remoteSynced = true;
        refreshFromFlock({ allowEmpty: true });
      };
      refreshFromFlock({ allowEmpty: false });
      void refreshFromRemoteThenFlock().catch((error: unknown) => {
        warnCodeCollab('file-index flock sync failed', {
          workspaceId,
          ownerSessionId,
          flockDocId,
          error: describeCodeCollabError(error),
        });
        if (!cancelled) {
          setState({ status: 'error', error });
        }
      });
      unsubscribeFlock = handle.flock.subscribe((batch) => {
        if (!cancelled) {
          publishSnapshot(applyCodeCollabFileIndexFlockEvents(currentFileIndex, batch.events), {
            allowEmpty: remoteSynced,
          });
        }
      });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({ status: 'error', error });
      }
    });

    return () => {
      cancelled = true;
      unsubscribeFlock?.();
      roomSub?.unsubscribe();
    };
  }, [enabled, ownerSessionId, prepareTarget, runtimeRepo, workspaceId]);

  return state;
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
  const fileIndexLoadState = useCodeCollabFileIndexLoadState({
    enabled: options.enabled !== false && !!machineId,
    runtimeRepo: runtime?.repo ?? null,
    workspaceId,
    ownerSessionId,
    prepareTarget: prepareFileIndexTarget,
  });
  const fileIndexSnapshot =
    fileIndexLoadState.status === 'ready' ? fileIndexLoadState.snapshot : null;
  const sharedStateKey = [
    workspaceId ?? '',
    machineId ?? '',
    ownerSessionId,
    sourceState,
    fileIndexSnapshot?.sourceId ?? '',
  ].join('\u0000');
  const previousSharedState =
    sharedStateRef.current?.key === sharedStateKey ? sharedStateRef.current.state : null;
  const materializedSharedState = materializeCodeCollabV2FileIndexForFileProvider({
    fileIndex: fileIndexSnapshot?.fileIndex ?? null,
    revision: fileIndexSnapshot?.revision ?? 0,
    updatedAtMs: fileIndexSnapshot?.updatedAtMs,
    sourceState,
    previous: previousSharedState,
  });
  sharedStateRef.current = {
    key: sharedStateKey,
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
          { ownerSessionId }
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
      openCurrentDiff: async (path) =>
        await runtime.requestCodeCollabOpenCurrentDiff(
          machineId,
          { sessionId, path },
          { ownerSessionId }
        ),
      openAllChangesDiff: async (focusPath) =>
        await runtime.requestCodeCollabOpenAllChangesDiff(
          machineId,
          { sessionId, ...(focusPath === undefined ? {} : { focusPath }) },
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
  }, [machineId, options.requestedByUserId, ownerSessionId, runtime, sessionId]);

  const provider = useMemo<SessionFileProvider | null>(() => {
    const sharedState = materializedSharedState;
    if (!sharedState || !rpcRuntime) return null;
    return new CodeCollabSessionFileProvider({
      runtime: rpcRuntime,
      role,
      sourceState,
      files: sharedState.files,
      allChanges: sharedState.allChanges,
      updatedAtMs: sharedState.updatedAtMs,
      textState: providerTextState,
    });
  }, [materializedSharedState, providerTextState, role, rpcRuntime, sourceState]);

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
        provider: null,
        status: 'error',
        space: null,
        error: fileIndexLoadState.error,
        message: codeCollabFileIndexErrorMessage(fileIndexLoadState.error),
      };
    }

    return {
      provider: null,
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
