import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeCollabAllChangesScope, SessionId } from '@lody/shared';
import { sessionFileProviderDiffResultToFileDiffData } from '@/lib/session-file-provider-diff';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import type { FileDiffData } from './session-conversation-diff-types';
import {
  shouldRetrySessionProviderDiffErrorMessage,
  useSessionConversationDiffData,
} from './use-session-conversation-diff-data';
import { getSessionDiffErrorMessage } from '@/lib/session-diff-diagnostics';

const RETRY_DELAY_MS = 800;
const EMPTY_PATHS: string[] = [];
const EMPTY_DIFF_DATA: Record<string, FileDiffData> = {};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }
    window.setTimeout(resolve, ms);
  });

/**
 * Base ("All Changes") diff loader. Unlike {@link useSessionConversationDiffData}, which pulls
 * each file with its own gated Machine RPC, this fires ONE batched `getAllChangesDiff` request
 * that returns every changed file's current diff. Files the machine could not inline come back
 * `deferred` and are fetched via the shared per-file loader only near the viewport
 * (focus first, bounded). One request
 * means no per-file fan-out, no 1200ms trickle, and a clean single-request retry.
 *
 * Returns the same shape the diff panel consumes from the conversation hook, so the panel can
 * select between the two by `mode`.
 *
 * `ownerOffline` means presence has positively observed the owner Machine offline ('unknown' must
 * not set it). Every diff here is read live from that Machine, so the hook sends nothing, drops any
 * earlier batch instead of presenting it as current, and refetches once the owner returns.
 */
export function useSessionAllChangesDiffData({
  sessionId,
  filePaths,
  loadFilePaths,
  focusPath,
  fileProvider,
  fileProviderPending = false,
  enabled = true,
  scope = 'branch',
  ownerOffline = false,
}: {
  sessionId: SessionId;
  filePaths: string[];
  loadFilePaths?: string[];
  focusPath?: string | null;
  fileProvider?: SessionFileProvider | null;
  fileProviderPending?: boolean;
  enabled?: boolean;
  scope?: CodeCollabAllChangesScope;
  ownerOffline?: boolean;
}): {
  cacheKey: string | null;
  normalizedPaths: string[];
  resolvedByPath: Record<string, FileDiffData>;
  hasAllResolved: boolean;
  isDiffUnavailable: boolean;
  isPanelLoading: boolean;
  batchReady: boolean;
  base: string | null;
  unavailableScopeReason: 'not_a_git_worktree' | 'no_commits' | null;
  unavailableMessage: string | null;
  ownerOffline: boolean;
} {
  const normalizedInputPaths = useMemo(
    () => Array.from(new Set(filePaths.filter(Boolean))).toSorted((a, b) => a.localeCompare(b)),
    [filePaths]
  );
  const normalizedPathsKey = useMemo(
    () => JSON.stringify(normalizedInputPaths),
    [normalizedInputPaths]
  );

  const [batch, setBatch] = useState<{
    provider: SessionFileProvider;
    pathsKey: string;
    scope: CodeCollabAllChangesScope;
    inline: Record<string, FileDiffData>;
    deferred: string[];
    entryPaths: string[];
    base: string | null;
    unavailableScopeReason: 'not_a_git_worktree' | 'no_commits' | null;
    unavailableMessage: string | null;
  } | null>(null);
  const currentBatch =
    !ownerOffline &&
    batch !== null &&
    batch.provider === fileProvider &&
    batch.pathsKey === normalizedPathsKey &&
    batch.scope === scope
      ? batch
      : null;
  const normalizedPaths = useMemo(
    () =>
      scope === 'uncommitted' && currentBatch !== null
        ? currentBatch.entryPaths
        : normalizedInputPaths,
    [currentBatch, normalizedInputPaths, scope]
  );
  const deferredData = useSessionConversationDiffData({
    sessionId,
    mode: 'base',
    filePaths: currentBatch?.deferred ?? EMPTY_PATHS,
    loadFilePaths,
    priorityFilePath: focusPath,
    fileProvider,
    fileProviderPending,
    requestScope: currentBatch ?? undefined,
    allChangesScope: scope,
    enabled: enabled && currentBatch !== null && currentBatch.deferred.length > 0,
  });
  const resolvedByPath = useMemo(
    () =>
      currentBatch === null
        ? EMPTY_DIFF_DATA
        : {
            ...currentBatch.inline,
            ...Object.fromEntries(
              currentBatch.deferred.flatMap((path) => {
                const data = deferredData.resolvedByPath[path];
                return data ? [[path, data]] : [];
              })
            ),
          },
    [currentBatch, deferredData.resolvedByPath]
  );

  // Keep focusPath out of the fetch deps (it only affects inline ordering, not the result set)
  // so changing the selected file does not re-fire the whole batch.
  const focusPathRef = useRef(focusPath);
  focusPathRef.current = focusPath;

  const canBatch = Boolean(fileProvider?.getAllChangesDiff);
  const isDiffUnavailable =
    !fileProviderPending && (!fileProvider || !canBatch) && normalizedPaths.length > 0;

  useEffect(() => {
    if (!enabled || ownerOffline || !fileProvider?.getAllChangesDiff) {
      return undefined;
    }
    let cancelled = false;
    const getAllChangesDiff = fileProvider.getAllChangesDiff.bind(fileProvider);

    const publish = (
      inline: Record<string, FileDiffData>,
      deferred: string[] = [],
      extra: {
        base?: string | null;
        unavailableScopeReason?: 'not_a_git_worktree' | 'no_commits' | null;
        unavailableMessage?: string | null;
      } = {}
    ): void => {
      if (!cancelled)
        setBatch({
          provider: fileProvider,
          pathsKey: normalizedPathsKey,
          scope,
          inline,
          deferred,
          entryPaths: [...Object.keys(inline), ...deferred],
          base: extra.base ?? null,
          unavailableScopeReason: extra.unavailableScopeReason ?? null,
          unavailableMessage: extra.unavailableMessage ?? null,
        });
    };

    const run = async (): Promise<void> => {
      const focus = focusPathRef.current ?? undefined;
      const requestScope = scope === 'branch' ? undefined : scope;
      let result = await getAllChangesDiff(focus, requestScope);
      if (
        !cancelled &&
        result.status === 'unavailable' &&
        shouldRetrySessionProviderDiffErrorMessage(result.message ?? result.reason)
      ) {
        await delay(RETRY_DELAY_MS);
        if (cancelled) return;
        result = await getAllChangesDiff(focus, requestScope);
      }
      if (cancelled) return;

      if (result.status === 'unavailable') {
        if (scope === 'uncommitted') {
          publish({}, [], {
            unavailableScopeReason: result.scopeReason ?? null,
            unavailableMessage: result.message ?? null,
          });
          return;
        }
        // Mark every expected path unavailable so the panel stops spinning.
        const next: Record<string, FileDiffData> = {};
        for (const path of normalizedInputPaths) {
          next[path] = sessionFileProviderDiffResultToFileDiffData({
            status: 'unavailable',
            path,
            reason: result.reason,
            ...(result.message === undefined ? {} : { message: result.message }),
          });
        }
        publish(next, [], { unavailableMessage: result.message ?? null });
        return;
      }

      const entryPathSet = new Set(result.entries.map((entry) => entry.path));
      const deferredPaths: string[] = [];
      const next: Record<string, FileDiffData> = {};
      for (const entry of result.entries) {
        if (entry.diff.status === 'deferred') {
          deferredPaths.push(entry.path);
          continue;
        }
        next[entry.path] = sessionFileProviderDiffResultToFileDiffData(entry.diff);
      }
      // Branch mode reconciles expected paths the batch did not mention so `hasAllResolved`
      // can complete (the list can briefly disagree with git). Uncommitted mode renders the
      // batch's own file set, so committed-only paths must not be added.
      if (scope === 'branch') {
        for (const path of normalizedInputPaths) {
          if (next[path] !== undefined || entryPathSet.has(path)) {
            continue;
          }
          next[path] = sessionFileProviderDiffResultToFileDiffData({
            status: 'unavailable',
            path,
            reason: 'metadata-only',
          });
        }
      }
      if (cancelled) return;
      publish(next, deferredPaths, { base: result.base });
    };

    void run().catch((error: unknown) => {
      const message = getSessionDiffErrorMessage(error);
      publish(
        scope === 'branch'
          ? Object.fromEntries(
              normalizedInputPaths.map((path) => [path, { status: 'error', message }])
            )
          : {},
        [],
        { unavailableMessage: message }
      );
    });
    return () => {
      cancelled = true;
    };
    // Refetch when the provider is rebuilt (file-index/list changed → D4), the path set,
    // the comparison scope or owner liveness changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fileProvider, normalizedPathsKey, ownerOffline, scope]);

  const hasAllResolved = useMemo(
    () => normalizedPaths.every((path) => Boolean(resolvedByPath[path])),
    [normalizedPaths, resolvedByPath]
  );
  const isPanelLoading =
    !ownerOffline && normalizedPaths.length > 0 && !isDiffUnavailable && !hasAllResolved;
  const unavailableMessage = currentBatch?.unavailableMessage ?? null;
  const batchReady =
    currentBatch !== null &&
    unavailableMessage === null &&
    (currentBatch.unavailableScopeReason ?? null) === null;

  return {
    cacheKey: null,
    normalizedPaths,
    resolvedByPath,
    hasAllResolved,
    isDiffUnavailable,
    isPanelLoading,
    batchReady,
    base: currentBatch?.base ?? null,
    unavailableScopeReason: currentBatch?.unavailableScopeReason ?? null,
    unavailableMessage,
    ownerOffline,
  };
}
