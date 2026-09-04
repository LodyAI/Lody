import * as React from 'react';
import i18next from 'i18next';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import type { LocalProjectId, MachineId, SessionId, WorkspaceId } from '@lody/shared';

import { currentWorkspaceIdAtom, runtimeAtom, userAtom } from '@/atoms';
import { buildPathSuggestions, useRepoFilePaths } from '@/components/mentions/file-at-mention';
import type {
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
} from '@/lib/file-workspace-provider';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
} from '@/lib/local-project-rpc-file-provider';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
  captureMentionFileLocalFetchError,
  type MentionLocalFetchErrorCode,
} from '@/components/mentions/mention-analytics';
import {
  areStringArraysEqual,
  useLocalProjectFilePaths,
  type LocalProjectFilePathsSource,
  type LocalProjectFilePathsEntry,
  type LocalProjectFilePathsState,
  type LocalProjectFilePathsStatus,
} from '@/hooks/use-local-project-file-paths';
import { localMachineIdAtom } from '@/atoms/local-probe';

export type MentionProjectSource =
  | {
      kind: 'github';
      repoFullName?: string;
      isPublic?: boolean;
      localWorktree?: { machineId: MachineId; repoKey: string; sessionId: SessionId };
    }
  | {
      kind: 'local';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      githubRepoFullName?: string;
      localWorktree?: { machineId: MachineId; repoKey: string; sessionId: SessionId };
    }
  | {
      kind: 'provider';
      provider?: FileWorkspaceProvider | null;
      providerPending?: boolean;
      providerMessage?: string;
      /** Project identity retained when a live provider serves a local Session workspace. */
      localProject?: { machineId: MachineId; localProjectId: LocalProjectId };
      githubRepoFullName?: string;
      isPublic?: boolean;
    };

export type MentionLazyDirectoryEntry = {
  path: string;
  directoryId: string;
};

export type MentionFilePathsEntry = LocalProjectFilePathsEntry & {
  lazyDirectories?: readonly MentionLazyDirectoryEntry[];
};
export type MentionFileDataStatus = LocalProjectFilePathsStatus;
export type MentionFileDataState = Omit<LocalProjectFilePathsState, 'entry'> & {
  entry: MentionFilePathsEntry | null;
};

export type LocalProjectFileReadResult = {
  path: string;
  content: string;
  truncated: boolean;
  encoding?: 'utf8' | 'base64';
};

export function buildMentionFilePathsEntryFromProviderEntries(
  entries: readonly FileWorkspaceProviderEntry[],
  fetchedAt = Date.now(),
  previous?: MentionFilePathsEntry | null
): MentionFilePathsEntry {
  const paths = [
    ...new Set(
      entries
        .filter((entry) => entry.entryType !== 'lazy-directory')
        .map((entry) => entry.path)
        .filter(Boolean)
    ),
  ].sort((left, right) => left.localeCompare(right));
  const lazyDirectories = [
    ...new Map(
      entries
        .filter((entry) => entry.entryType === 'lazy-directory' && entry.directoryId)
        .map((entry) => [
          entry.path,
          {
            path: entry.path,
            directoryId: entry.directoryId as string,
          },
        ])
    ).values(),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (
    previous &&
    previous.truncated === false &&
    areStringArraysEqual(previous.paths, paths) &&
    areMentionLazyDirectoriesEqual(previous.lazyDirectories, lazyDirectories)
  ) {
    return previous;
  }
  return {
    paths,
    ...(lazyDirectories.length === 0 ? {} : { lazyDirectories }),
    truncated: false,
    fetchedAt,
  };
}

function areMentionLazyDirectoriesEqual(
  left: readonly MentionLazyDirectoryEntry[] | undefined,
  right: readonly MentionLazyDirectoryEntry[] | undefined
): boolean {
  const leftEntries = left ?? [];
  const rightEntries = right ?? [];
  if (leftEntries.length !== rightEntries.length) return false;
  for (let index = 0; index < leftEntries.length; index += 1) {
    const leftEntry = leftEntries[index];
    const rightEntry = rightEntries[index];
    if (
      !leftEntry ||
      !rightEntry ||
      leftEntry.path !== rightEntry.path ||
      leftEntry.directoryId !== rightEntry.directoryId
    ) {
      return false;
    }
  }
  return true;
}

function providerFileDataLoadingState(
  prev: MentionFileDataState,
  error?: string
): MentionFileDataState {
  const nextStatus = prev.entry ? 'refreshing' : 'loading';
  if (prev.status === nextStatus && prev.error === error) return prev;
  return {
    entry: prev.entry,
    status: nextStatus,
    ...(error === undefined ? {} : { error }),
  };
}

function providerFileDataReadyState(
  prev: MentionFileDataState,
  entries: readonly FileWorkspaceProviderEntry[]
): MentionFileDataState {
  const entry = buildMentionFilePathsEntryFromProviderEntries(entries, Date.now(), prev.entry);
  if (prev.status === 'ready' && prev.entry === entry && prev.error === undefined) return prev;
  return {
    entry,
    status: 'ready',
  };
}

function providerFileDataErrorState(
  prev: MentionFileDataState,
  error: string
): MentionFileDataState {
  if (prev.status === 'error' && prev.error === error) return prev;
  return {
    entry: prev.entry,
    status: 'error',
    error,
  };
}

// The local file-paths hook localizes its error before exposing it, so the raw
// `cli_not_running` / `api_unavailable` code is gone by the time we see it. Map
// the message back by comparing against the same i18n keys the hook uses; fall
// back to substring detection (raw code passthrough) so we still classify.
// Rejected: changing the hook to expose a code — it lives outside this area.
function classifyLocalFetchError(message: string | undefined): MentionLocalFetchErrorCode {
  if (!message) return 'unknown';
  if (message === i18next.t('sessions.localProject.files.cliNotRunning')) return 'cli_not_running';
  if (message === i18next.t('sessions.localProject.files.apiUnavailable')) return 'api_unavailable';
  const lower = message.toLowerCase();
  if (lower.includes('cli_not_running') || lower.includes('cli not running')) {
    return 'cli_not_running';
  }
  if (lower.includes('api_unavailable') || lower.includes('unavailable')) return 'api_unavailable';
  return 'unknown';
}

export function useMentionProjectFiles(source?: MentionProjectSource) {
  const postHog = usePostHog();
  const analyticsWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(runtimeAtom);
  const requestedByUserId = useAtomValue(userAtom)?.id ?? null;
  const localDaemonMachineId = useAtomValue(localMachineIdAtom);
  const sourceKind = source?.kind;
  const repoFullName = source?.kind === 'github' ? source.repoFullName : undefined;
  const localWorkspaceId = source?.kind === 'local' ? source.workspaceId : undefined;
  const localMachineId = source?.kind === 'local' ? source.machineId : undefined;
  const localProjectId = source?.kind === 'local' ? source.localProjectId : undefined;
  const provider = source?.kind === 'provider' ? source.provider : undefined;
  const providerPending = source?.kind === 'provider' ? source.providerPending : false;
  const providerMessage = source?.kind === 'provider' ? source.providerMessage : undefined;
  const localWorktreeSessionId =
    (source?.kind === 'github' || source?.kind === 'local') && source.localWorktree
      ? source.localWorktree.sessionId
      : undefined;
  const localWorktreeRepoKey =
    (source?.kind === 'github' || source?.kind === 'local') && source.localWorktree
      ? source.localWorktree.repoKey
      : undefined;
  const useLocalWorktreeSource = Boolean(localWorktreeSessionId && localWorktreeRepoKey);
  const localSource = React.useMemo<LocalProjectFilePathsSource | undefined>(() => {
    if (useLocalWorktreeSource && localWorktreeRepoKey && localWorktreeSessionId) {
      return {
        kind: 'worktree',
        repoKey: localWorktreeRepoKey,
        sessionId: localWorktreeSessionId,
      };
    }
    if (sourceKind === 'local' && localWorkspaceId && localProjectId) {
      return {
        kind: 'project',
        workspaceId: localWorkspaceId,
        machineId: localMachineId,
        localProjectId,
      };
    }
    return undefined;
  }, [
    localMachineId,
    localProjectId,
    localWorktreeRepoKey,
    localWorkspaceId,
    localWorktreeSessionId,
    sourceKind,
    useLocalWorktreeSource,
  ]);

  // A local list is a `git ls-files` on the machine, not a billed network call,
  // and the working tree moves under the user between two `@`s — they drop a
  // folder into the project and reach for it immediately. So the local source is
  // the one source that REVALIDATES on activation instead of only ensuring it is
  // loaded; `null` until the first activation keeps a composer mount (one per
  // open tab and side chat) on the cached read.
  const [localRefreshNonce, setLocalRefreshNonce] = React.useState<number | null>(null);
  const refreshLocalFiles = React.useCallback(() => {
    setLocalRefreshNonce((nonce) => (nonce ?? 0) + 1);
  }, []);

  const githubFileData = useRepoFilePaths(repoFullName);
  const localFileData = useLocalProjectFilePaths(localSource, { refreshToken: localRefreshNonce });
  const [providerFileData, setProviderFileData] = React.useState<MentionFileDataState>({
    entry: null,
    status: 'idle',
  });

  React.useEffect(() => {
    if (sourceKind !== 'provider') {
      return undefined;
    }

    if (providerPending === true && !provider) {
      setProviderFileData((prev) =>
        prev.entry === null && prev.status === 'loading' && prev.error === providerMessage
          ? prev
          : {
              entry: null,
              status: 'loading',
              ...(providerMessage === undefined ? {} : { error: providerMessage }),
            }
      );
      return undefined;
    }

    if (!provider) {
      setProviderFileData((prev) =>
        prev.entry === null && prev.status === 'idle' && prev.error === undefined
          ? prev
          : { entry: null, status: 'idle' }
      );
      return undefined;
    }

    const providerState = provider.getState();
    if (!providerState.ready) {
      const error = providerState.message ?? 'Files are unavailable.';
      setProviderFileData((prev) =>
        prev.entry === null && prev.status === 'error' && prev.error === error
          ? prev
          : {
              entry: null,
              status: 'error',
              error,
            }
      );
      return undefined;
    }

    let cancelled = false;
    setProviderFileData((prev) => providerFileDataLoadingState(prev));

    const unsubscribeFiles = provider.subscribeFiles?.((entries) => {
      if (cancelled) return;
      setProviderFileData((prev) => providerFileDataReadyState(prev, entries));
    });

    void provider
      .listFiles()
      .then((entries) => {
        if (cancelled) return;
        setProviderFileData((prev) => providerFileDataReadyState(prev, entries));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProviderFileData((prev) =>
          providerFileDataErrorState(
            prev,
            error instanceof Error ? error.message : 'Failed to load files.'
          )
        );
      });

    return () => {
      cancelled = true;
      unsubscribeFiles?.();
    };
  }, [provider, providerMessage, providerPending, sourceKind]);

  const initializeLazyDirectory = React.useCallback(
    async (directoryId: string): Promise<void> => {
      if (sourceKind !== 'provider' || !provider?.initializeDirectory) return;
      setProviderFileData((prev) => providerFileDataLoadingState(prev));
      try {
        await provider.initializeDirectory(directoryId);
        const entries = await provider.listFiles();
        setProviderFileData((prev) => providerFileDataReadyState(prev, entries));
      } catch (error: unknown) {
        setProviderFileData((prev) =>
          providerFileDataErrorState(
            prev,
            error instanceof Error ? error.message : 'Failed to load files.'
          )
        );
      }
    },
    [provider, sourceKind]
  );

  // `mention/file/local_fetch_error` (tier A). Fire once per distinct error
  // message so a sticky error state does not re-emit on every re-render.
  const usesLocalSource = sourceKind === 'local' || useLocalWorktreeSource;
  const localErrorTrackedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!usesLocalSource) {
      localErrorTrackedRef.current = null;
      return;
    }
    if (localFileData.status !== 'error') {
      localErrorTrackedRef.current = null;
      return;
    }
    const message = localFileData.error ?? '';
    if (localErrorTrackedRef.current === message) return;
    localErrorTrackedRef.current = message;
    captureMentionFileLocalFetchError(
      postHog,
      { workspaceId: analyticsWorkspaceId },
      {
        errorCode: classifyLocalFetchError(localFileData.error),
        sourceKind: useLocalWorktreeSource ? 'worktree' : 'local',
      }
    );
  }, [
    analyticsWorkspaceId,
    localFileData.error,
    localFileData.status,
    postHog,
    useLocalWorktreeSource,
    usesLocalSource,
  ]);

  const fileData = React.useMemo<MentionFileDataState>(() => {
    if (sourceKind === 'provider') {
      return providerFileData;
    }
    if (sourceKind === 'local' || useLocalWorktreeSource) {
      return localFileData;
    }

    return {
      entry: githubFileData.entry
        ? {
            paths: githubFileData.entry.paths,
            truncated: githubFileData.entry.truncated,
            fetchedAt: githubFileData.entry.fetchedAt,
          }
        : null,
      status: githubFileData.status,
      error: githubFileData.error,
    };
  }, [githubFileData, localFileData, providerFileData, sourceKind, useLocalWorktreeSource]);

  // Expanding every indexed path into its suggestion tokens is O(repo file
  // count) and its only consumer is draft hydration, which no-ops on an empty
  // composer — the common case. Computing it eagerly charged that cost to every
  // composer mount, i.e. to every session switch. Hand out a memoized thunk so
  // the work happens on first real use and is then cached per file-index entry.
  const getKnownFileTokens = React.useMemo(() => {
    const entry = fileData.entry;
    let cached: Set<string> | null = null;
    return (): Set<string> => {
      if (cached) return cached;
      const paths = entry?.paths ?? [];
      const lazyDirectoryTokens =
        entry?.lazyDirectories?.flatMap((lazyEntry) => {
          const token = buildLazyDirectoryToken(lazyEntry.path);
          return token ? [token] : [];
        }) ?? [];
      cached =
        !paths.length && lazyDirectoryTokens.length === 0
          ? new Set<string>()
          : new Set([...buildPathSuggestions(paths).allTokens, ...lazyDirectoryTokens]);
      return cached;
    };
  }, [fileData.entry]);

  const readLocalProjectFile = React.useCallback(
    async (
      path: string,
      options?: { maxBytes?: number }
    ): Promise<LocalProjectFileReadResult | null> => {
      if (typeof window === 'undefined') return null;

      if (sourceKind === 'local' && localWorkspaceId && localProjectId) {
        const canUseIpc =
          Boolean(getIpcServices()) && (!localMachineId || localMachineId === localDaemonMachineId);
        if (canUseIpc) {
          return await createLocalProjectIpcFileTransport({
            workspaceId: localWorkspaceId,
            localProjectId,
          }).readFile({ relativePath: path, maxBytes: options?.maxBytes });
        }
        if (!runtime || !requestedByUserId || !localMachineId) {
          throw new Error('Local file API is unavailable.');
        }
        return await createLocalProjectRpcFileTransport({
          workspaceId: localWorkspaceId,
          machineId: localMachineId,
          localProjectId,
          requestedByUserId,
          requestLocalProjectControl: (request, requestOptions) =>
            runtime.requestLocalProjectControl(request, requestOptions),
        }).readFile({ relativePath: path, maxBytes: options?.maxBytes });
      }

      if (useLocalWorktreeSource && localWorktreeSessionId && localWorktreeRepoKey) {
        const reader = getIpcServices()?.localProjects.readSessionWorktreeFile.bind(
          getIpcServices()!.localProjects
        );
        if (!reader) {
          throw new Error('Local worktree file API is unavailable.');
        }
        return await reader(localWorktreeRepoKey, localWorktreeSessionId, path, options);
      }

      return null;
    },
    [
      localProjectId,
      localMachineId,
      localDaemonMachineId,
      localWorktreeRepoKey,
      localWorkspaceId,
      localWorktreeSessionId,
      requestedByUserId,
      runtime,
      sourceKind,
      useLocalWorktreeSource,
    ]
  );

  return {
    fileData,
    initializeLazyDirectory,
    getKnownFileTokens,
    readLocalProjectFile,
    /**
     * Undefined unless the files come from a local transport. A GitHub tree is a
     * billed request against a rate limit and the Code Collab provider already
     * pushes its own updates, so neither may be refetched per menu open.
     */
    refreshFiles: localSource ? refreshLocalFiles : undefined,
  };
}

export function buildLazyDirectoryToken(path: string): string | null {
  const normalized = path.replace(/^\/+|\/+$/gu, '');
  return normalized ? `${normalized}/` : null;
}
