import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Columns2, MessageSquarePlus, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';
import { MAX_CONVERSATION_SPLIT_PANES } from './conversation-split';
import { SeamGrip } from './seam-grip';

/**
 * The desktop conversation area split into columns (`conversation-split.ts` owns which columns
 * exist). Every column is a whole session page of its own: its own tab row on top, then its
 * conversation and composer, so the tab mechanism carries over unchanged and each column keeps
 * its own selection. The columns share one row of window chrome height, so the tab rows line
 * up into one band split by the same seams that split the conversations.
 *
 * The focused column is where keyboard commands and sidebar navigation land. The others stay
 * fully live; only their tab rows recede a little, so focus reads at a glance without dimming
 * anything someone is reading.
 */
export const SPLIT_PANE_MIN_WIDTH_PX = 320;

export type SplitConversationPaneContext = {
  focused: boolean;
  canSplit: boolean;
  canClose: boolean;
};

export type SplitConversationPaneView = {
  id: string;
  topBar: (context: SplitConversationPaneContext) => ReactNode;
  body: ReactNode | ((context: SplitConversationPaneContext) => ReactNode);
};

export type SplitConversationLayoutProps = {
  panes: readonly SplitConversationPaneView[];
  focusedPaneId: string;
  onFocusPane: (paneId: string) => void;
  autoSaveId?: string;
};

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/* A new column comes in from the seam it opened at, so it reads as the split, not as a page
   that replaced something. */
const paneIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(16px)' },
  to: { opacity: 1, transform: 'none' },
});

const styles = stylex.create({
  root: { position: 'relative', width: '100%', height: '100%', minWidth: 0 },
  group: { width: '100%', height: '100%' },
  panel: { minWidth: `${SPLIT_PANE_MIN_WIDTH_PX}px` },
  pane: {
    display: 'flex',
    height: '100%',
    minWidth: 0,
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--background))',
  },
  paneEntering: {
    animationName: { default: paneIn, [REDUCED_MOTION]: 'none' },
    animationDuration: '280ms',
    animationTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  topBar: {
    flexShrink: 0,
    minWidth: 0,
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
  },
  topBarBackground: {
    opacity: { default: 0.62, ':hover': 1, ':focus-within': 1 },
  },
  body: {
    position: 'relative',
    display: 'flex',
    flex: 1,
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  },
});

export function SplitConversationLayout({
  panes,
  focusedPaneId,
  onFocusPane,
  autoSaveId,
}: SplitConversationLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Columns that were there on first paint come in still; only a split animates.
  const [initialPaneIds] = useState(() => new Set(panes.map((pane) => pane.id)));

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const roomForAnother = width == null || width >= (panes.length + 1) * SPLIT_PANE_MIN_WIDTH_PX;
  const canSplit = panes.length < MAX_CONVERSATION_SPLIT_PANES && roomForAnother;
  const many = panes.length > 1;

  return (
    <div ref={rootRef} {...stylex.props(styles.root)}>
      <ResizablePanelGroup
        direction="horizontal"
        className={stylex.props(styles.group).className}
        autoSaveId={autoSaveId}
      >
        {panes.map((pane, index) => {
          const focused = pane.id === focusedPaneId;
          return [
            index > 0 ? (
              <ResizableHandle
                key={`seam-${pane.id}`}
                hitAreaMargins={{ coarse: 15, fine: 8 }}
                className="group/handle focus-visible:shadow-none"
              >
                <SeamGrip />
              </ResizableHandle>
            ) : null,
            <ResizablePanel
              key={pane.id}
              id={pane.id}
              order={index}
              minSize={10}
              className={stylex.props(styles.panel).className}
            >
              <section
                {...stylex.props(styles.pane, !initialPaneIds.has(pane.id) && styles.paneEntering)}
                data-split-pane-id={pane.id}
                data-focused={focused || undefined}
                aria-current={many && focused ? 'true' : undefined}
                onPointerDownCapture={() => onFocusPane(pane.id)}
                onFocusCapture={() => onFocusPane(pane.id)}
              >
                <div {...stylex.props(styles.topBar, many && !focused && styles.topBarBackground)}>
                  {pane.topBar({ focused, canSplit, canClose: many })}
                </div>
                <div {...stylex.props(styles.body)}>
                  {typeof pane.body === 'function'
                    ? pane.body({ focused, canSplit, canClose: many })
                    : pane.body}
                </div>
              </section>
            </ResizablePanel>,
          ];
        })}
      </ResizablePanelGroup>
    </div>
  );
}

const actionStyles = stylex.create({
  root: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '2px',
    paddingInline: space[1],
  },
});

/** A column's own controls, at the end of its tab row: split right, and close the column. */
export function SplitPaneActions({
  canSplit,
  canClose,
  onSplit,
  onClose,
}: {
  canSplit: boolean;
  canClose: boolean;
  onSplit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const splitLabel = canSplit
    ? t('sessions.split.splitRight', 'Split right')
    : t('sessions.split.full', 'Up to {{count}} columns side by side', {
        count: MAX_CONVERSATION_SPLIT_PANES,
      });
  const closeLabel = t('sessions.split.close', 'Close column');
  return (
    <div {...stylex.props(actionStyles.root)}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="small"
              icon
              aria-label={splitLabel}
              disabled={!canSplit}
              onClick={onSplit}
            >
              <Columns2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </Button>
          }
        />
        <Tooltip.Content>{splitLabel}</Tooltip.Content>
      </Tooltip.Root>
      {canClose ? (
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button variant="ghost" size="small" icon aria-label={closeLabel} onClick={onClose}>
                <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              </Button>
            }
          />
          <Tooltip.Content>{closeLabel}</Tooltip.Content>
        </Tooltip.Root>
      ) : null}
    </div>
  );
}

export type SplitPaneRecentSession = {
  id: string;
  title: string;
  /** Project · branch, or the machine; already formatted. */
  detail?: string | null;
  icon?: ReactNode;
  /** Already shown in another column: choosing it focuses that column. */
  open?: boolean;
};

const emptyStyles = stylex.create({
  root: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflowY: 'auto',
    padding: space[6],
  },
  column: {
    display: 'flex',
    width: '100%',
    maxWidth: '420px',
    flexDirection: 'column',
    gap: space[4],
  },
  heading: {
    margin: 0,
    color: colors.label,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  sub: {
    margin: 0,
    marginTop: `calc(${space[3]} * -1)`,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    overflow: 'hidden',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  item: {
    borderTopWidth: { default: '1px', ':first-child': 0 },
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  row: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderWidth: 0,
    margin: 0,
    textAlign: 'start',
    color: colors.label,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    cursor: 'default',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.accent}` },
    outlineOffset: '-2px',
  },
  rowIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.secondaryLabel,
  },
  rowText: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' },
  rowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  rowDetail: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  openBadge: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  actions: { display: 'flex', gap: space[2] },
});

/**
 * A column just split off, waiting for something to show: the recent conversations as one card
 * of ruled rows, and a new chat. A conversation already open in another column says so; picking
 * it moves focus there instead of opening it twice.
 */
export function SplitPaneEmptyState({
  recent,
  onOpen,
  onNewChat,
}: {
  recent: readonly SplitPaneRecentSession[];
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(emptyStyles.root)}>
      <div {...stylex.props(emptyStyles.column)}>
        <h2 {...stylex.props(emptyStyles.heading)}>
          {t('sessions.split.emptyTitle', 'Open a conversation here')}
        </h2>
        <p {...stylex.props(emptyStyles.sub)}>
          {t(
            'sessions.split.emptyHint',
            'Pick one below, or click a conversation in the sidebar while this column has focus.'
          )}
        </p>
        {recent.length > 0 ? (
          <ul {...stylex.props(emptyStyles.list)}>
            {recent.map((session) => (
              <li key={session.id} {...stylex.props(emptyStyles.item)}>
                <button
                  type="button"
                  {...stylex.props(emptyStyles.row)}
                  onClick={() => onOpen(session.id)}
                >
                  <span {...stylex.props(emptyStyles.rowIcon)} aria-hidden="true">
                    {session.icon}
                  </span>
                  <span {...stylex.props(emptyStyles.rowText)}>
                    <span {...stylex.props(emptyStyles.rowTitle)}>{session.title}</span>
                    {session.detail ? (
                      <span {...stylex.props(emptyStyles.rowDetail)}>{session.detail}</span>
                    ) : null}
                  </span>
                  {session.open ? (
                    <span {...stylex.props(emptyStyles.openBadge)}>
                      {t('sessions.split.alreadyOpen', 'Open in another column')}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div {...stylex.props(emptyStyles.actions)}>
          <Button variant="secondary" size="small" onClick={onNewChat}>
            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {t('sessions.split.newChat', 'New chat in this column')}
          </Button>
        </div>
      </div>
    </div>
  );
}
