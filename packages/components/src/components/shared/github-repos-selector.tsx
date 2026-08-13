import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Github } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  currentWorkspaceIdAtom,
  workspaceReposCacheAtomFamily,
  setWorkspaceReposCacheAtom,
} from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { OptionSelector } from './option-selector';
import { useCloudQuery } from '@lody/platform/react';

const CONNECT_GIT_REPO_OPTION_VALUE = '__connect_git_repo__';

interface GitHubReposSelectorProps {
  value?: string;
  onChange: (repo?: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  tone?: 'light' | 'dark';
  latestMessageAtByRepo?: ReadonlyMap<string, number>;
  autoSelectSingle?: boolean; // 是否在只有一个仓库时自动选中
  onConnectGitRepo?: () => void;
}

/**
 * GitHub 仓库选择器（单选）
 */
export function GitHubReposSelector({
  value,
  onChange,
  placeholder,
  className,
  disabled = false,
  tone = 'light',
  latestMessageAtByRepo,
  autoSelectSingle = false,
  onConnectGitRepo,
}: GitHubReposSelectorProps) {
  const { t } = useTranslation();
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);

  // Get cached repositories first (instant display)
  const cachedRepositories = useAtomValue(workspaceReposCacheAtomFamily(currentWorkspaceId));
  const setCacheAtom = useSetAtom(setWorkspaceReposCacheAtom);

  // Fetch fresh data from server
  const freshRepositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    currentWorkspaceId ? { workspaceId: currentWorkspaceId } : 'skip'
  );

  // Update cache when fresh data arrives
  useEffect(() => {
    if (freshRepositories && currentWorkspaceId) {
      setCacheAtom({
        workspaceId: currentWorkspaceId,
        repositories: freshRepositories.map((repo) => ({
          fullName: repo.fullName,
          description: null, // Description not available from API
        })),
      });
    }
  }, [freshRepositories, currentWorkspaceId, setCacheAtom]);

  // Use fresh data if available, otherwise fall back to cache
  const repositories = freshRepositories ?? cachedRepositories;
  const sortedRepositories = useMemo(() => {
    const items = [...(repositories ?? [])];
    if (!latestMessageAtByRepo) {
      return items;
    }
    return items.sort((left, right) => {
      const leftTs = latestMessageAtByRepo.get(left.fullName);
      const rightTs = latestMessageAtByRepo.get(right.fullName);
      if (leftTs !== undefined && rightTs !== undefined && leftTs !== rightTs) {
        return rightTs - leftTs;
      }
      if (leftTs !== undefined && rightTs === undefined) return -1;
      if (leftTs === undefined && rightTs !== undefined) return 1;
      return left.fullName.localeCompare(right.fullName);
    });
  }, [latestMessageAtByRepo, repositories]);

  useEffect(() => {
    if (autoSelectSingle && !hasAutoSelected && sortedRepositories.length === 1 && !value) {
      const onlyRepository = sortedRepositories[0];
      if (!onlyRepository) return;
      onChange(onlyRepository.fullName);
      setHasAutoSelected(true);
    }
  }, [sortedRepositories, value, onChange, autoSelectSingle, hasAutoSelected]);

  const repoOptions = useMemo(
    () =>
      [
        ...sortedRepositories.map((repo) => ({
          value: repo.fullName,
          label: repo.fullName,
          description: 'description' in repo ? (repo.description ?? undefined) : undefined,
          startContent: <Github className="h-4 w-4 shrink-0 opacity-70" />,
        })),
        ...(onConnectGitRepo && repositories?.length === 0
          ? [
              {
                value: CONNECT_GIT_REPO_OPTION_VALUE,
                label: t('repos.connect', { defaultValue: 'Connect GitHub repositories' }),
                description: t('repos.connectHint', {
                  defaultValue: 'Go to Settings → Integrations',
                }),
                startContent: <ArrowUpRight className="h-4 w-4 shrink-0 opacity-70" />,
              },
            ]
          : []),
      ] satisfies Array<{
        value: string;
        label: string;
        description?: string;
        startContent: React.JSX.Element;
      }>,
    [onConnectGitRepo, repositories?.length, sortedRepositories, t]
  );

  return (
    <OptionSelector
      value={value}
      options={repoOptions}
      onSelect={(option) => {
        if (option.value === CONNECT_GIT_REPO_OPTION_VALUE) {
          onConnectGitRepo?.();
          return;
        }
        if (option.value === value) {
          onChange(undefined);
          return;
        }
        onChange(option.value);
      }}
      placeholder={placeholder || t('chat.repoPlaceholder', { defaultValue: 'Select repository' })}
      placeholderIcon={Github}
      tone={tone}
      className={cn(className)}
      // Nothing to pick (no repos, and no "Connect repositories" affordance) → keep the
      // button disabled rather than opening an empty dropdown / jumping away.
      disabled={disabled || repoOptions.length === 0}
      searchable={sortedRepositories.length > 6}
      autoFocusSearch={false}
      searchPlaceholder={t('repos.search', { defaultValue: 'Search repositories' })}
      emptyText={t('repos.none', { defaultValue: 'No repositories found' })}
      contentClassName="min-w-[16rem] max-w-[min(28rem,calc(100vw-2rem))] p-1"
      renderOption={(option) => (
        <>
          {option.startContent}
          <div className="flex min-w-0 flex-col">
            <span className="whitespace-normal break-words leading-snug">{option.label}</span>
            {option.description && (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {option.description}
              </span>
            )}
          </div>
        </>
      )}
    />
  );
}

/**
 * GitHub 仓库展示徽章
 */
export function GitHubRepoBadge({ repo, className }: { repo?: string; className?: string }) {
  if (!repo) return null;

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      <Badge variant="secondary" className="gap-1 text-xs">
        <Github className="h-3 w-3" />
        {repo}
      </Badge>
    </div>
  );
}
