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
  UserRoundCog,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Toggle } from '@lody/ui/toggle';
import { ToggleGroup } from '@lody/ui/toggle-group';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, duration, ease, space, text } from '@lody/ui/tokens/scales.stylex';
import { useFireOnKeyChange, useFireOncePerCycle } from '@/hooks/use-fire-once';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { scoreFuzzy } from '@/components/mentions/vscode-fuzzy-score';
import { AgentRoleDetailPane } from '@/components/sessions/agent-role-detail-pane';
import { MentionContent, MentionItem, useMentionContext } from '@/ui/mention';
import { useIsMentionMobile } from '@/ui/mention/mention-mobile-content';
import {
  getCategoryNavigateText,
  getMentionViewCandidates,
  selectMentionMenuViewForTrigger,
  selectMentionViewActivations,
  type MentionCandidate,
  type MentionCandidateDetail,
  type MentionCategoryAction,
  type MentionCategory,
  type MentionIcon,
  type MentionMenuView,
  type MentionSourceKey,
} from '@/components/mentions/mention-registry';
import {
  captureMentionCategoryEnter,
  captureMentionMenuOpen,
  captureMentionSelect,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

/** Too narrow for the rows and the 248px detail side by side. */
const NARROW_MENU = '@container mention-menu (max-width: 480px)';

/**
 * Starts each lazy source the open menu needs, at most once while it stays
 * open; leaving and reopening starts a new refresh cycle. Which sources a view
 * needs is `selectMentionViewActivations`' decision — the menu only owns the
 * once-per-open policy and learns nothing about any individual source.
 *
 * Exported for tests; `MentionTwoLevelMenu` below is the only caller.
 */
export function useMentionCategoryActivation(
  open: boolean,
  view: MentionMenuView | null,
  categories: readonly MentionCategory[]
) {
  const shouldActivateSource = useFireOncePerCycle<MentionSourceKey>(open);
  const activateCategory = React.useCallback(
    (category: MentionCategory) => {
      const activation = category.activation;
      if (
        !open ||
        category.status === 'disabled' ||
        !activation ||
        !shouldActivateSource(activation.sourceKey)
      )
        return;
      activation.activate();
    },
    [open, shouldActivateSource]
  );

  React.useEffect(() => {
    if (!open) return;
    for (const activation of selectMentionViewActivations(view, categories)) {
      if (!shouldActivateSource(activation.sourceKey)) continue;
      activation.activate();
    }
  }, [categories, open, shouldActivateSource, view]);

  return activateCategory;
}

/**
 * A level arrives from the side it lies on: a category is one step in, so its
 * rows come from the trailing edge, and the way back brings the level above in
 * from the leading edge. Retyping within a level never moves it.
 */
const enterDeeper = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(12px)' },
  to: { opacity: 1, transform: 'none' },
});
const enterShallower = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(-12px)' },
  to: { opacity: 1, transform: 'none' },
});

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/**
 * The letters of `label` the typed term matched, by the same scorer the sources
 * rank with. A path term (`comp/ment`) is matched by its last segment, because a
 * file row's title is the name alone. Returns null when nothing matched, so the
 * row prints its title as it is rather than claiming a match it does not have.
 */
export function matchedRuns(
  label: string,
  term: string
): Array<{ text: string; matched: boolean }> | null {
  const query = term.slice(term.lastIndexOf('/') + 1);
  if (!query || !label) return null;
  const [score, positions] = scoreFuzzy(label, query, query.toLowerCase(), true);
  if (score <= 0 || positions.length === 0) return null;
  const lit = new Set(positions);
  const runs: Array<{ text: string; matched: boolean }> = [];
  for (let index = 0; index < label.length; index += 1) {
    const matched = lit.has(index);
    const last = runs[runs.length - 1];
    if (last && last.matched === matched) last.text += label[index];
    else runs.push({ text: label[index] ?? '', matched });
  }
  return runs;
}

/**
 * The menu's parts, on the surface and rows `ui/mention.tsx` draws. A row is one
 * line — its name, then quiet words that give way first — and grows a second
 * line only to say why it cannot be picked.
 */
const styles = stylex.create({
  /** The scroller holding the rows; the docked mobile strip is its own. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    maxHeight: 'min(320px, 60vh)',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  listDocked: { maxHeight: 'none', overflowY: 'visible' },
  level: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  levelDeeper: {
    animationName: { default: enterDeeper, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.regular,
    animationTimingFunction: ease.standard,
  },
  levelShallower: {
    animationName: { default: enterShallower, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.regular,
    animationTimingFunction: ease.standard,
  },
  /**
   * The rows and the detail, side by side. It is a container so the detail can
   * step aside when the composer is too narrow to hold both: a fixed-width pane
   * beside a list squeezed to nothing leaves nothing to pick.
   */
  withDetail: {
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    containerName: 'mention-menu',
    containerType: 'inline-size',
  },
  withDetailList: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  /** The leading mark: a 16px box at rest in the hint colour. */
  glyph: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
  },
  glyphHighlighted: { color: colors.secondaryLabel },
  glyphSvg: { display: 'block', flexShrink: 0, width: '16px', height: '16px' },
  /** An emoji standing for a Role or a shortcut: text, sized like a glyph. */
  emoji: { fontSize: text.subheadlineSize, lineHeight: 1 },
  text: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  textStacked: { paddingBlock: space[1] },
  line: { display: 'flex', alignItems: 'baseline', gap: space[2], minWidth: 0 },
  /** The name keeps its width; the hint beside it is what gives way. */
  title: {
    flexShrink: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleMuted: { color: colors.secondaryLabel },
  /**
   * While a term is typed, a title answers "why is this here?": the letters
   * that matched carry the ink and the weight, the rest step back to the
   * secondary label. The row still reads as one name.
   */
  titleSearching: { color: colors.secondaryLabel },
  matched: { color: colors.label, fontWeight: 650 },
  hint: {
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
    fontWeight: 400,
  },
  /** Why a row cannot be picked: a sentence, so it wraps. */
  note: {
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
    whiteSpace: 'normal',
  },
  /** Trailing metadata — `#3312`, a key, a scope — in the caption step. */
  trailing: {
    flexShrink: 0,
    paddingInlineStart: space[2],
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /** The key that opens a category directly, set like a menu shortcut. */
  key: { fontFamily: MONO, fontSize: text.footnoteSize },
  chevron: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  /** A heading over the rows under it, in sentence case like the product menus. */
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '24px',
    marginTop: { default: space[1], ':first-child': 0 },
    paddingInline: space[2],
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    userSelect: 'none',
  },
  /** A second level's heading: the way back, and the category's own options. */
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
    minWidth: 0,
    minHeight: control.small,
    paddingBottom: space[1],
    userSelect: 'none',
  },
  headerLabel: {
    paddingInline: space[2],
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
  },
  headerOptions: { marginInlineStart: 'auto' },
  /** A hint rather than a row: it cannot be picked. */
  message: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: control.small,
    paddingInline: space[2],
    color: colors.tertiaryLabel,
    fontWeight: 400,
    userSelect: 'none',
  },
  messageError: { color: colors.destructive },
  notice: {
    paddingInline: space[2],
    paddingBottom: space[1],
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1],
    paddingInline: space[2],
    paddingBlock: space[1.5],
    color: colors.tertiaryLabel,
    fontWeight: 400,
  },
  /**
   * The highlighted row's detail, beside the rows on the same surface. It takes
   * the height its content needs, up to the list's own cap, instead of holding
   * a fixed box open under a short list.
   */
  detail: {
    boxSizing: 'border-box',
    display: { default: 'flex', [NARROW_MENU]: 'none' },
    flexDirection: 'column',
    gap: space[2],
    flexShrink: 0,
    width: '248px',
    maxHeight: 'min(320px, 60vh)',
    marginInlineStart: space[1],
    paddingInline: space[3],
    paddingBlock: space[2],
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: colors.separator,
    fontWeight: 400,
  },
  /** The Role pane draws its own box; this only steps it aside when narrow. */
  detailSlot: { display: { default: 'flex', [NARROW_MENU]: 'none' }, flexShrink: 0 },
  detailTitle: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
  },
  detailBadges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[1] },
  detailDescription: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  detailRows: { display: 'flex', flexDirection: 'column', gap: space[1.5], margin: 0 },
  detailRow: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  detailRowLabel: {
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  detailRowValue: {
    minWidth: 0,
    margin: 0,
    overflowWrap: 'anywhere',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  mono: { fontFamily: MONO },
});

/** Keep focus in the composer: the menu closes the moment the input blurs. */
const keepComposerFocus = (event: React.PointerEvent) => event.preventDefault();

function CandidateIcon({
  icon,
  emoji,
  path,
}: {
  icon: MentionIcon;
  /** A candidate's own mark, shown INSTEAD of the category glyph. */
  emoji?: string;
  path?: string;
}) {
  if (emoji) {
    return (
      <span aria-hidden="true" {...stylex.props(styles.emoji)}>
        {emoji}
      </span>
    );
  }
  const className = stylex.props(styles.glyphSvg).className;
  switch (icon) {
    case 'file':
      return <FileIcon filePath={path ?? ''} className={className} />;
    case 'dir':
      return <FolderIcon folderPath={path ?? ''} className={className} />;
    case 'issue':
      return <CircleDot className={className} strokeWidth={1.75} />;
    case 'pr':
      return <GitPullRequest className={className} strokeWidth={1.75} />;
    case 'skill':
      return <Boxes className={className} strokeWidth={1.75} />;
    case 'command':
    case 'prompt_shortcut':
      return <Terminal className={className} strokeWidth={1.75} />;
    case 'session':
      return <MessageSquare className={className} strokeWidth={1.75} />;
    case 'agent_role':
      return <UserRoundCog className={className} strokeWidth={1.75} />;
    default:
      return null;
  }
}

/** The leading box; it steps up from hint to secondary under the keyboard. */
function RowGlyph({ value, children }: { value: string; children: React.ReactNode }) {
  const highlighted = useMentionContext('MentionRowGlyph').highlightedItem?.value === value;
  return (
    <span
      aria-hidden="true"
      {...stylex.props(styles.glyph, highlighted && styles.glyphHighlighted)}
    >
      {children}
    </span>
  );
}

function CategoryRow({
  category,
  onNavigate,
}: {
  category: MentionCategory;
  onNavigate?: (category: MentionCategory) => void;
}) {
  const value = `category:${category.id}`;
  const disabled = category.status === 'disabled';
  const reason = disabled && (category.message?.length ?? 0) > 0 ? category.message : undefined;
  return (
    <MentionItem
      value={value}
      disabled={disabled}
      title={disabled ? category.message : undefined}
      label={category.label}
      navigateText={getCategoryNavigateText(category)}
      // Navigation-item selection does not commit a mention. Start its lazy
      // source synchronously, through the same once-per-open latch used by the
      // view-derived fallback for typed/pasted `@skill:` prefixes.
      onMentionNavigate={onNavigate ? () => onNavigate(category) : undefined}
    >
      <RowGlyph value={value}>
        <CandidateIcon icon={category.icon} />
      </RowGlyph>
      <span {...stylex.props(styles.text, reason != null && styles.textStacked)}>
        <span {...stylex.props(styles.title, disabled && styles.titleMuted)}>{category.label}</span>
        {reason ? <span {...stylex.props(styles.note)}>{reason}</span> : null}
      </span>
      {/* The key that reaches this category without the menu: taught where it is used. */}
      {category.directTrigger ? (
        <span {...stylex.props(styles.trailing, styles.key)}>{category.directTrigger}</span>
      ) : null}
      {disabled ? null : (
        <RowGlyph value={value}>
          <ChevronRight {...stylex.props(styles.chevron)} />
        </RowGlyph>
      )}
    </MentionItem>
  );
}

function CandidateTitle({ runs }: { runs: Array<{ text: string; matched: boolean }> }) {
  return (
    <>
      {runs.map((run, index) =>
        run.matched ? (
          <span key={index} {...stylex.props(styles.matched)}>
            {run.text}
          </span>
        ) : (
          <React.Fragment key={index}>{run.text}</React.Fragment>
        )
      )}
    </>
  );
}

function CandidateRow({
  candidate,
  term,
  now,
  onSelect,
}: {
  candidate: MentionCandidate;
  /** What was typed after the trigger and namespace, to light what matched. */
  term: string;
  now: Date;
  onSelect?: () => void;
}) {
  const stacked = Boolean(candidate.subtitle || candidate.disabledReason);
  // Lit only when the title is where the term matched: an issue found by its
  // number keeps its title whole rather than dimming with nothing lit.
  const runs = React.useMemo(
    () => (term && !candidate.disabled ? matchedRuns(candidate.title, term) : null),
    [candidate.disabled, candidate.title, term]
  );
  // A row that descends (a folder) opens rather than inserts, and says so the
  // way a category row does.
  const descends = candidate.navigateText != null;
  const trailing =
    candidate.trailing ??
    (candidate.activityAt != null ? formatCompactRelativeTime(candidate.activityAt, now) : null);
  return (
    <MentionItem
      value={candidate.value}
      disabled={candidate.disabled}
      title={candidate.disabledReason}
      label={candidate.label}
      kind={candidate.kind}
      aria-disabled={candidate.disabled || undefined}
      insertText={candidate.insertText}
      navigateText={candidate.navigateText}
      onMentionSelect={onSelect}
      onMentionPrepare={candidate.onPrepare}
    >
      <RowGlyph value={candidate.value}>
        <CandidateIcon
          icon={candidate.icon}
          emoji={candidate.iconEmoji}
          path={candidate.iconPath}
        />
      </RowGlyph>
      <span {...stylex.props(styles.text, stacked && styles.textStacked)}>
        <span {...stylex.props(styles.line)}>
          <span
            {...stylex.props(
              styles.title,
              runs != null && styles.titleSearching,
              candidate.disabled && styles.titleMuted
            )}
          >
            {runs ? <CandidateTitle runs={runs} /> : candidate.title}
          </span>
          {candidate.hint ? <span {...stylex.props(styles.hint)}>{candidate.hint}</span> : null}
        </span>
        {candidate.subtitle ? (
          <span {...stylex.props(styles.note)}>{candidate.subtitle}</span>
        ) : null}
        {candidate.disabledReason ? (
          <span {...stylex.props(styles.note)}>{candidate.disabledReason}</span>
        ) : null}
      </span>
      {trailing ? <span {...stylex.props(styles.trailing)}>{trailing}</span> : null}
      {descends ? (
        <RowGlyph value={candidate.value}>
          <ChevronRight {...stylex.props(styles.chevron)} />
        </RowGlyph>
      ) : null}
    </MentionItem>
  );
}

/**
 * Desktop side panel for the highlighted candidate. Mobile docks a narrow
 * full-width strip with no hover, so it stays list-only.
 */
function CandidateDetailPane({ detail }: { detail: MentionCandidateDetail }) {
  // A Role is the composer's object, read with the composer's pane: same rows,
  // same wording for the ids, same instruction block — sized to this menu.
  if (detail.agentRole) {
    return (
      <div {...stylex.props(styles.detailSlot)}>
        <AgentRoleDetailPane
          role={detail.agentRole.role}
          agentConfig={detail.agentRole.agentConfig}
          machine={detail.agentRole.machine}
          machineLabel={detail.agentRole.machineLabel}
          className="h-[320px] w-[248px]"
        />
      </div>
    );
  }
  return (
    <div data-mention-detail="" {...stylex.props(styles.detail)}>
      {detail.title ? <p {...stylex.props(styles.detailTitle)}>{detail.title}</p> : null}
      {detail.badges?.length ? (
        <div {...stylex.props(styles.detailBadges)}>
          {detail.badges.map((badge) => (
            <Badge key={badge}>{badge}</Badge>
          ))}
        </div>
      ) : null}
      {detail.description ? (
        <p {...stylex.props(styles.detailDescription)}>{detail.description}</p>
      ) : null}
      {detail.rows?.length ? (
        <dl {...stylex.props(styles.detailRows)}>
          {detail.rows.map((row) => (
            <div key={row.label} {...stylex.props(styles.detailRow)}>
              <dt {...stylex.props(styles.detailRowLabel)}>{row.label}</dt>
              <dd {...stylex.props(styles.detailRowValue, row.mono && styles.mono)}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div {...stylex.props(styles.groupLabel)}>{children}</div>;
}

function Message({ children, tone }: { children: React.ReactNode; tone?: 'error' | 'loading' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      {...stylex.props(styles.message, tone === 'error' && styles.messageError)}
    >
      {tone === 'loading' ? <Spinner size="small" label={null} /> : null}
      {children}
    </div>
  );
}

function CategoryAction({ action }: { action: MentionCategoryAction }) {
  return (
    <Button
      variant="ghost"
      size="mini"
      aria-label={action.ariaLabel}
      onPointerDown={keepComposerFocus}
      onClick={action.onAction}
    >
      {action.label}
    </Button>
  );
}

function CategoryHeaderOptions({ header }: { header: NonNullable<MentionCategory['header']> }) {
  const selected = header.options.find((option) => option.selected)?.label;
  return (
    <ToggleGroup
      aria-label={header.ariaLabel}
      size="mini"
      value={selected ? [selected] : []}
      onValueChange={(next) => {
        // A pressed option cannot be un-pressed into "no scope"; only a new one answers.
        const option = header.options.find((entry) => entry.label === next[0]);
        if (option && !option.selected) option.onSelect();
      }}
      {...stylex.props(styles.headerOptions)}
    >
      {header.options.map((option) => (
        <Toggle key={option.label} value={option.label} onPointerDown={keepComposerFocus}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/**
 * A second level names itself. Reached through `@`, the name is also the way
 * back — a "Back" that does not say where it is would need the name beside it
 * anyway; reached through its own trigger it has no level above, so it is only
 * a heading.
 */
function CategoryHeader({
  showBack,
  onBack,
  category,
}: {
  showBack: boolean;
  onBack: () => void;
  category: MentionCategory;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.header)}>
      {showBack ? (
        <Button
          variant="ghost"
          size="mini"
          aria-label={t('mention.menu.backFrom', {
            category: category.label,
            defaultValue: '{{category}}, back to all categories',
          })}
          onPointerDown={keepComposerFocus}
          onClick={onBack}
        >
          <ChevronLeft {...stylex.props(styles.chevron)} />
          {category.label}
        </Button>
      ) : (
        <span {...stylex.props(styles.headerLabel)}>{category.label}</span>
      )}
      {category.header ? <CategoryHeaderOptions header={category.header} /> : null}
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
  onCategoryNavigate,
  onCandidateSelect,
  detail,
  docked = false,
}: {
  view: MentionMenuView;
  onBack: () => void;
  showBack: boolean;
  onCategoryNavigate?: (category: MentionCategory) => void;
  onCandidateSelect?: (category: MentionCategory, rank: number) => void;
  /** Side panel for the highlighted candidate; omitted on mobile. */
  detail?: MentionCandidateDetail | null;
  /** The docked mobile strip scrolls itself; the rows only flow inside it. */
  docked?: boolean;
}) {
  const { t } = useTranslation();
  const now = useStableNow();
  const listStyle = [styles.list, docked && styles.listDocked];
  const term = view.level === 'categories' ? '' : view.term;

  // Which way the menu just moved: into a category, or back out of one. Read
  // against the level last committed, so typing inside a level never replays it.
  const depth = view.level === 'category' ? 1 : 0;
  const levelKey = view.level === 'category' ? `category:${view.category.id}` : view.level;
  const committed = React.useRef({ key: levelKey, depth });
  const moved = levelKey !== committed.current.key;
  const entering = !moved
    ? null
    : depth > committed.current.depth
      ? styles.levelDeeper
      : depth < committed.current.depth
        ? styles.levelShallower
        : null;
  // The class stays on the keyed level after the commit, so the animation it
  // started is not cut off by the next render.
  const [motion, setMotion] = React.useState<typeof entering>(null);
  React.useLayoutEffect(() => {
    if (!moved) return;
    committed.current = { key: levelKey, depth };
    setMotion(entering);
  }, [depth, entering, levelKey, moved]);

  const list = (
    <div key={levelKey} {...stylex.props(styles.level, moved ? entering : motion)}>
      {renderLevel()}
    </div>
  );

  if (!detail) return list;
  return (
    <div {...stylex.props(styles.withDetail)}>
      <div {...stylex.props(styles.withDetailList)}>{list}</div>
      <CandidateDetailPane detail={detail} />
    </div>
  );

  function renderLevel() {
    if (view.level === 'categories') {
      return (
        <div {...stylex.props(listStyle)}>
          {view.categories.map((category) => (
            <CategoryRow key={category.id} category={category} onNavigate={onCategoryNavigate} />
          ))}
        </div>
      );
    }

    if (view.level === 'aggregate') {
      if (view.categories.length === 0 && view.groups.length === 0) {
        return <Message>{t('mention.menu.noResults', 'No results')}</Message>;
      }
      return (
        <div {...stylex.props(listStyle)}>
          {view.categories.map((category) => (
            <CategoryRow key={category.id} category={category} onNavigate={onCategoryNavigate} />
          ))}
          {view.groups.map((group) => (
            <React.Fragment key={group.category.id}>
              <GroupLabel>{group.category.label}</GroupLabel>
              {group.candidates.length === 0 ? (
                group.category.message ? (
                  <Message tone={group.category.status === 'error' ? 'error' : undefined}>
                    {group.category.message}
                  </Message>
                ) : group.category.status === 'loading' ? (
                  <Message tone="loading">{t('mention.menu.loading', 'Loading…')}</Message>
                ) : (
                  <Message>{t('mention.menu.noResults', 'No results')}</Message>
                )
              ) : null}
              {group.candidates.map((candidate, rank) => (
                <CandidateRow
                  key={candidate.value}
                  candidate={candidate}
                  term={term}
                  now={now}
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
        <CategoryHeader showBack={showBack} onBack={onBack} category={category} />
        {category.notice ? <div {...stylex.props(styles.notice)}>{category.notice}</div> : null}
        {category.message ? (
          <Message tone={category.status === 'error' ? 'error' : undefined}>
            {category.message}
          </Message>
        ) : candidates.length > 0 ? (
          <div {...stylex.props(listStyle)}>
            {candidates.map((candidate, rank) => (
              <CandidateRow
                key={candidate.value}
                candidate={candidate}
                term={term}
                now={now}
                onSelect={() => onCandidateSelect?.(category, rank)}
              />
            ))}
          </div>
        ) : category.status === 'loading' ? (
          <Message tone="loading">{t('mention.menu.loading', 'Loading…')}</Message>
        ) : category.emptyState ? (
          <div {...stylex.props(styles.emptyState)}>
            <span>{category.emptyState.message}</span>
            {category.emptyState.action ? (
              <CategoryAction action={category.emptyState.action} />
            ) : null}
          </div>
        ) : (
          <Message>{t('mention.menu.noResults', 'No results')}</Message>
        )}
      </>
    );
  }
}

/** Never wider than the composer it belongs to, nor the window. */
const width = stylex.create({
  menu: {
    width: 'max-content',
    maxWidth: 'min(var(--mention-input-width), calc(100vw - 2rem))',
  },
  menuWithDetail: { width: 'min(640px, var(--mention-input-width), calc(100vw - 2rem))' },
});

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

  const activateCategory = useMentionCategoryActivation(open, view, categories);

  // Highlight the first row whenever the level or result set changes, so Enter
  // always has a target. Keyed so typing does not re-highlight on every render.
  const highlightKey =
    view === null
      ? null
      : view.level === 'categories'
        ? `categories:${view.categories.length}`
        : view.level === 'aggregate'
          ? `aggregate:${view.term}:${view.groups.map((group) => `${group.category.id}:${group.candidates.length}`).join(',')}`
          : `category:${view.category.id}:${view.term}:${view.candidates.length}`;
  const shouldHighlightFirst = useFireOnKeyChange<string | null>();
  const { getEnabledItems, onHighlightedItemChange } = context;
  React.useEffect(() => {
    // Called first so closing the menu (`null`) is recorded as the previous key
    // and reopening on the same view highlights again.
    if (!shouldHighlightFirst(highlightKey) || highlightKey === null) return;
    const items = getEnabledItems();
    if (!items.length) return;
    requestAnimationFrame(() => {
      const first = getEnabledItems()[0] ?? null;
      if (first) onHighlightedItemChange(first);
    });
  }, [getEnabledItems, highlightKey, onHighlightedItemChange, shouldHighlightFirst]);

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
  const shouldReportMenuOpen = useFireOncePerCycle<'menu-open'>(open);
  React.useEffect(() => {
    if (!open || !shouldReportMenuOpen('menu-open')) return;
    captureMentionMenuOpen(postHog, analyticsBase, {
      level: view?.level ?? 'none',
      categoryCount: categories.length,
    });
  }, [analyticsBase, categories.length, open, postHog, shouldReportMenuOpen, view?.level]);

  // The first-to-second-level step. Reported from the resolved view rather than
  // the row callback: a navigation item never fires `onMentionSelect`, and this
  // also covers the keyboard route into a category. Leaving a category and
  // coming back is a real second entry, so this is key-change and not once-only.
  const shouldReportCategoryEnter = useFireOnKeyChange<string | null>();
  const scopedCategoryId = view?.level === 'category' ? view.category.id : null;
  const scopedTermLength = view?.level === 'category' ? view.term.length : 0;
  React.useEffect(() => {
    if (!shouldReportCategoryEnter(scopedCategoryId) || !scopedCategoryId) return;
    captureMentionCategoryEnter(postHog, analyticsBase, {
      category: scopedCategoryId,
      termLength: scopedTermLength,
    });
    // `scopedTermLength` is read at entry only; it must not re-fire on typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsBase, postHog, scopedCategoryId, shouldReportCategoryEnter]);

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
    // The docked mobile panel places itself; this width is the desktop popup's.
    <MentionContent className={stylex.props(width.menu, detail && width.menuWithDetail).className}>
      <MentionTwoLevelMenuBody
        view={view}
        onBack={handleBack}
        showBack={showBack}
        onCategoryNavigate={activateCategory}
        onCandidateSelect={handleCandidateSelect}
        detail={detail}
        docked={isMobile}
      />
    </MentionContent>
  );
}
