import { useEffect, useState } from 'react';
import i18next from 'i18next';
import { useAtomValue } from 'jotai';
import type { LocalProjectId, MachineId, WorkspaceId } from '@lody/shared';
import { runtimeAtom, userAtom } from '@/atoms';
import { localCliStartingAtom, localMachineIdAtom } from '@/atoms/local-probe';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
} from '@/lib/local-project-rpc-file-provider';
import { getIpcServices } from '@/lib/electron-ipc-client';

export type LocalProjectFilePathsEntry = {
  paths: string[];
  truncated: boolean;
  fetchedAt: number;
};

export type LocalProjectFilePathsStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export type LocalProjectFilePathsState = {
  entry: LocalProjectFilePathsEntry | null;
  status: LocalProjectFilePathsStatus;
  error?: string;
};

type LocalProjectFilePathsLoadResult = { paths: string[]; truncated: boolean };

const LOCAL_PROJECT_CACHE_TTL_MS = 60_000;
const LOCAL_PROJECT_MAX_FILES = 80_000;

/**
 * `fetchedAt` lives on the RECORD, not on the entry, because the entry's
 * identity is load-bearing: the mention menu memoises `buildMentionFileIndex` on
 * it, and rebuilding that means expanding every path into its suggestion
 * tokens — O(repo file count). Since the `@` menu now revalidates
 * on every open, stamping a fresh `Date.now()` onto a new object each time would
 * rebuild the whole index on every mention, which is exactly what the provider
 * source already avoids by returning its previous entry unchanged.
 */
type LocalProjectFilePathsRecord = {
  entry: LocalProjectFilePathsEntry;
  fetchedAt: number;
};

const localProjectPathsCache = new Map<string, LocalProjectFilePathsRecord>();
const localProjectPathsInFlight = new Map<string, Promise<LocalProjectFilePathsLoadResult>>();

const isRecordStale = (record: LocalProjectFilePathsRecord, now: number): boolean =>
  now - record.fetchedAt > LOCAL_PROJECT_CACHE_TTL_MS;

export function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Reuses the previous entry when the machine reported the same listing, so a
 * revalidation that found nothing new keeps the mention index it already built.
 * Exported because that object IDENTITY is the contract, not an implementation
 * detail: losing it is invisible in the rendered list and only shows up as the
 * whole file index being rebuilt on every `@`.
 */
export function resolveLoadedEntry(
  previous: LocalProjectFilePathsEntry | undefined,
  result: LocalProjectFilePathsLoadResult,
  now: number
): LocalProjectFilePathsEntry {
  if (
    previous &&
    previous.truncated === result.truncated &&
    areStringArraysEqual(previous.paths, result.paths)
  ) {
    return previous;
  }
  return { paths: result.paths, truncated: result.truncated, fetchedAt: now };
}

export type LocalProjectFilePathsSource =
  | {
      kind: 'project';
      workspaceId: string;
      machineId?: string;
      localProjectId: string;
    }
  | {
      kind: 'worktree';
      repoKey: string;
      sessionId: string;
    };

type LocalProjectFilePathsInput = LocalProjectFilePathsSource | string | undefined;

/**
 * True when this source is answered over the renderer -> main IPC RPC, false
 * when the same listing has to cross the network as Machine RPC.
 *
 * Exported because callers gate NETWORK COST on it — the mention menu
 * revalidates its list on every `@`, which is a process spawn on this machine
 * and a full project listing over the wire on any other. One binding, so the
 * transport the effect below picks and the cost a caller assumes cannot drift
 * apart. A Session worktree is only ever reachable through the local IPC
 * service, so it has no machine to compare.
 */
export function isLocalPlaneFilePathsSource(
  source: LocalProjectFilePathsSource | null | undefined,
  options: { localMachineId: string | null; hasLocalIpc: boolean }
): boolean {
  if (!source || !options.hasLocalIpc) return false;
  if (source.kind === 'worktree') return true;
  return !source.machineId || source.machineId === options.localMachineId;
}

export type UseLocalProjectFilePathsOptions = {
  /**
   * Forces a fresh file-list request when the token changes. This is used by live
   * session surfaces where the local filesystem can change while the panel stays mounted.
   */
  refreshToken?: string | number | null;
  refreshOnMount?: boolean;
};

function normalizeSource(input: LocalProjectFilePathsInput): LocalProjectFilePathsSource | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    return null;
  }

  if (input.kind === 'project') {
    const workspaceId = input.workspaceId.trim();
    const machineId = input.machineId?.trim();
    const localProjectId = input.localProjectId.trim();
    return workspaceId && localProjectId
      ? { kind: 'project', workspaceId, ...(machineId ? { machineId } : {}), localProjectId }
      : null;
  }

  const repoKey = input.repoKey.trim();
  const sessionId = input.sessionId.trim();
  if (!repoKey || !sessionId) {
    return null;
  }
  return {
    kind: 'worktree',
    repoKey,
    sessionId,
  };
}

export function useLocalProjectFilePaths(
  sourceInput?: LocalProjectFilePathsInput,
  options: UseLocalProjectFilePathsOptions = {}
): LocalProjectFilePathsState {
  const runtime = useAtomValue(runtimeAtom);
  const requestedByUserId = useAtomValue(userAtom)?.id ?? null;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localCliStarting = useAtomValue(localCliStartingAtom);
  const [state, setState] = useState<LocalProjectFilePathsState>({ entry: null, status: 'idle' });
  const source = normalizeSource(sourceInput);
  const sourceKind = source?.kind ?? null;
  const sourceWorkspaceId = source?.kind === 'project' ? source.workspaceId : null;
  const sourceMachineId = source?.kind === 'project' ? (source.machineId ?? null) : null;
  const sourceLocalProjectId = source?.kind === 'project' ? source.localProjectId : null;
  const sourceRepoKey = source?.kind === 'worktree' ? source.repoKey : null;
  const sourceSessionId = source?.kind === 'worktree' ? source.sessionId : null;
  const refreshToken = options.refreshToken ?? null;
  const refreshOnMount = options.refreshOnMount ?? false;

  useEffect(() => {
    if (!sourceKind) {
      setState({ entry: null, status: 'idle' });
      return undefined;
    }

    if (typeof window === 'undefined') {
      setState({ entry: null, status: 'idle' });
      return undefined;
    }

    const listLocalProjectFiles = getIpcServices()?.localProjects.listFiles.bind(
      getIpcServices()!.localProjects
    );
    const listSessionWorktreeFiles = getIpcServices()?.localProjects.listSessionWorktreeFiles.bind(
      getIpcServices()!.localProjects
    );
    let cacheKey = '';
    let loadFiles: (() => Promise<LocalProjectFilePathsLoadResult>) | null = null;

    if (sourceKind === 'project') {
      if (!sourceWorkspaceId || !sourceLocalProjectId) {
        setState({ entry: null, status: 'idle' });
        return undefined;
      }
      // Rebuilt from the scalars rather than closing over `source`: that object
      // is new on every render, and exhaustive-deps would turn it into a refetch
      // loop.
      const canUseLocalProjectIpc = isLocalPlaneFilePathsSource(
        {
          kind: 'project',
          workspaceId: sourceWorkspaceId,
          ...(sourceMachineId ? { machineId: sourceMachineId } : {}),
          localProjectId: sourceLocalProjectId,
        },
        { localMachineId, hasLocalIpc: Boolean(listLocalProjectFiles) }
      );
      // Timing guard: the local desktop CLI advertises its machineId (which flips
      // `canUseLocalProjectIpc`) before its workspace runtimes finish booting.
      // Sending file-list requests in that window throws "Local workspace runtime
      // is unavailable", so wait — show a loading state — while the CLI is still
      // starting. The effect re-runs when `localCliStarting` clears and fetches
      // then (or, if the CLI never comes up, falls through to the error path).
      if (canUseLocalProjectIpc && localCliStarting) {
        setState((prev) => ({
          entry: prev.entry,
          status: prev.entry ? 'refreshing' : 'loading',
        }));
        return undefined;
      }
      if (!canUseLocalProjectIpc && (!runtime || !requestedByUserId || !sourceMachineId)) {
        setState({
          entry: null,
          status: 'error',
          error: i18next.t('sessions.localProject.files.apiUnavailable'),
        });
        return undefined;
      }
      cacheKey = `project:${sourceWorkspaceId}:${sourceMachineId ?? 'local'}:${sourceLocalProjectId}`;
      loadFiles = async () => {
        if (canUseLocalProjectIpc) {
          return await createLocalProjectIpcFileTransport({
            workspaceId: sourceWorkspaceId as WorkspaceId,
            localProjectId: sourceLocalProjectId as LocalProjectId,
          }).listFiles({ maxFiles: LOCAL_PROJECT_MAX_FILES });
        }
        if (!runtime || !requestedByUserId || !sourceMachineId) {
          throw new Error(i18next.t('sessions.localProject.files.apiUnavailable'));
        }
        return await createLocalProjectRpcFileTransport({
          workspaceId: sourceWorkspaceId as WorkspaceId,
          machineId: sourceMachineId as MachineId,
          localProjectId: sourceLocalProjectId as LocalProjectId,
          requestedByUserId,
          requestLocalProjectControl: (request, requestOptions) =>
            runtime.requestLocalProjectControl(request, requestOptions),
        }).listFiles({ maxFiles: LOCAL_PROJECT_MAX_FILES });
      };
    } else {
      if (!sourceRepoKey || !sourceSessionId) {
        setState({ entry: null, status: 'idle' });
        return undefined;
      }
      if (!listSessionWorktreeFiles) {
        setState({
          entry: null,
          status: 'error',
          error: i18next.t('sessions.localProject.files.apiUnavailable'),
        });
        return undefined;
      }
      cacheKey = `worktree:${sourceRepoKey}:${sourceSessionId}`;
      loadFiles = () =>
        listSessionWorktreeFiles(sourceRepoKey, sourceSessionId, {
          maxFiles: LOCAL_PROJECT_MAX_FILES,
        });
    }

    let cancelled = false;
    const now = Date.now();
    const cacheRecord = localProjectPathsCache.get(cacheKey);
    const forceRefresh = refreshOnMount || refreshToken !== null;

    if (cacheRecord) {
      const nextStatus =
        forceRefresh || isRecordStale(cacheRecord, now) ? 'refreshing' : 'ready';
      // Keep the entry identity across a revalidation so the mention index is
      // not rebuilt for a listing that did not change.
      setState((prev) =>
        prev.entry === cacheRecord.entry && prev.status === nextStatus && prev.error === undefined
          ? prev
          : { entry: cacheRecord.entry, status: nextStatus }
      );
    } else {
      setState({ entry: null, status: 'loading' });
    }

    if (cacheRecord && !forceRefresh && !isRecordStale(cacheRecord, now)) {
      return undefined;
    }

    if (!loadFiles) {
      return undefined;
    }

    let inFlight = localProjectPathsInFlight.get(cacheKey);
    if (!inFlight) {
      inFlight = loadFiles().finally(() => {
        localProjectPathsInFlight.delete(cacheKey);
      });
      localProjectPathsInFlight.set(cacheKey, inFlight);
    }

    void inFlight
      .then((result) => {
        const settledAt = Date.now();
        const nextEntry = resolveLoadedEntry(
          localProjectPathsCache.get(cacheKey)?.entry,
          result,
          settledAt
        );
        // Cache even when this caller was cancelled: the listing is workspace
        // state, not component state, and the next mount should not refetch it.
        localProjectPathsCache.set(cacheKey, { entry: nextEntry, fetchedAt: settledAt });
        if (cancelled) return;
        setState((prev) =>
          prev.entry === nextEntry && prev.status === 'ready' && prev.error === undefined
            ? prev
            : { entry: nextEntry, status: 'ready' }
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const rawMessage = error instanceof Error ? error.message : String(error);
        // Electron IPC wraps errors with "Error invoking remote method '...': Error: ..."
        const ipcPrefix = /^Error invoking remote method '[^']*':\s*Error:\s*/;
        const errorCode = rawMessage.replace(ipcPrefix, '');
        const message =
          errorCode === 'cli_not_running'
            ? i18next.t('sessions.localProject.files.cliNotRunning')
            : errorCode || i18next.t('sessions.localProject.files.loadFailed');
        setState((prev) => ({
          entry: prev.entry,
          status: 'error',
          error: message,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    sourceKind,
    sourceWorkspaceId,
    sourceMachineId,
    sourceLocalProjectId,
    sourceRepoKey,
    sourceSessionId,
    refreshToken,
    refreshOnMount,
    localMachineId,
    localCliStarting,
    requestedByUserId,
    runtime,
  ]);

  return state;
}
