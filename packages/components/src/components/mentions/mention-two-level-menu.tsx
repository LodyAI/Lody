import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import { MentionContent, MentionItem, useMentionContext } from '@/ui/mention';
import { useIsMentionMobile } from '@/ui/mention/mention-mobile-content';
import {
  getCategoryNavigateText,
  selectMentionMenuViewForTrigger,
  type MentionCandidate,
  type MentionCategory,
  type MentionIcon,
  type MentionMenuView,
} from '@/components/mentions/mention-registry';

type MentionContextValue = NonNullable<ReturnType<typeof useMentionContext>>;

/**
 * Pop the `@<ns>:` prefix back to a bare `@`, the click equivalent of the
 * primitive's Backspace/ArrowLeft contract. Mobile has no Backspace habit, so
 * the second level always carries a visible way out.
 */
function navigateBackToCategories(context: MentionContextValue): void {
  const input = context.inputRef.current;
  if (!input) return;
  const caretPosition = input.selectionStart ?? input.value.length;
  const triggerIndex = input.value.lastIndexOf(context.trigger, caretPosition);
  if (triggerIndex === -1) return;

  const caret = triggerIndex + context.trigger.length;
  const nextValue = input.value.slice(0, caret) + input.value.slice(caretPosition);
  context.onInputValueChange(nextValue);
  // Let MentionInput restore the caret once it renders this exact value;
  // touching the DOM selection here races the controlled value commit.
  context.onPendingSelectionChange({ start: caret, end: caret, expectedValue: nextValue });
  context.filterStore.search = '';
  context.onHighlightedItemChange(null);
  requestAnimationFrame(() => context.onItemsFilter());
  input.focus();
}

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
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{category.label}</span>
        <span className="truncate text-xs text-muted-foreground">{category.hint}</span>
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-40" />
    </MentionItem>
  );
}

function CandidateRow({ candidate }: { candidate: MentionCandidate }) {
  return (
    <MentionItem
      value={candidate.value}
      label={candidate.label}
      kind={candidate.kind}
      insertText={candidate.insertText}
      navigateText={candidate.navigateText}
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

function CategoryBreadcrumb({
  category,
  showBack,
  onBack,
}: {
  category: MentionCategory;
  showBack: boolean;
  onBack: () => void;
}) {
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
      <span className="font-mono text-[11px] text-foreground/70">
        {getCategoryNavigateText(category)}
      </span>
      <span className="min-w-0 truncate">{category.hint}</span>
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
}: {
  view: MentionMenuView;
  onBack: () => void;
  showBack: boolean;
}) {
  const { t } = useTranslation();

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
            {group.candidates.map((candidate) => (
              <CandidateRow key={candidate.value} candidate={candidate} />
            ))}
          </React.Fragment>
        ))}
      </div>
    );
  }

  const { category, candidates } = view;
  return (
    <>
      <CategoryBreadcrumb category={category} showBack={showBack} onBack={onBack} />
      {category.notice ? (
        <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{category.notice}</div>
      ) : null}
      {category.message ? (
        <Message tone={category.status === 'error' ? 'error' : undefined}>
          {category.message}
        </Message>
      ) : candidates.length > 0 ? (
        <div className="scrollbar-pro max-h-[280px] overflow-y-auto">
          {candidates.map((candidate) => (
            <CandidateRow key={candidate.value} candidate={candidate} />
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

/**
 * The single `@` mention menu: a category list, an aggregate search, or one
 * scoped category. Replaces the per-trigger menus; `/` still opens the command
 * category directly through its `directTrigger`.
 */
export function MentionTwoLevelMenu({ categories }: { categories: MentionCategory[] }) {
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

  const handleBack = React.useCallback(() => {
    navigateBackToCategories(context);
  }, [context]);

  if (!view) return null;

  // A category reached through its own trigger has no level above it to go back
  // to; only the `@` route shows the way out.
  const showBack = view.level === 'category' && trigger === '@';

  return (
    <MentionContent
      className={cn(
        'w-max max-w-[min(var(--mention-input-width),calc(100vw-2rem))]',
        // The docked mobile panel is its own scroll container.
        isMobile && 'w-full'
      )}
    >
      <MentionTwoLevelMenuBody view={view} onBack={handleBack} showBack={showBack} />
    </MentionContent>
  );
}
