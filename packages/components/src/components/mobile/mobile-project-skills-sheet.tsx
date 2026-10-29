import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import {
  AlertCircle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  PackageOpen,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { DEFAULT_PROJECT_SKILL_DIR, type ProjectSkill, type ProjectSkillScope } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import {
  useProjectSkills,
  type ProjectSkillResolvedGroup,
  type ProjectSkillsSource,
  type ProjectSkillsStatus,
} from '@/hooks/use-project-skills';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import {
  MobileSettingsRow,
  MobileSettingsRowGroup,
  MobileSettingsSection,
} from '@/components/mobile/mobile-settings-row';
import { SkillDetailContent } from '@/components/settings/skill-detail';
import {
  SkillScopeBadge,
  SkillSymlinkBadge,
  SkillVersionBadge,
} from '@/components/settings/skill-badges';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import { withClassName } from '@/lib/stylex';
import { sheetSurface } from './sheet-surface';
import { mobileSurface } from './surface';

type SelectedSkill = { skill: ProjectSkill; scope: ProjectSkillScope };

export type MobileProjectSkillsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ProjectSkillsSource | null;
};

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  spinner: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
  },
  spinnerSmall: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
  /** The title, clipped so a long name cannot push the chips away. */
  title: { maxWidth: '68%' },
  /** The pane the skill detail slides over. */
  pane: {
    position: 'relative',
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  /** The list of skills. */
  list: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflowY: 'auto',
    paddingBottom: 'calc(16px + max(0px, var(--safe-area-bottom, 0px)))',
  },
  /** The detail slide-over. */
  detail: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: themeColors.background,
  },
  /** The detail's scrolling body. */
  detailBody: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[1],
    paddingBottom: 'calc(16px + max(0px, var(--safe-area-bottom, 0px)))',
  },

  /** The mark in the empty state. */
  emptyIcon: {
    width: '1.75rem',
    height: '1.75rem',
  },
  emptyIconDanger: { color: 'hsl(var(--destructive) / 0.7)' },
  emptyIconMuted: { color: 'hsl(var(--muted-foreground) / 0.7)' },
  /** The loading state. */
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[5],
    paddingTop: themeSpace[12],
    paddingBottom: themeSpace[12],
    fontSize: '0.875rem',
    lineHeight: 'calc(1.25 / 0.875)',
    color: themeColors.mutedForeground,
  },
  /** The empty / error state. */
  empty: {
    display: 'flex',
    marginInline: themeSpace[3],
    marginTop: themeSpace[3],
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[12],
    paddingBottom: themeSpace[12],
    textAlign: 'center',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
  },
  emptyTitle: {
    fontSize: '0.875rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  emptyBody: {
    maxWidth: '20rem',
    fontSize: '0.75rem',
    lineHeight: 'calc(1 / 0.75)',
    color: themeColors.mutedForeground,
  },
  /** The retry action of the error state. */
  retry: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    marginTop: themeSpace[1],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[1.5],
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    fontSize: '0.75rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.5)' },
    ...TRANSITION_COLORS,
  },

  /** The list's own bottom padding. */
  listBody: { paddingBottom: themeSpace[3] },
  /** The mark that says the list is stale. */
  staleGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.statusWarning,
  },
  /** A label clipped to its column. */
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The header of the skill list. */
  listHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
    paddingInline: themeSpace[5],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[1],
  },
  /** The summary line. */
  summary: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '0.78rem',
    color: themeColors.mutedForeground,
  },
  /** The refresh action in the header. */
  refresh: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[8],
    height: themeSpace[8],
    borderRadius: themeRadius.full,
    color: themeColors.mutedForeground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.5)' },
    opacity: { default: 1, ':disabled': 0.5 },
    ...TRANSITION_COLORS,
  },

  /** A group of skills. */
  group: {
    marginTop: themeSpace[4],
    ':first-child': { marginTop: themeSpace[2] },
  },
  /** The group's heading. */
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
    paddingInline: themeSpace[5],
    paddingBottom: themeSpace[1.5],
  },
  /** The group's directory. */
  groupHead: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  groupGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  groupDir: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },
  /** The group's card. */
  groupCard: {
    marginInline: themeSpace[3],
    overflow: 'hidden',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
  },
  /** The group's error line. */
  groupError: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
    paddingBottom: themeSpace[3],
    fontSize: '0.78rem',
    color: themeColors.destructive,
  },
  groupErrorGlyph: {
    marginTop: '1px',
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  groupErrorText: {
    minWidth: 0,
    wordBreak: 'break-word',
  },
  /** The note about skipped symlinks. */
  groupSkipped: {
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },

  /** A skill's name and its badges. */
  skillLabel: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[2],
    rowGap: themeSpace[1],
  },
  skillName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
    color: themeColors.foreground,
  },
  /** A skill's helper lines. */
  skillHelper: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
  },
  skillDescription: {
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    fontSize: '0.78rem',
    lineHeight: 1.375,
    color: themeColors.mutedForeground,
  },
  skillMeta: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[2.5],
    rowGap: themeSpace[0.5],
    fontSize: '0.72rem',
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  skillAuthor: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  skillAuthorGlyph: {
    width: themeSpace[3],
    height: themeSpace[3],
  },
  skillPath: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
});

/**
 * Second-level bottom sheet that lists a project's skills (mobile).
 *
 * Mirrors `MobileWorktreeConfigSheet` / `MobileAcpHistorySheet`: the project
 * Settings tab shows a single "Skills" row, and tapping it opens this sheet.
 * We use a bottom sheet rather than an in-tab drill page so the project
 * screen's own back chip stays the sole "leave here" affordance — the same
 * reason the worktree + ACP drill-ins are sheets (see this dir's AGENTS.md).
 *
 * Container/body split keeps Storybook driving every visual state without the
 * IndexedDB cache / RPC / GitHub token machinery the hook needs.
 */
export function MobileProjectSkillsSheet({
  open,
  onOpenChange,
  source,
}: MobileProjectSkillsSheetProps) {
  const { t } = useTranslation();
  /* Only run the SWR hook while the sheet is open so a project with many
     rows doesn't kick off a scan/fetch per project until the user asks. */
  const activeSource = open ? source : null;
  const { status, groups, error, stale, fetchedAt, refresh } = useProjectSkills(activeSource);
  const title = t('workspace.projects.skills.sheetTitle', 'Skills');
  /* The skill detail drills in as an in-sheet slide-over (not a stacked drawer)
     so the sheet's own close chip stays the single dismiss affordance; the
     header swaps to a back chevron + the skill name while it is open. */
  const [detail, setDetail] = useState<SelectedSkill | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setDetail(null);
    }
    onOpenChange(next);
  };

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent className="h-auto! max-h-[88dvh]! rounded-t-2xl border-border/60">
        <div {...stylex.props(sheetSurface.columnAuto)}>
          <header {...stylex.props(sheetSurface.header, sheetSurface.headerShrink)}>
            {detail ? (
              <button
                type="button"
                onClick={() => setDetail(null)}
                aria-label={t('common.back', 'Back')}
                {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonLeftTight)}
              >
                <ChevronLeft
                  {...stylex.props(sheetSurface.glyph20)}
                  aria-hidden="true"
                  strokeWidth={1.8}
                />
              </button>
            ) : null}
            <DrawerTitle
              {...stylex.props(sheetSurface.title, sheetSurface.titleCentered, styles.title)}
            >
              {detail ? detail.skill.name : title}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonRight)}
              >
                <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>
            {detail ? detail.skill.name : title}
          </DrawerDescription>

          <div {...stylex.props(styles.pane)}>
            <div {...stylex.props(styles.list)}>
              <MobileProjectSkillsBody
                status={status}
                groups={groups}
                error={error}
                stale={stale}
                fetchedAt={fetchedAt}
                onRefresh={refresh}
                onViewDetail={(skill, scope) => setDetail({ skill, scope })}
              />
            </div>
            <AnimatePresence>
              {detail ? (
                <motion.div
                  key="skill-detail"
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
                  {...stylex.props(styles.detail)}
                >
                  <div {...withClassName(stylex.props(styles.detailBody), 'scrollbar-pro')}>
                    <SkillDetailContent skill={detail.skill} scope={detail.scope} />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The "Skills" section + drill-in row that opens {@link MobileProjectSkillsSheet}.
 * Shared by the local and GitHub mobile project Settings tabs, which differ only
 * in how they build the `source`; everything below it (icon, label, sheet, open
 * state) is identical, so it lives here next to the sheet it launches.
 */
export function MobileProjectSkillsRow({ source }: { source: ProjectSkillsSource | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <MobileSettingsSection title={t('workspace.projects.skills.sectionTitle', 'Skills')}>
        <MobileSettingsRow
          label={
            <div {...stylex.props(mobileSurface.identity)}>
              <div {...stylex.props(mobileSurface.identityTile)}>
                <Boxes {...stylex.props(mobileSurface.identityGlyph)} />
              </div>
              <span
                {...stylex.props(mobileSurface.identityLabel, mobileSurface.identityLabelTight)}
              >
                {t('workspace.projects.skills.rowLabel', 'Project skills')}
              </span>
            </div>
          }
          onClick={() => setOpen(true)}
          trailing={<ChevronRight {...stylex.props(mobileSurface.chevron)} />}
        />
      </MobileSettingsSection>
      <MobileProjectSkillsSheet open={open} onOpenChange={setOpen} source={source} />
    </>
  );
}

export type MobileProjectSkillsBodyProps = {
  status: ProjectSkillsStatus;
  groups: ProjectSkillResolvedGroup[];
  error?: string;
  stale: boolean;
  fetchedAt?: number;
  onRefresh: () => void;
  onViewDetail?: (skill: ProjectSkill, scope: ProjectSkillScope) => void;
};

export function MobileProjectSkillsBody({
  status,
  groups,
  error,
  stale,
  fetchedAt,
  onRefresh,
  onViewDetail,
}: MobileProjectSkillsBodyProps) {
  const { t, i18n } = useTranslation();
  const locale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const totalSkills = useMemo(
    () => groups.reduce((sum, group) => sum + group.skills.length, 0),
    [groups]
  );
  const isInitialLoading = status === 'loading' && groups.length === 0;
  const isRefreshing = status === 'refreshing';

  if (isInitialLoading) {
    return (
      <div {...stylex.props(styles.loading)}>
        <Spinner {...stylex.props(styles.spinner)} />
        {t('workspace.projects.skills.loading', 'Loading skills')}
      </div>
    );
  }

  if (groups.length === 0) {
    if (status === 'error') {
      return (
        <MobileSkillsEmpty
          icon={
            <AlertCircle
              {...stylex.props(styles.emptyIcon, styles.emptyIconDanger)}
              strokeWidth={1.6}
            />
          }
          title={t('workspace.projects.skills.errorTitle', "Couldn't load skills")}
          body={error}
          onRetry={onRefresh}
          retryLabel={t('workspace.projects.skills.retry', 'Retry')}
        />
      );
    }
    return (
      <MobileSkillsEmpty
        icon={
          <PackageOpen
            {...stylex.props(styles.emptyIcon, styles.emptyIconMuted)}
            strokeWidth={1.6}
          />
        }
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
    <div {...stylex.props(styles.listBody)}>
      <div {...stylex.props(styles.listHeader)}>
        <div {...stylex.props(styles.summary)}>
          {isRefreshing ? (
            <>
              <Spinner {...stylex.props(styles.spinnerSmall)} />
              <span>{t('workspace.projects.skills.refreshing', 'Refreshing…')}</span>
            </>
          ) : status === 'error' && stale ? (
            <>
              <AlertCircle {...stylex.props(styles.staleGlyph)} />
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
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={t('workspace.projects.skills.refresh', 'Refresh')}
          {...stylex.props(styles.refresh)}
        >
          <Spinner icon={RefreshCw} spinning={isRefreshing} {...stylex.props(styles.spinner)} />
        </button>
      </div>

      {groups.map((group) => (
        <MobileSkillGroup
          key={`${group.scope}:${group.dir}`}
          group={group}
          onViewDetail={onViewDetail}
        />
      ))}
    </div>
  );
}

function MobileSkillGroup({
  group,
  onViewDetail,
}: {
  group: ProjectSkillResolvedGroup;
  onViewDetail?: (skill: ProjectSkill, scope: ProjectSkillScope) => void;
}) {
  const { t } = useTranslation();
  return (
    <section {...stylex.props(styles.group)}>
      <header {...stylex.props(styles.groupHeader)}>
        <div {...stylex.props(styles.groupHead)}>
          <Boxes {...stylex.props(styles.groupGlyph)} />
          <code {...stylex.props(styles.groupDir)}>{group.dir}</code>
          <SkillScopeBadge scope={group.scope} size="sm" className="shrink-0" />
        </div>
      </header>

      <div {...stylex.props(styles.groupCard)}>
        {group.error ? (
          <div {...stylex.props(styles.groupError)}>
            <AlertCircle {...stylex.props(styles.groupErrorGlyph)} />
            <span {...stylex.props(styles.groupErrorText)}>{group.error}</span>
          </div>
        ) : null}
        <MobileSettingsRowGroup>
          {group.skills.map((skill) => (
            <MobileSettingsRow
              key={skill.id}
              label={<SkillLabel skill={skill} />}
              helper={<SkillHelper skill={skill} />}
              onClick={onViewDetail ? () => onViewDetail(skill, group.scope) : undefined}
            />
          ))}
        </MobileSettingsRowGroup>
        {group.skippedExternalSymlinks ? (
          <div {...stylex.props(styles.groupSkipped)}>
            {t('workspace.projects.skills.skippedSymlinks', {
              defaultValue: '{{count}} external symlinks skipped',
              count: group.skippedExternalSymlinks,
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SkillLabel({ skill }: { skill: ProjectSkill }) {
  return (
    <div {...stylex.props(styles.skillLabel)}>
      <span {...stylex.props(styles.skillName)}>{skill.name}</span>
      {skill.version ? <SkillVersionBadge version={skill.version} size="sm" /> : null}
      {skill.isSymlink ? <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} size="sm" /> : null}
    </div>
  );
}

function SkillHelper({ skill }: { skill: ProjectSkill }) {
  return (
    <div {...stylex.props(styles.skillHelper)}>
      {skill.description ? (
        <span {...stylex.props(styles.skillDescription)}>{skill.description}</span>
      ) : null}
      <span {...stylex.props(styles.skillMeta)}>
        {skill.author ? (
          <span {...stylex.props(styles.skillAuthor)}>
            <User {...stylex.props(styles.skillAuthorGlyph)} />
            {skill.author}
          </span>
        ) : null}
        <span {...stylex.props(styles.skillPath)}>{skill.relativePath}</span>
      </span>
    </div>
  );
}

function MobileSkillsEmpty({
  icon,
  title,
  body,
  onRetry,
  retryLabel,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div {...stylex.props(styles.empty)}>
      {icon}
      <p {...stylex.props(styles.emptyTitle)}>{title}</p>
      {body ? <p {...stylex.props(styles.emptyBody)}>{body}</p> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} {...stylex.props(styles.retry)}>
          <RefreshCw {...stylex.props(sheetSurface.glyph14)} />
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
