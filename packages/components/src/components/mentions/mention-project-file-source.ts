import * as React from 'react';
import { useAtomValue } from 'jotai';
import type { LocalProjectId, MachineId, SessionId, WorkspaceId } from '@lody/shared';

import { runtimeAtom, userAtom } from '@/atoms';
import { buildPathSuggestions, useRepoFilePaths } from '@/components/mentions/file-at-mention';
import { forEachAtTokenSpan } from '@/components/mentions/mention-hydration';
import type {
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
} from '@/lib/file-workspace-provider';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
  DEFAULT_LOCAL_PROJECT_SEARCH_LIMIT,
  type LocalProjectFileTransport,
} from '@/lib/local-project-rpc-file-provider';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
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
      issuePrEnabled?: boolean;
      localWorktree?: { machineId: MachineId; repoKey: string; sessionId: SessionId };
    }
  | {
      kind: 'local';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      githubRepoFullName?: string;
      isPublic?: boolean;
      localWorktree?: { machineId: MachineId; repoKey: string; sessionId: SessionId };
    }
  | {
      kind: 'provider';
      provider?: FileWorkspaceProvider | null;
      providerPending?: boolean;
      providerMessage?: string;
      /** Project identity retained when a live provider serves a local Session workspace. */
      localProject?: {
        workspaceId?: WorkspaceId;
        machineId: MachineId;
        localProjectId: LocalProjectId;
      };
      githubRepoFullName?: string;
      isPublic?: boolean;
      issuePrEnabled?: boolean;
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

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

/** Draft tokens looked up on the host when a restored draft needs hydration. */
const REMOTE_HYDRATION_MAX_TOKENS = 20;
/** Bounds the paths a long-lived composer accumulates from host searches. */
const REMOTE_SEARCH_MAX_KNOWN_PATHS = 20_000;

type RemoteFileSearchState = {
  sourceKey: string | null;
  paths: readonly string[];
  truncated: boolean;
  pending: number;
  /** A search has answered (or failed); until then the source is still loading. */
  settled: boolean;
  error?: string;
  /** The host answered "no such request": use the full-list path instead. */
  unsupported: boolean;
};

const EMPTY_REMOTE_FILE_SEARCH: RemoteFileSearchState = {
  sourceKey: null,
  paths: [],
  truncated: false,
  pending: 0,
  settled: false,
  unsupported: false,
};

export type UseMentionProjectFilesOptions = {
  /**
   * Whether anything needs the file list yet: the `@` menu asked, or the draft
   * carries an `@` token to hydrate. Nothing is fetched while false.
   */
  active?: boolean;
  /** The draft text; a remote search source looks up its `@` tokens once. */
  hydrationText?: string;
};

export function useMentionProjectFiles(
  source?: MentionProjectSource,
  options: UseMentionProjectFilesOptions = {}
) {
  const active = options.active ?? true;
  const hydrationText = options.hydrationText ?? '';
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

  const remoteSearchTransport = React.useMemo<LocalProjectFileTransport | null>(() => {
    if (useLocalWorktreeSource || sourceKind !== 'local') return null;
    if (!localWorkspaceId || !localProjectId || !localMachineId) return null;
    if (getIpcServices() && localMachineId === localDaemonMachineId) return null;
    if (!runtime || !requestedByUserId) return null;
    return createLocalProjectRpcFileTransport({
      workspaceId: localWorkspaceId,
      machineId: localMachineId,
      localProjectId,
      requestedByUserId,
      requestLocalProjectControl: (request, requestOptions) =>
        runtime.requestLocalProjectControl(request, requestOptions),
    });
  }, [
    localDaemonMachineId,
    localMachineId,
    localProjectId,
    localWorkspaceId,
    requestedByUserId,
    runtime,
    sourceKind,
    useLocalWorktreeSource,
  ]);
  const remoteSourceKey = remoteSearchTransport
    ? `${localWorkspaceId}:${localMachineId}:${localProjectId}`
    : null;
  const [remoteSearchState, setRemoteSearchState] =
    React.useState<RemoteFileSearchState>(EMPTY_REMOTE_FILE_SEARCH);
  const remoteSearch =
    remoteSearchState.sourceKey === remoteSourceKey ? remoteSearchState : EMPTY_REMOTE_FILE_SEARCH;
  const useRemoteSearch = Boolean(remoteSearchTransport) && !remoteSearch.unsupported;
  const remoteQueriedRef = React.useRef<{ sourceKey: string | null; terms: Set<string> }>({
    sourceKey: null,
    terms: new Set(),
  });

  const searchRemoteFiles = React.useCallback(
    (term: string) => {
      const query = term.trim();
      if (!remoteSearchTransport || !remoteSourceKey) return;
      if (remoteQueriedRef.current.sourceKey !== remoteSourceKey) {
        remoteQueriedRef.current = { sourceKey: remoteSourceKey, terms: new Set() };
      }
      const queried = remoteQueriedRef.current.terms;
      if (queried.has(query)) return;
      queried.add(query);

      const update = (apply: (prev: RemoteFileSearchState) => RemoteFileSearchState) =>
        setRemoteSearchState((prev) =>
          apply(
            prev.sourceKey === remoteSourceKey
              ? prev
              : { ...EMPTY_REMOTE_FILE_SEARCH, sourceKey: remoteSourceKey }
          )
        );
      update((prev) => ({ ...prev, pending: prev.pending + 1 }));
      void remoteSearchTransport
        .searchFiles({ query, limit: DEFAULT_LOCAL_PROJECT_SEARCH_LIMIT })
        .then((result) => {
          update((prev) => {
            if (!result) {
              return { ...prev, pending: prev.pending - 1, settled: true, unsupported: true };
            }
            const known = new Set(prev.paths);
            const added = result.paths.filter((path) => !known.has(path));
            const paths =
              added.length === 0 || known.size >= REMOTE_SEARCH_MAX_KNOWN_PATHS
                ? prev.paths
                : [...prev.paths, ...added].sort((left, right) => left.localeCompare(right));
            const { error: _previousError, ...rest } = prev;
            return {
              ...rest,
              paths,
              truncated: result.truncated,
              pending: prev.pending - 1,
              settled: true,
            };
          });
        })
        .catch((error: unknown) => {
          queried.delete(query);
          update((prev) => ({
            ...prev,
            pending: prev.pending - 1,
            settled: true,
            error: error instanceof Error ? error.message : 'Failed to load files.',
          }));
        });
    },
    [remoteSearchTransport, remoteSourceKey]
  );

  const remoteHydratedSourceRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!active || !useRemoteSearch || !remoteSourceKey || !hydrationText.includes('@')) return;
    if (remoteHydratedSourceRef.current === remoteSourceKey) return;
    remoteHydratedSourceRef.current = remoteSourceKey;
    const tokens = new Set<string>();
    forEachAtTokenSpan(hydrationText, ({ token }) => {
      if (token && tokens.size < REMOTE_HYDRATION_MAX_TOKENS)
        tokens.add(token.replace(/\/+$/u, ''));
      return false;
    });
    for (const token of tokens) searchRemoteFiles(token);
  }, [active, hydrationText, remoteSourceKey, searchRemoteFiles, useRemoteSearch]);

  const githubFileData = useRepoFilePaths(active ? repoFullName : undefined);
  const localFileData = useLocalProjectFilePaths(
    active && !useRemoteSearch ? localSource : undefined
  );
  const [providerFileData, setProviderFileData] = React.useState<MentionFileDataState>({
    entry: null,
    status: 'idle',
  });

  React.useEffect(() => {
    if (sourceKind !== 'provider' || !active) {
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
  }, [active, provider, providerMessage, providerPending, sourceKind]);

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

  const remoteEntry = React.useMemo<MentionFilePathsEntry | null>(
    () =>
      remoteSearch.paths.length === 0
        ? null
        : { paths: [...remoteSearch.paths], truncated: remoteSearch.truncated, fetchedAt: 0 },
    [remoteSearch.paths, remoteSearch.truncated]
  );

  const fileData = React.useMemo<MentionFileDataState>(() => {
    if (!active && source) {
      return { entry: null, status: 'loading' };
    }
    if (sourceKind === 'provider') {
      return providerFileData;
    }
    if (useRemoteSearch) {
      return {
        entry: remoteEntry,
        status:
          remoteSearch.pending > 0 || !remoteSearch.settled
            ? remoteEntry
              ? 'refreshing'
              : 'loading'
            : remoteSearch.error && !remoteEntry
              ? 'error'
              : 'ready',
        ...(remoteSearch.error ? { error: remoteSearch.error } : {}),
      };
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
  }, [
    active,
    githubFileData,
    localFileData,
    providerFileData,
    remoteEntry,
    remoteSearch.error,
    remoteSearch.pending,
    remoteSearch.settled,
    source,
    sourceKind,
    useLocalWorktreeSource,
    useRemoteSearch,
  ]);

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
            machineId: localDaemonMachineId,
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
    /** Set when the host searches for the menu; the menu feeds it each typed term. */
    searchRemoteFiles: useRemoteSearch ? searchRemoteFiles : undefined,
  };
}

export function buildLazyDirectoryToken(path: string): string | null {
  const normalized = path.replace(/^\/+|\/+$/gu, '');
  return normalized ? `${normalized}/` : null;
}
