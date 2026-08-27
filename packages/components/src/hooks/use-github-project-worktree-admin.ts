import { useCallback, useMemo, useState } from 'react';
import { useCloudMutation } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { WorktreeCleanupScriptConfig, WorktreeSetupScriptConfig } from '@lody/shared';
import {
  canRunAuthedWorkspaceQuery,
  isAuthedWorkspaceQueryLoading,
} from '@/lib/authed-convex-query';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';
import { useConvexErrorMessage } from './use-convex-error-message';
import type { SettingsWorkspaceRepoWithStatus } from '@/components/settings/settings-data-cache';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

/* Self-contained backing store for the mobile GitHub-project Settings tab.
   The desktop `/settings/projects` page reads the same repos through
   `SettingsDataCacheProvider`, but that provider only wraps the settings
   route — the mobile project screen lives under chat-landing, so this hook
   queries `listWorkspaceReposWithStatus` directly (guarded the same way as
   `useVisibleLocalProjects`) and owns the per-repo save state. */

const EMPTY_WORKTREE_CONFIG: WorktreeSetupScriptConfig = { scripts: {} };

export type GithubProjectWorktreeRow = {
  repoFullName: string;
  name: string;
  private: boolean;
  worktreeSetup: WorktreeSetupScriptConfig;
  worktreeCleanup: WorktreeCleanupScriptConfig;
  isWorktreeSetupSaving: boolean;
  worktreeSetupError: string | null;
  isWorktreeCleanupSaving: boolean;
  worktreeCleanupError: string | null;
};

export type GithubProjectWorktreeAdmin = {
  rowByRepoFullName: Map<string, GithubProjectWorktreeRow>;
  isLoading: boolean;
  onWorktreeSetupChange: (repoFullName: string, config: WorktreeSetupScriptConfig) => Promise<void>;
  onWorktreeCleanupChange: (
    repoFullName: string,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
};

export function useGithubProjectWorktreeSaves() {
  const { workspaceId } = useResolvedWorkspaceScope();
  const setRepoWorktreeSetup = useCloudMutation(cloudOperations.github.setRepoWorktreeSetup);
  const setRepoWorktreeCleanup = useCloudMutation(cloudOperations.github.setRepoWorktreeCleanup);
  const getConvexErrorMessage = useConvexErrorMessage();

  const [setupSavingByKey, setSetupSavingByKey] = useState<Record<string, boolean>>({});
  const [setupErrorByKey, setSetupErrorByKey] = useState<Record<string, string>>({});
  const [cleanupSavingByKey, setCleanupSavingByKey] = useState<Record<string, boolean>>({});
  const [cleanupErrorByKey, setCleanupErrorByKey] = useState<Record<string, string>>({});

  const save = useCallback(
    async (phase: 'setup' | 'cleanup', repoFullName: string, config: WorktreeSetupScriptConfig) => {
      const setSavingByKey = phase === 'setup' ? setSetupSavingByKey : setCleanupSavingByKey;
      const setErrorByKey = phase === 'setup' ? setSetupErrorByKey : setCleanupErrorByKey;
      if (!workspaceId) {
        setErrorByKey((current) => ({
          ...current,
          [repoFullName]: 'Workspace is not ready.',
        }));
        return;
      }

      setSavingByKey((current) => ({ ...current, [repoFullName]: true }));
      setErrorByKey((current) => {
        const { [repoFullName]: _, ...rest } = current;
        return rest;
      });

      try {
        if (phase === 'setup') {
          await setRepoWorktreeSetup({ workspaceId, repoFullName, config });
        } else {
          await setRepoWorktreeCleanup({ workspaceId, repoFullName, config });
        }
      } catch (error) {
        setErrorByKey((current) => ({
          ...current,
          [repoFullName]: getConvexErrorMessage(error, 'Failed to update worktree settings.'),
        }));
      } finally {
        setSavingByKey((current) => {
          const { [repoFullName]: _, ...rest } = current;
          return rest;
        });
      }
    },
    [getConvexErrorMessage, setRepoWorktreeCleanup, setRepoWorktreeSetup, workspaceId]
  );

  const onWorktreeSetupChange = useCallback(
    (repoFullName: string, config: WorktreeSetupScriptConfig) =>
      save('setup', repoFullName, config),
    [save]
  );
  const onWorktreeCleanupChange = useCallback(
    (repoFullName: string, config: WorktreeCleanupScriptConfig) =>
      save('cleanup', repoFullName, config),
    [save]
  );

  return {
    setupSavingByKey,
    setupErrorByKey,
    cleanupSavingByKey,
    cleanupErrorByKey,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
  };
}

export function useGithubProjectWorktreeAdmin(): GithubProjectWorktreeAdmin {
  const { workspaceId } = useResolvedWorkspaceScope();
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  const canQuery = canRunAuthedWorkspaceQuery(workspaceId, isAuthenticated);
  const repos = useCloudQuery(
    cloudOperations.github.listWorkspaceReposWithStatus,
    workspaceId ? { workspaceId } : 'skip'
  ) as SettingsWorkspaceRepoWithStatus[] | undefined | null;

  const {
    setupSavingByKey,
    setupErrorByKey,
    cleanupSavingByKey,
    cleanupErrorByKey,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
  } = useGithubProjectWorktreeSaves();

  const rowByRepoFullName = useMemo(() => {
    const map = new Map<string, GithubProjectWorktreeRow>();
    for (const repo of repos ?? []) {
      map.set(repo.repoFullName, {
        repoFullName: repo.repoFullName,
        name: repo.name,
        private: repo.private,
        worktreeSetup: repo.worktreeSetup ?? EMPTY_WORKTREE_CONFIG,
        worktreeCleanup: repo.worktreeCleanup ?? EMPTY_WORKTREE_CONFIG,
        isWorktreeSetupSaving: setupSavingByKey[repo.repoFullName] === true,
        worktreeSetupError: setupErrorByKey[repo.repoFullName] ?? null,
        isWorktreeCleanupSaving: cleanupSavingByKey[repo.repoFullName] === true,
        worktreeCleanupError: cleanupErrorByKey[repo.repoFullName] ?? null,
      });
    }
    return map;
  }, [cleanupErrorByKey, cleanupSavingByKey, repos, setupErrorByKey, setupSavingByKey]);

  const isLoading = isAuthedWorkspaceQueryLoading({
    workspaceId,
    isConvexAuthLoading,
    canQuery,
    queryResult: repos ?? undefined,
  });

  return { rowByRepoFullName, isLoading, onWorktreeSetupChange, onWorktreeCleanupChange };
}
