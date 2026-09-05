import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import {
  AlertCircle,
  Boxes,
  Info,
  Loader2,
  PackageOpen,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import { DEFAULT_PROJECT_SKILL_DIR, type ProjectSkill, type ProjectSkillScope } from '@lody/shared';
import { SkillDetailDialog } from './skill-detail';
import { SkillScopeBadge, SkillSymlinkBadge, SkillVersionBadge } from './skill-badges';
import {
  useProjectSkills,
  type ProjectSkillResolvedGroup,
  type ProjectSkillsSource,
  type ProjectSkillsStatus,
} from '@/hooks/use-project-skills';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { cn } from '@/lib/utils';

/**
 * Desktop "Skills" sub-tab for a project detail pane (local + GitHub).
 *
 * Container: resolves the SWR skills state for the given source and hands a
 * pure view the resolved, sorted groups. Splitting the view out keeps the
 * Storybook stories driving every visual state without standing up the
 * IndexedDB cache / RPC / GitHub token machinery the hook needs.
 *
 * Read-only by decision I in `docs/project-skills.md` — there's no skill
 * detail surface; each row only renders name / description / version / author.
 */
export function ProjectSkillsTab({ source }: { source: ProjectSkillsSource | null }) {
  const { status, groups, error, stale, fetchedAt, refresh } = useProjectSkills(source);
  return (
    <ProjectSkillsView
      status={status}
      groups={groups}
      error={error}
      stale={stale}
      fetchedAt={fetchedAt}
      onRefresh={refresh}
    />
  );
}

export type ProjectSkillsViewProps = {
  status: ProjectSkillsStatus;
  groups: ProjectSkillResolvedGroup[];
  error?: string;
  stale: boolean;
  fetchedAt?: number;
  onRefresh: () => void;
};

export function ProjectSkillsView({
  status,
  groups,
  error,
  stale,
  fetchedAt,
  onRefresh,
}: ProjectSkillsViewProps) {
  const { t, i18n } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const locale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const totalSkills = useMemo(
    () => groups.reduce((sum, group) => sum + group.skills.length, 0),
    [groups]
  );
  const filteredGroups = useMemo(() => {
    if (!normalizedSearchQuery) return groups;

    return groups.flatMap((group) => {
      const skills = group.skills.filter((skill) =>
        [skill.name, skill.description, skill.author, skill.relativePath].some((value) =>
          value?.toLowerCase().includes(normalizedSearchQuery)
        )
      );
      return skills.length > 0 ? [{ ...group, skills }] : [];
    });
  }, [groups, normalizedSearchQuery]);
  const hasMatches = filteredGroups.some((group) => group.skills.length > 0);

  const isInitialLoading = status === 'loading' && groups.length === 0;
  const isRefreshing = status === 'refreshing';

  if (isInitialLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 bg-muted/15 px-3 py-10 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('workspace.projects.skills.loading', 'Loading skills')}
      </div>
    );
  }

  if (groups.length === 0) {
    if (status === 'error') {
      return (
        <SkillsEmptyShell
          icon={<AlertCircle className="h-4 w-4 text-destructive" />}
          title={t('workspace.projects.skills.errorTitle', "Couldn't load skills")}
          body={error}
          action={
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onRefresh}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('workspace.projects.skills.retry', 'Retry')}
            </Button>
          }
        />
      );
    }
    return (
      <SkillsEmptyShell
        icon={<PackageOpen className="h-4 w-4 text-muted-foreground" />}
        title={t('workspace.projects.skills.empty', 'No skills found')}
        body={t('workspace.projects.skills.emptyHint', {
          defaultValue:
            'Skills live in {{dir}} and other known skill directories. Add a skill there to see it here.',
          dir: DEFAULT_PROJECT_SKILL_DIR,
        })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {isRefreshing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>{t('workspace.projects.skills.refreshing', 'Refreshing…')}</span>
            </>
          ) : status === 'error' && stale ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-warning" />
              <span className="min-w-0 truncate">
                {t(
                  'workspace.projects.skills.staleNotice',
                  "Couldn't refresh — showing the last cached result."
                )}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate">
              {t('workspace.projects.skills.summary', {
                defaultValue: '{{count}} skills',
                count: totalSkills,
              })}
              {typeof fetchedAt === 'number'
                ? ` · ${t('workspace.projects.skills.updatedRelative', {
                    defaultValue: 'updated {{relative}}',
                    relative: formatDistanceToNow(new Date(fetchedAt), {
                      addSuffix: true,
                      locale,
                    }),
                  })}`
                : ''}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          {t('workspace.projects.skills.refresh', 'Refresh')}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          aria-label={t('workspace.projects.skills.searchLabel', 'Search skills')}
          placeholder={t(
            'workspace.projects.skills.searchPlaceholder',
            'Search by name, description, author, or path'
          )}
          className="bg-input-field pl-9"
        />
      </div>

      {normalizedSearchQuery && !hasMatches ? (
        <SkillsEmptyShell
          icon={<Search className="h-4 w-4 text-muted-foreground" />}
          title={t('workspace.projects.skills.noSearchResults', 'No matching skills')}
          body={t(
            'workspace.projects.skills.noSearchResultsHint',
            'Try another name, description, author, or path.'
          )}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filteredGroups.map((group) => (
            <SkillGroupCard key={`${group.scope}:${group.dir}`} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillGroupCard({ group }: { group: ProjectSkillResolvedGroup }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-md border border-tab-border">
      <div className="flex items-center justify-between gap-2 border-b border-tab-border bg-tab-bar px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 truncate font-mono text-xs text-foreground">{group.dir}</code>
          <SkillScopeBadge scope={group.scope} className="shrink-0" />
        </div>
      </div>

      {group.error ? (
        <div className="flex items-start gap-2 border-b border-tab-border bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{group.error}</span>
        </div>
      ) : null}

      <div className="divide-y divide-tab-border">
        {group.skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} scope={group.scope} />
        ))}
      </div>

      {group.skippedExternalSymlinks ? (
        <div className="border-t border-tab-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {t('workspace.projects.skills.skippedSymlinks', {
            defaultValue: '{{count}} external symlinks skipped',
            count: group.skippedExternalSymlinks,
          })}
        </div>
      ) : null}
    </div>
  );
}

function SkillRow({ skill, scope }: { skill: ProjectSkill; scope: ProjectSkillScope }) {
  const { t } = useTranslation();
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
          {skill.version ? <SkillVersionBadge version={skill.version} size="sm" /> : null}
          {skill.isSymlink ? (
            <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} size="sm" />
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          aria-label={t('workspace.projects.skills.viewDetails', 'View details')}
          title={t('workspace.projects.skills.viewDetails', 'View details')}
          className="-my-1 -mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <Info className="h-4 w-4" />
        </button>
      </div>
      {skill.description ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
      ) : null}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {skill.author ? (
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            {skill.author}
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono">{skill.relativePath}</span>
      </div>
      <SkillDetailDialog
        skill={skill}
        scope={scope}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

function SkillsEmptyShell({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-4 py-10 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60">
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body ? <p className="max-w-sm text-xs text-muted-foreground">{body}</p> : null}
      {action}
    </div>
  );
}
