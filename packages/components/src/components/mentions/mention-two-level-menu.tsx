import * as React from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceIdAtom } from '@/atoms';
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  MessageSquare,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import { MentionContent, MentionItem, useMentionContext } from '@/ui/mention';
import { useIsMentionMobile } from '@/ui/mention/mention-mobile-content';
import {
  getCategoryNavigateText,
  getMentionViewCandidates,
  selectMentionMenuViewForTrigger,
  type MentionCandidate,
  type MentionCandidateDetail,
  type MentionCategory,
  type MentionIcon,
  type MentionMenuView,
} from '@/components/mentions/mention-registry';
import {
  captureMentionCategoryEnter,
  captureMentionMenuOpen,
  captureMentionSelect,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';

function CandidateIcon({
  icon,
  path,
  className,
}: {
  icon: MentionIcon;
  path?: string;
  className?: string;
}) {
  switch (icon) {
    case 'file':
      return <FileIcon filePath={path ?? ''} className={className} />;
    case 'dir':
      return <FolderIcon folderPath={path ?? ''} className={className} />;
    case 'issue':
      return <CircleDot className={className} />;
    case 'pr':
      return <GitPullRequest className={className} />;
    case 'skill':
      return <Boxes className={className} />;
    case 'command':
      return <Terminal className={className} />;
    case 'session':
      return <MessageSquare className={className} />;
    default:
      return null;
  }
}

const ICON_CLASS = 'h-4 w-4 shrink-0 opacity-70';

function CategoryRow({ category }: { category: MentionCategory }) {
  return (
    <MentionItem
      value={`category:${category.id}`}
      label={category.label}
      navigateText={getCategoryNavigateText(category)}
    >
      <CandidateIcon icon={category.icon} className={ICON_CLASS} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{category.label}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-40" />
    </MentionItem>
  );
}

function CandidateRow({
  candidate,
  onSelect,
}: {
  candidate: MentionCandidate;
  onSelect?: () => void;
}) {
  return (
    <MentionItem
      value={candidate.value}
      label={candidate.label}
      kind={candidate.kind}
      insertText={candidate.insertText}
      navigateText={candidate.navigateText}
      onMentionSelect={onSelect}
    >
      <CandidateIcon icon={candidate.icon} path={candidate.iconPath} className={ICON_CLASS} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'min-w-0 truncate text-sm leading-5',
            candidate.mono && 'font-mono text-[13px]'
          )}
        >
          {candidate.title}
        </span>
        {candidate.subtitle ? (
          <span className="truncate text-xs text-muted-foreground">{candidate.subtitle}</span>
        ) : null}
      </div>
      {candidate.trailing ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {candidate.trailing}
        </span>
      ) : null}
    </MentionItem>
  );
}

/**
 * Desktop side panel for the highlighted candidate. Mobile docks a narrow
 * full-width strip with no hover, so it stays list-only.
 */
function CandidateDetailPane({ detail }: { detail: MentionCandidateDetail }) {
  return (
    <div className="scrollbar-pro max-h-[320px] w-[248px] shrink-0 overflow-y-auto border-l border-border px-3 py-2.5">
      <p className="truncate text-sm font-semibold text-foreground">{detail.title}</p>
      {detail.badges?.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {detail.badges.map((badge) => (
            <span
              key={badge}
              className="rounded-sm border border-border px-1.5 py-px text-[10.5px] text-muted-foreground"
            >
              {badge}
            </span>
          ))}
        </div>
      ) : null}
      {detail.description ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {detail.description}
        </p>
      ) : null}
      {detail.rows?.length ? (
        <dl className="mt-2.5 flex flex-col gap-1 text-[11px]">
          {detail.rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
              <dt className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
                {row.label}
              </dt>
              <dd
                className={cn('min-w-0 break-words text-muted-foreground', row.mono && 'font-mono')}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-[0.04em] text-muted-foreground/70">
      {children}
    </div>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      className={cn(
        'px-2 py-1.5 text-sm',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </div>
  );
}

/** The second level's only chrome: the way back. */
function CategoryBreadcrumb({ showBack, onBack }: { showBack: boolean; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-popover px-2 py-1.5 text-xs text-muted-foreground">
      {showBack ? (
        <button
          type="button"
          className="-ml-1 flex items-center gap-0.5 rounded px-1 py-0.5 hover:text-foreground"
          // Keep focus in the composer: the menu closes the moment it blurs.
          onPointerDown={(event) => event.preventDefault()}
          onClick={onBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('mention.menu.back', 'Back')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Body of the two-level menu. Split out so the level rendering can be exercised
 * without the floating/positioning wrapper.
 */
export function MentionTwoLevelMenuBody({
  view,
  onBack,
  showBack,
  onCandidateSelect,
  detail,
}: {
  view: MentionMenuView;
  onBack: () => void;
  showBack: boolean;
  onCandidateSelect?: (category: MentionCategory, rank: number) => void;
  /** Side panel for the highlighted candidate; omitted on mobile. */
  detail?: MentionCandidateDetail | null;
}) {
  const { t } = useTranslation();
  const list = renderLevel();

  if (!detail) return list;
  return (
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1">{list}</div>
      <CandidateDetailPane detail={detail} />
    </div>
  );

  function renderLevel() {
    if (view.level === 'categories') {
      return (
        <div className="scrollbar-pro max-h-[300px] overflow-y-auto">
          {view.categories.map((category) => (
            <CategoryRow key={category.id} category={category} />
          ))}
        </div>
      );
    }

    if (view.level === 'aggregate') {
      if (view.categories.length === 0 && view.groups.length === 0) {
        return <Message>{t('mention.menu.noResults', 'No results')}</Message>;
      }
      return (
        <div className="scrollbar-pro max-h-[320px] overflow-y-auto">
          {view.categories.map((category) => (
            <CategoryRow key={category.id} category={category} />
          ))}
          {view.groups.map((group) => (
            <React.Fragment key={group.category.id}>
              <GroupLabel>{group.category.label}</GroupLabel>
              {group.candidates.map((candidate, rank) => (
                <CandidateRow
                  key={candidate.value}
                  candidate={candidate}
                  onSelect={() => onCandidateSelect?.(group.category, rank)}
                />
              ))}
            </React.Fragment>
          ))}
        </div>
      );
    }

    const { category, candidates } = view;
    return (
      <>
        <CategoryBreadcrumb showBack={showBack} onBack={onBack} />
        {category.notice ? (
          <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{category.notice}</div>
        ) : null}
        {category.message ? (
          <Message tone={category.status === 'error' ? 'error' : undefined}>
            {category.message}
          </Message>
        ) : candidates.length > 0 ? (
          <div className="scrollbar-pro max-h-[280px] overflow-y-auto">
            {candidates.map((candidate, rank) => (
              <CandidateRow
                key={candidate.value}
                candidate={candidate}
                onSelect={() => onCandidateSelect?.(category, rank)}
              />
            ))}
          </div>
        ) : category.status === 'loading' ? (
          <Message>{t('mention.menu.loading', 'Loading…')}</Message>
        ) : (
          <Message>{t('mention.menu.noResults', 'No results')}</Message>
        )}
      </>
    );
  }
}

/**
 * The single `@` mention menu: a category list, an aggregate search, or one
 * scoped category. Replaces the per-trigger menus; `/` still opens the command
 * category directly through its `directTrigger`.
 */
export function MentionTwoLevelMenu({
  categories,
  surface = 'unknown',
}: {
  categories: MentionCategory[];
  surface?: MentionSurface;
}) {
  const context = useMentionContext('MentionTwoLevelMenu');
  const isMobile = useIsMentionMobile();
  const trigger = context.trigger;
  const search = context.filterStore.search;
  const open = context.open;

  const view = React.useMemo(
    () => (open ? selectMentionMenuViewForTrigger(categories, trigger, search) : null),
    [categories, open, search, trigger]
  );

  // Highlight the first row whenever the level or result set changes, so Enter
  // always has a target. Keyed so typing does not re-highlight on every render.
  const highlightKey =
    view === null
      ? null
      : view.level === 'categories'
        ? `categories:${view.categories.length}`
        : view.level === 'aggregate'
          ? `aggregate:${view.term}:${view.groups.length}`
          : `category:${view.category.id}:${view.term}:${view.candidates.length}`;
  const lastHighlightKeyRef = React.useRef<string | null>(null);
  const { getEnabledItems, onHighlightedItemChange } = context;
  React.useEffect(() => {
    if (highlightKey === null) {
      lastHighlightKeyRef.current = null;
      return;
    }
    if (lastHighlightKeyRef.current === highlightKey) return;
    lastHighlightKeyRef.current = highlightKey;
    const items = getEnabledItems();
    if (!items.length) return;
    requestAnimationFrame(() => {
      const first = getEnabledItems()[0] ?? null;
      if (first) onHighlightedItemChange(first);
    });
  }, [getEnabledItems, highlightKey, onHighlightedItemChange]);

  // The click equivalent of the primitive's Backspace/ArrowLeft contract; mobile
  // has no Backspace habit, so the second level always carries a visible way
  // out. Focus stays in the composer — the menu closes the moment it blurs.
  const { onNavigateBack, inputRef } = context;
  const handleBack = React.useCallback(() => {
    if (onNavigateBack()) inputRef.current?.focus();
  }, [inputRef, onNavigateBack]);

  // Side panel follows the highlight. Falls back to the first candidate so the
  // pane is populated before the highlight effect lands, and stays off mobile
  // where the docked strip is too narrow and there is no hover to preview with.
  const visibleCandidates = React.useMemo(() => getMentionViewCandidates(view), [view]);
  const highlightedValue = context.highlightedItem?.value ?? null;
  const detail = React.useMemo(() => {
    if (isMobile) return null;
    const match =
      visibleCandidates.find((candidate) => candidate.value === highlightedValue) ??
      visibleCandidates[0];
    return match?.detail ?? null;
  }, [highlightedValue, isMobile, visibleCandidates]);

  const postHog = usePostHog();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const analyticsBase = React.useMemo(() => ({ workspaceId, surface }), [surface, workspaceId]);

  // One `menu_open` per open, reset when it closes.
  const menuOpenTrackedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      menuOpenTrackedRef.current = false;
      return;
    }
    if (menuOpenTrackedRef.current) return;
    menuOpenTrackedRef.current = true;
    captureMentionMenuOpen(postHog, analyticsBase, {
      level: view?.level ?? 'none',
      categoryCount: categories.length,
    });
  }, [analyticsBase, categories.length, open, postHog, view?.level]);

  // The first-to-second-level step. Reported from the resolved view rather than
  // the row callback: a navigation item never fires `onMentionSelect`, and this
  // also covers the keyboard route into a category.
  const enteredCategoryRef = React.useRef<string | null>(null);
  const scopedCategoryId = view?.level === 'category' ? view.category.id : null;
  const scopedTermLength = view?.level === 'category' ? view.term.length : 0;
  React.useEffect(() => {
    if (!scopedCategoryId) {
      enteredCategoryRef.current = null;
      return;
    }
    if (enteredCategoryRef.current === scopedCategoryId) return;
    enteredCategoryRef.current = scopedCategoryId;
    captureMentionCategoryEnter(postHog, analyticsBase, {
      category: scopedCategoryId,
      termLength: scopedTermLength,
    });
    // `scopedTermLength` is read at entry only; it must not re-fire on typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsBase, postHog, scopedCategoryId]);

  const handleCandidateSelect = React.useCallback(
    (category: MentionCategory, rank: number) => {
      captureMentionSelect(postHog, analyticsBase, {
        category: category.id,
        level: view?.level ?? 'none',
        rank,
        termLength: search.length,
      });
    },
    [analyticsBase, postHog, search.length, view?.level]
  );

  if (!view) return null;

  // A category reached through its own trigger has no level above it to go back
  // to; only the `@` route shows the way out.
  const showBack = view.level === 'category' && trigger === '@';

  return (
    <MentionContent
      className={cn(
        'max-w-[min(var(--mention-input-width),calc(100vw-2rem))]',
        detail ? 'w-[min(640px,var(--mention-input-width),calc(100vw-2rem))]' : 'w-max',
        // The docked mobile panel is its own scroll container.
        isMobile && 'w-full'
      )}
    >
      <MentionTwoLevelMenuBody
        view={view}
        onBack={handleBack}
        showBack={showBack}
        onCandidateSelect={handleCandidateSelect}
        detail={detail}
      />
    </MentionContent>
  );
}
