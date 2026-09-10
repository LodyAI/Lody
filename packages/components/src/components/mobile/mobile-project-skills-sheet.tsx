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
  Loader2,
  PackageOpen,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import { DEFAULT_PROJECT_SKILL_DIR, type ProjectSkill, type ProjectSkillScope } from '@lody/shared';
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
import { cn } from '@/lib/utils';

type SelectedSkill = { skill: ProjectSkill; scope: ProjectSkillScope };

export type MobileProjectSkillsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ProjectSkillsSource | null;
};

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
      <DrawerContent className={cn('h-auto! max-h-[88dvh]! rounded-t-2xl border-border/60')}>
        <div className="flex max-h-full min-h-0 flex-col">
          <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
            {detail ? (
              <button
                type="button"
                onClick={() => setDetail(null)}
                aria-label={t('common.back', 'Back')}
                className="absolute left-2 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
              </button>
            ) : null}
            <DrawerTitle className="mx-auto max-w-[68%] truncate text-[0.95rem] font-semibold tracking-tight">
              {detail ? detail.skill.name : title}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                className={cn(
                  'absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription className="sr-only">
            {detail ? detail.skill.name : title}
          </DrawerDescription>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-y-auto',
                'pb-[calc(16px+max(0px,var(--safe-area-bottom,0px)))]'
              )}
            >
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
                  className="absolute inset-0 z-10 flex flex-col bg-background"
                >
                  <div className="scrollbar-pro flex-1 overflow-y-auto px-4 pb-[calc(16px+max(0px,var(--safe-area-bottom,0px)))] pt-1">
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
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Boxes className="h-[1.05rem] w-[1.05rem]" />
              </div>
              <span className="truncate text-[0.95rem] font-medium leading-tight">
                {t('workspace.projects.skills.rowLabel', 'Project skills')}
              </span>
            </div>
          }
          onClick={() => setOpen(true)}
          trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
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
      <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workspace.projects.skills.loading', 'Loading skills')}
      </div>
    );
  }

  if (groups.length === 0) {
    if (status === 'error') {
      return (
        <MobileSkillsEmpty
          icon={<AlertCircle className="h-7 w-7 text-destructive/70" strokeWidth={1.6} />}
          title={t('workspace.projects.skills.errorTitle', "Couldn't load skills")}
          body={error}
          onRetry={onRefresh}
          retryLabel={t('workspace.projects.skills.retry', 'Retry')}
        />
      );
    }
    return (
      <MobileSkillsEmpty
        icon={<PackageOpen className="h-7 w-7 text-muted-foreground/70" strokeWidth={1.6} />}
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
    <div className="pb-3">
      <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[0.78rem] text-muted-foreground">
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
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={t('workspace.projects.skills.refresh', 'Refresh')}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-50'
          )}
        >
          <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
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
    <section className="mt-4 first:mt-2">
      <header className="flex items-center justify-between gap-2 px-5 pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 truncate font-mono text-[0.72rem] text-muted-foreground">
            {group.dir}
          </code>
          <SkillScopeBadge scope={group.scope} size="sm" className="shrink-0" />
        </div>
      </header>

      <div className="mx-3 overflow-hidden rounded-2xl border border-border/40 bg-card">
        {group.error ? (
          <div className="flex items-start gap-2 px-4 py-3 text-[0.78rem] text-destructive">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{group.error}</span>
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
          <div className="border-t border-border/40 px-4 py-2 text-[0.72rem] text-muted-foreground">
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
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="truncate text-[0.95rem] font-medium leading-tight text-foreground">
        {skill.name}
      </span>
      {skill.version ? <SkillVersionBadge version={skill.version} size="sm" /> : null}
      {skill.isSymlink ? <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} size="sm" /> : null}
    </div>
  );
}

function SkillHelper({ skill }: { skill: ProjectSkill }) {
  return (
    <div className="flex flex-col gap-0.5">
      {skill.description ? (
        <span className="line-clamp-2 text-[0.78rem] leading-snug text-muted-foreground">
          {skill.description}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.72rem] text-muted-foreground/80">
        {skill.author ? (
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            {skill.author}
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono">{skill.relativePath}</span>
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
    <div className="mx-3 mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/40 bg-card px-4 py-12 text-center">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body ? <p className="max-w-xs text-xs text-muted-foreground">{body}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors active:bg-muted/50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
