import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { withGitHubTokenRetry, withGitHubOperationTokenRetry } from '@/lib/github-token';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAuthenticatedConvex } from './use-authenticated-convex';

/** Hosted identity authorizes writes; anonymous GitHub access only authorizes reads. */
export function useGitHubPrIdentity({
  workspaceId,
  sessionId,
  repoFullName,
  prNumber,
  enabled = true,
  visible = true,
}: {
  workspaceId?: string | null;
  sessionId?: string;
  repoFullName?: string | null;
  prNumber?: number | null;
  enabled?: boolean;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuthenticatedConvex();
  const requestedRepoFullName = repoFullName?.trim() || null;
  const hasInputs = Boolean(
    enabled && workspaceId && requestedRepoFullName && prNumber && prNumber > 0
  );
  const serverVersions = useCloudQuery(
    cloudOperations.github.getPrCacheVersions,
    hasInputs
      ? {
          workspaceId: workspaceId!,
          repoFullName: requestedRepoFullName!,
          prNumber: prNumber!,
          ...(sessionId ? { sessionId } : {}),
        }
      : 'skip'
  );
  const resolveLegacy = useCloudMutation(cloudOperations.github.resolveLegacyPrRepositoryIdentity);
  const linkedRepositoryId = serverVersions?.repositoryId;
  const ready =
    hasInputs &&
    !serverVersions?.identityPending &&
    (!sessionId ||
      (typeof linkedRepositoryId === 'number' && Boolean(serverVersions?.repoFullName)));
  const unresolved = hasInputs && !ready && serverVersions !== undefined;
  const key = JSON.stringify([workspaceId, sessionId, requestedRepoFullName, prNumber]);
  const [publicRepository, setPublicRepository] = useState<{ key: string; id: number } | null>(
    null
  );
  const [publicAttempt, setPublicAttempt] = useState(0);
  useEffect(() => {
    if (!unresolved || !visible || !requestedRepoFullName) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        // A name is enough to browse public content, never to acquire credentials.
        // Refuse redirects so a renamed/replaced association cannot silently retarget.
        if (!/^[\w.-]+\/[\w.-]+$/.test(requestedRepoFullName)) return;
        const response = await fetch(`https://api.github.com/repos/${requestedRepoFullName}`, {
          headers: { Accept: 'application/vnd.github+json' },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) return;
        const repository = (await response.json()) as {
          id?: number;
          private?: boolean;
          full_name?: string;
        };
        if (
          repository.private !== false ||
          !Number.isSafeInteger(repository.id) ||
          repository.id! <= 0 ||
          repository.full_name?.toLowerCase() !== requestedRepoFullName.toLowerCase() ||
          (linkedRepositoryId !== undefined && repository.id !== linkedRepositoryId)
        )
          return;
        if (!controller.signal.aborted) setPublicRepository({ key, id: repository.id! });
      } catch {
        // Private, missing, rate-limited and unreachable repositories retain the identity error.
      }
    })();
    return () => controller.abort();
  }, [key, linkedRepositoryId, publicAttempt, requestedRepoFullName, unresolved, visible]);
  const publicRead =
    unresolved &&
    publicRepository?.key === key &&
    (linkedRepositoryId === undefined || publicRepository.id === linkedRepositoryId);
  const repositoryId = publicRead ? publicRepository.id : linkedRepositoryId;
  const runRead = useCallback<typeof withGitHubTokenRetry>(
    (workspace, repo, read, id) => {
      if (publicRead) return read('');
      if (!ready)
        return Promise.reject(
          new Error('GitHub repository identity is not ready; no operation was attempted.')
        );
      return withGitHubTokenRetry(workspace, repo, read, id);
    },
    [publicRead, ready]
  );
  const runOperation = useCallback<typeof withGitHubOperationTokenRetry>(
    (workspace, repo, operation, run, id) => {
      if (operation === 'read' && publicRead) return run('');
      if (!ready)
        return Promise.reject(
          new Error('GitHub repository identity is not ready; no operation was attempted.')
        );
      return withGitHubOperationTokenRetry(workspace, repo, operation, run, id);
    },
    [publicRead, ready]
  );
  const retry = useCallback(
    async (retryPublic = true) => {
      if (retryPublic) setPublicAttempt((attempt) => attempt + 1);
      if (!hasInputs || !sessionId || !isAuthenticated) return;
      try {
        await resolveLegacy({
          workspaceId: workspaceId!,
          repoFullName: requestedRepoFullName!,
          prNumber: prNumber!,
          sessionId,
        });
      } catch {
        // Keep the explanatory blocked state and its Retry control. In particular,
        // a deployment gap or network failure must never release the identity gate.
      }
    },
    [
      hasInputs,
      isAuthenticated,
      prNumber,
      requestedRepoFullName,
      resolveLegacy,
      sessionId,
      workspaceId,
    ]
  );
  const attemptedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !unresolved || !isAuthenticated || !sessionId || attemptedKey.current === key)
      return;
    attemptedKey.current = key;
    // The query subscription publishes repaired identity. Failure remains a
    // visible, retryable blocked state, never permission to fall back to a name.
    void retry(false).catch(() => {});
  }, [isAuthenticated, key, retry, sessionId, unresolved, visible]);
  const error = useMemo(
    () =>
      unresolved && !publicRead
        ? new Error(
            t(
              'sessions.prTab.repositoryIdentityUnresolved',
              'Cannot verify this session’s repository identity. GitHub operations are paused. Ask a workspace administrator to check Settings > GitHub, the active GitHub App installation, repository access and the original PR association. Background association stops after 6 failed attempts; after fixing access, restart this machine’s Lody background agent and retry. Signing in again does not repair a missing repository link.'
            )
          )
        : null,
    [t, unresolved, publicRead]
  );
  return {
    serverVersions,
    repositoryId,
    repoFullName: publicRead
      ? requestedRepoFullName
      : (serverVersions?.repoFullName ?? requestedRepoFullName),
    ready,
    readReady: ready || publicRead,
    publicRead,
    runRead,
    runOperation,
    error,
    retry,
  };
}
