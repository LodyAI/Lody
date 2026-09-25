import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { AlertCircle, Boxes, Info, PackageOpen, RefreshCw, Search, User } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@/ui/spinner';
import { DEFAULT_PROJECT_SKILL_DIR, type ProjectSkill, type ProjectSkillScope } from '@lody/shared';
import { SkillDetailDialog } from './skill-detail';
import { SkillScopeBadge, SkillSymlinkBadge, SkillVersionBadge } from './skill-badges';
import {
  useProjectSkills,
  type ProjectSkillResolvedGroup,
  type ProjectSkillsSource,
  type ProjectSkillsStatus,
} from '@/hooks/use-project-skills';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner as LoadingSpinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';

const MONO = 'var(--font-mono, ui-monospace, monospace)';
const TRUNCATE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/*
 * The tab renders inside a settings card, so nothing here is a card: a skill
 * group is a region fill of ruled rows under its own name, and an empty or
 * loading state is copy in the card, not a box drawn inside it.
 */
const styles = stylex.create({
  note: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingBlock: space[8],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  unreachable: { margin: 0, fontSize: '0.75em', color: colors.secondaryLabel },
  view: { display: 'flex', flexDirection: 'column', gap: space[3] },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  truncate: TRUNCATE,
  icon12: { width: '12px', height: '12px', flexShrink: 0 },
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  icon16: { width: '16px', height: '16px', flexShrink: 0 },
  hint: { color: colors.tertiaryLabel },
  warning: { color: colors.warning },
  destructive: { color: colors.destructive },
  groups: { display: 'flex', flexDirection: 'column', gap: space[4] },
  group: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  /** The group's name sits above its rows, never in a band inside them. */
  groupHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[3],
    color: colors.secondaryLabel,
  },
  groupDir: { ...TRUNCATE, fontFamily: MONO, fontSize: '0.75em', color: colors.label },
  /** A block inside the card is the region rung: a fill with no edge. */
  groupBody: {
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  line: { minWidth: 0 },
  lineRuled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  groupError: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    fontSize: '0.75em',
    color: colors.destructive,
  },
  groupErrorIcon: { marginTop: '1px' },
  breakWords: { minWidth: 0, overflowWrap: 'break-word' },
  groupFootnote: {
    paddingInline: space[3],
    paddingBlock: space[1.5],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  row: { paddingInline: space[3], paddingBlock: '10px' },
  rowHead: { display: 'flex', alignItems: 'center', gap: space[2] },
  rowTitle: {
    display: 'flex',
    flexGrow: 1,
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: space[1],
    minWidth: 0,
  },
  rowName: { ...TRUNCATE, fontSize: '0.875em', color: colors.label },
  rowDescription: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    margin: 0,
    marginTop: '2px',
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  rowMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: '2px',
    minWidth: 0,
    marginTop: space[1],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  author: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  path: { ...TRUNCATE, fontFamily: MONO },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[8],
    textAlign: 'center',
  },
  emptyTitle: { margin: 0, fontSize: '0.875em', color: colors.label },
  emptyBody: { margin: 0, maxWidth: '384px', fontSize: '0.75em', color: colors.secondaryLabel },
});
import { capturePickerSearchSelected } from '@/lib/picker-search-analytics';

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
  const postHog = usePostHog();
  // Opening a skill's details is this list's only "selection"; it counts as a
  // search pick only while a term narrows the list.
  const handleSkillOpen = (skillId: string) => {
    if (!normalizedSearchQuery) return;
    const results = filteredGroups.flatMap((group) => group.skills);
    capturePickerSearchSelected(postHog, {
      picker: 'skill',
      term: normalizedSearchQuery,
      rank: results.findIndex((skill) => skill.id === skillId),
      resultCount: results.length,
    });
  };

  const isInitialLoading = status === 'loading' && groups.length === 0;
  const isRefreshing = status === 'refreshing';

  if (isInitialLoading) {
    return (
      <div {...stylex.props(styles.note)}>
        <LoadingSpinner size="small" label={null} />
        {t('workspace.projects.skills.loading', 'Loading skills')}
      </div>
    );
  }

  if (groups.length === 0) {
    if (status === 'error') {
      const unreachable =
        Boolean(error?.includes('machine_rpc_unavailable')) ||
        Boolean(error?.includes('CLI is not accepting RPC'));
      if (unreachable) {
        return (
          <p {...stylex.props(styles.unreachable)}>
            {t(
              'workspace.projects.machineUnreachable',
              'This machine isn’t connected. Worktree setup and skills will load when it comes online.'
            )}
          </p>
        );
      }
      return (
        <SkillsEmptyShell
          icon={<AlertCircle {...stylex.props(styles.icon16, styles.destructive)} />}
          title={t('workspace.projects.skills.errorTitle', "Couldn't load skills")}
          body={error}
          action={
            <Button type="button" variant="secondary" size="small" onClick={onRefresh}>
              <RefreshCw {...stylex.props(styles.icon14)} />
              {t('workspace.projects.skills.retry', 'Retry')}
            </Button>
          }
        />
      );
    }
    return (
      <SkillsEmptyShell
        icon={<PackageOpen {...stylex.props(styles.icon16, styles.hint)} />}
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
    <div {...stylex.props(styles.view)}>
      <div {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.status)}>
          {isRefreshing ? (
            <>
              <LoadingSpinner size="small" label={null} />
              <span>{t('workspace.projects.skills.refreshing', 'Refreshing…')}</span>
            </>
          ) : status === 'error' && stale ? (
            <>
              <AlertCircle {...stylex.props(styles.icon14, styles.warning)} />
              <span {...stylex.props(styles.truncate)}>
                {t(
                  'workspace.projects.skills.staleNotice',
                  "Couldn't refresh — showing the last cached result."
                )}
              </span>
            </>
          ) : (
            <span {...stylex.props(styles.truncate)}>
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
          size="small"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <Spinner icon={RefreshCw} spinning={isRefreshing} {...stylex.props(styles.icon14)} />
          {t('workspace.projects.skills.refresh', 'Refresh')}
        </Button>
      </div>

      <Input
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        aria-label={t('workspace.projects.skills.searchLabel', 'Search skills')}
        placeholder={t(
          'workspace.projects.skills.searchPlaceholder',
          'Search by name, description, author, or path'
        )}
        leading={<Search {...stylex.props(styles.icon16)} />}
      />

      {normalizedSearchQuery && !hasMatches ? (
        <SkillsEmptyShell
          icon={<Search {...stylex.props(styles.icon16, styles.hint)} />}
          title={t('workspace.projects.skills.noSearchResults', 'No matching skills')}
          body={t(
            'workspace.projects.skills.noSearchResultsHint',
            'Try another name, description, author, or path.'
          )}
        />
      ) : (
        <div {...stylex.props(styles.groups)}>
          {filteredGroups.map((group) => (
            <SkillGroupCard
              key={`${group.scope}:${group.dir}`}
              group={group}
              onSkillOpen={handleSkillOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillGroupCard({
  group,
  onSkillOpen,
}: {
  group: ProjectSkillResolvedGroup;
  onSkillOpen?: (skillId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.groupHeading)}>
        <Boxes {...stylex.props(styles.icon14, styles.hint)} />
        <code {...stylex.props(styles.groupDir)}>{group.dir}</code>
        <SkillScopeBadge scope={group.scope} />
      </div>

      <div {...stylex.props(styles.groupBody)}>
        {group.error ? (
          <div {...stylex.props(styles.groupError)}>
            <AlertCircle {...stylex.props(styles.icon14, styles.groupErrorIcon)} />
            <span {...stylex.props(styles.breakWords)}>{group.error}</span>
          </div>
        ) : null}

        {group.skills.map((skill, index) => (
          <div
            key={skill.id}
            {...stylex.props(styles.line, (index > 0 || Boolean(group.error)) && styles.lineRuled)}
          >
            <SkillRow skill={skill} scope={group.scope} onOpen={() => onSkillOpen?.(skill.id)} />
          </div>
        ))}

        {group.skippedExternalSymlinks ? (
          <div {...stylex.props(styles.groupFootnote, styles.lineRuled)}>
            {t('workspace.projects.skills.skippedSymlinks', {
              defaultValue: '{{count}} external symlinks skipped',
              count: group.skippedExternalSymlinks,
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  scope,
  onOpen,
}: {
  skill: ProjectSkill;
  scope: ProjectSkillScope;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowHead)}>
        <div {...stylex.props(styles.rowTitle)}>
          <span {...stylex.props(styles.rowName)}>{skill.name}</span>
          {skill.version ? <SkillVersionBadge version={skill.version} size="sm" /> : null}
          {skill.isSymlink ? (
            <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} size="sm" />
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          onClick={() => {
            setDetailOpen(true);
            onOpen?.();
          }}
          aria-label={t('workspace.projects.skills.viewDetails', 'View details')}
          title={t('workspace.projects.skills.viewDetails', 'View details')}
        >
          <Info {...stylex.props(styles.icon16)} />
        </Button>
      </div>
      {skill.description ? (
        <p {...stylex.props(styles.rowDescription)}>{skill.description}</p>
      ) : null}
      <div {...stylex.props(styles.rowMeta)}>
        {skill.author ? (
          <span {...stylex.props(styles.author)}>
            <User {...stylex.props(styles.icon12, styles.hint)} />
            {skill.author}
          </span>
        ) : null}
        <span {...stylex.props(styles.path)}>{skill.relativePath}</span>
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
    <div {...stylex.props(styles.empty)}>
      {icon}
      <p {...stylex.props(styles.emptyTitle)}>{title}</p>
      {body ? <p {...stylex.props(styles.emptyBody)}>{body}</p> : null}
      {action}
    </div>
  );
}
