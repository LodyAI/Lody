import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import type React from 'react';
import { Hand } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionRoomId, type SessionId, type TodayMentionTarget } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { sessionMetaAtomFamily, sessionMetaCacheSettledAtomFamily } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { startSessionMentionDrag } from '@/lib/session-mention-drag';
import { useTodayEditor } from './editor/today-editor-context';
import {
  todaySessionDisplay,
  type TodaySessionDisplay,
  type TodaySessionState,
} from './today-session-status';
import { useTodayNow } from './use-today-clock';
import { useTodayMembers } from './today-members';
import { UserAvatar } from '../user-avatar';

// Inline-reference chip rules (Notion, Linear, Slack, AFFiNE, Outline): the chip
// stays inline text so it never grows the line; it carries its own inline
// padding so a selection fill clears the icon and title; the icon is a fixed
// slot centred on the line with its own hover, apart from the title's
// underline; selection only tints the fill, so the title keeps its state colour
// (a Done title stays dim and struck through). The chip spaces itself only from
// text that touches it: a space or punctuation beside it already separates it,
// so there its end padding overhangs instead of adding to a word space.
const CHIP_PAD = space[1];
// Glyph (or countdown) to title: about a word space, so the icon reads as part
// of its title, as inline references do elsewhere (the composer's chips 0.2em,
// VS Code's chat anchors 3px, AFFiNE's and Outline's mentions 4px).
const ICON_GAP = space[1];
// How far the icon's hover fill reaches past its glyph on each side.
const ICON_BLEED = '2px';

/**
 * Whether a mention needs its own gap from `neighbour`, the character just
 * before or after it: yes for a letter, CJK text or another mention; no for a
 * space, punctuation or the edge of the text. Static rows and the editor decide
 * it from the same node text, so a row keeps its metrics when the editor mounts.
 */
function todayMentionNeedsGap(neighbour: string | undefined): boolean {
  return neighbour !== undefined && !/[\s\p{P}]/u.test(neighbour);
}

/** Which sides of the mention at `index` of `text` need their own gap. */
export function todayMentionGaps(text: string, index: number): TodayMentionGaps {
  return {
    before: todayMentionNeedsGap(text[index - 1]),
    after: todayMentionNeedsGap(text[index + 1]),
  };
}

export type TodayMentionGaps = { before: boolean; after: boolean };

const styles = stylex.create({
  // Inline so a long title wraps like text; each line fragment keeps its own padding.
  mention: {
    display: 'inline',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    // Square: a selection running through text and chips reads as one band.
    // 1px start padding only — the icon box insets its glyph already.
    paddingInlineStart: '1px',
    paddingInlineEnd: CHIP_PAD,
    userSelect: 'none',
  },
  // A space or punctuation follows: the end padding keeps the selection fill but
  // takes no room, so `test should` and `flag,` read as in plain text.
  flushEnd: { marginInlineEnd: `calc(-1 * ${CHIP_PAD})` },
  // Text touches the start (CJK has no spaces): as much room as a word space gives.
  gapStart: { marginInlineStart: CHIP_PAD },
  // The editor's text selection tint (`::selection`), so a selected chip reads as
  // part of the selected run and keeps every state colour.
  selected: { backgroundColor: `color-mix(in srgb, ${colors.accent} 25%, transparent)` },
  // The status icon is its own small icon button (Linear's issue-row status):
  // an inline-block on the line's baseline, one line box tall. Its glyph sits
  // in a line-height box centred on the line (not `vertical-align: middle`,
  // which reads low), and a countdown inside is ordinary text on the shared
  // baseline in every font. The hover fill starts 1px into the chip, which
  // keeps the caret before the chip clear of it.
  icon: {
    display: 'inline-block',
    boxSizing: 'border-box',
    lineHeight: text.bodyLeading,
    verticalAlign: 'baseline',
    marginInlineStart: 0,
    paddingInlineStart: ICON_BLEED,
    paddingInlineEnd: ICON_BLEED,
    marginInlineEnd: `calc(${ICON_GAP} - ${ICON_BLEED})`,
    paddingBlock: 0,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    borderRadius: radius.mini,
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.accent}` },
  },
  // The glyph slot: one line box tall, top-aligned, glyph centred inside.
  glyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 12,
    height: text.bodyLeading,
    verticalAlign: 'top',
  },
  // Mark colours follow the text beside them: link accent for running,
  // waiting, unread, Later and idle; Done takes its dimmed title's grey.
  mark: { display: 'block', color: colors.accent },
  markDone: { color: colors.tertiaryLabel },

  // Plain inline text: it sits on the line's baseline like the title.
  countdown: {
    fontSize: text.captionSize,
    // Its own line box no taller than its font, so baseline alignment never
    // pushes the line taller.
    lineHeight: 1,
    marginInlineStart: 2,
    color: colors.accent,
    fontVariantNumeric: 'tabular-nums',
  },

  title: {
    display: 'inline',
    padding: 0,
    borderWidth: 0,
    background: 'none',
    font: 'inherit',
    textAlign: 'start',
    color: colors.accent,
    cursor: 'pointer',
    textDecorationLine: 'underline',
    textDecorationColor: 'transparent',
    textUnderlineOffset: '3px',
    ':hover': { textDecorationColor: 'currentColor' },
  },
  titleDone: {
    color: colors.tertiaryLabel,
    textDecorationLine: 'line-through',
    textDecorationColor: 'currentColor',
  },
  muted: { color: colors.tertiaryLabel, fontStyle: 'italic' },
  member: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    height: text.bodyLeading,
    verticalAlign: 'top',
    boxSizing: 'border-box',
    paddingInlineStart: 2,
    paddingInlineEnd: space[2],
    marginInline: 1,
    borderRadius: radius.full,
    borderWidth: 0,
    backgroundColor: {
      default: `color-mix(in srgb, ${colors.accent} 14%, transparent)`,
      ':hover': `color-mix(in srgb, ${colors.accent} 22%, transparent)`,
    },
    color: colors.accent,
    font: 'inherit',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    userSelect: 'none',
  },
  memberSelected: { backgroundColor: `color-mix(in srgb, ${colors.accent} 32%, transparent)` },
});

/**
 * One family of 12px status marks (Linear's status circles): the same circle,
 * stroke and weight for every state, told apart by fill and a small mark.
 * Static on purpose: motion inside running text is noise (the sidebar keeps
 * its animated working mark).
 */
function StatusGlyph(props: { status: TodaySessionState }) {
  const { status } = props;
  const style = stylex.props(styles.mark, status === 'done' && styles.markDone);
  // Waiting for you: the sidebar's hand, at the family's size and stroke.
  if (status === 'waiting') return <Hand size={12} strokeWidth={1.75} aria-hidden {...style} />;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden {...style}>
      {STATUS_SHAPES[status]}
    </svg>
  );
}

const RING = {
  cx: 6,
  cy: 6,
  r: 5,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
} as const;
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const STATUS_SHAPES: Record<Exclude<TodaySessionState, 'waiting'>, React.ReactNode> = {
  idle: <circle {...RING} strokeDasharray="2.2 1.8" />,
  running: (
    <>
      <circle {...RING} />
      <path d="M6 2.5 A3.5 3.5 0 0 1 6 9.5 Z" fill="currentColor" />
    </>
  ),
  // A ring like every other state, with a dot inside: a bare dot beside the
  // bullet of a line that starts with the mention read as a second bullet.
  unread: (
    <>
      <circle {...RING} />
      <circle cx="6" cy="6" r="2.25" fill="currentColor" />
    </>
  ),
  later: (
    <>
      <circle {...RING} />
      <path d="M6 3.5 V6 L7.75 7.1" {...STROKE} />
    </>
  ),
  done: (
    <>
      <circle {...RING} />
      <path d="M3.9 6.1 L5.4 7.5 L8.1 4.7" {...STROKE} />
    </>
  ),
};

function StatusIcon(props: { display: Extract<TodaySessionDisplay, { state: 'ok' }> }) {
  const { status, snoozeCountdown } = props.display;
  return (
    <>
      <span {...stylex.props(styles.glyph)}>
        <StatusGlyph status={status} />
      </span>
      {snoozeCountdown ? <span {...stylex.props(styles.countdown)}>{snoozeCountdown}</span> : null}
    </>
  );
}

/**
 * One conversation mention: its status icon (a button opening the status
 * menu) and its live title (opens the conversation). Static rows and the
 * editor's decorators render this same component so metrics match; its root
 * carries `data-today-mention`, which caret geometry counts as one character.
 * Pointer presses never reach the row, so they never activate the editor.
 * A resolved conversation drags out like a sidebar row (onto a conversation or
 * the new-chat page); a press on the status icon never starts that drag.
 * `gaps` come from {@link todayMentionGaps} on the node text.
 * Behavior: specs/today-outline.md (Conversation mentions).
 */
export function TodayMention(props: {
  mention: TodayMentionTarget;
  selected?: boolean;
  gaps: TodayMentionGaps;
}) {
  const { t } = useTranslation();
  const { mention, selected = false, gaps } = props;
  if (mention.kind === 'member' && mention.id) {
    return <TodayMemberMention userId={mention.id} selected={selected} />;
  }
  if (mention.kind !== 'session' || !mention.id) {
    return (
      <span
        {...stylex.props(
          styles.mention,
          gaps.before && styles.gapStart,
          !gaps.after && styles.flushEnd,
          styles.muted,
          selected && styles.selected
        )}
        data-today-mention=""
        contentEditable={false}
      >
        {mention.kind ? t('today.mentionUnsupported', 'Unsupported reference') : '?'}
      </span>
    );
  }
  return <TodaySessionMention sessionId={mention.id} selected={selected} gaps={gaps} />;
}

function TodayMemberMention(props: { userId: string; selected: boolean }) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const member = useTodayMembers().get(props.userId);
  const name = member?.name ?? t('today.memberUnknown', 'Unknown member');
  return (
    <button
      type="button"
      tabIndex={-1}
      {...stylex.props(styles.member, props.selected && styles.memberSelected)}
      data-today-mention=""
      data-today-member={props.userId}
      contentEditable={false}
      aria-label={t('today.memberMention', '{{name}}, open their Today', { name })}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        controller?.onOpenMember?.(props.userId);
      }}
    >
      <UserAvatar
        user={{ id: props.userId, name, image: member?.image }}
        size="mini"
        showIcon={!member}
      />
      {name}
    </button>
  );
}

/** A conversation's mention display from the sidebar's signals and the surface clock. */
export function useTodaySessionDisplay(sessionId: SessionId): TodaySessionDisplay {
  const nowMs = useTodayNow();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const metaSettled = useAtomValue(sessionMetaCacheSettledAtomFamily(sessionId));
  const live = useAtomValue(sessionLiveStatusAtomFamily(sessionId));
  return todaySessionDisplay({ meta, metaSettled, live, nowMs });
}

function TodaySessionMention(props: {
  sessionId: string;
  selected: boolean;
  gaps: TodayMentionGaps;
}) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const sessionId = props.sessionId as SessionId;
  const display = useTodaySessionDisplay(sessionId);
  const pressedStatus = useRef(false);
  const rootProps = {
    'data-today-mention': '',
    'data-today-session': sessionId,
    contentEditable: false,
    onPointerDown: (event: React.PointerEvent) => {
      pressedStatus.current = false;
      event.stopPropagation();
    },
  } as const;
  if (display.state !== 'ok') {
    return (
      <span
        {...stylex.props(
          styles.mention,
          props.gaps.before && styles.gapStart,
          !props.gaps.after && styles.flushEnd,
          styles.muted,
          props.selected && styles.selected
        )}
        {...rootProps}
      >
        {display.state === 'missing'
          ? t('today.sessionMissing', 'Session deleted / No access')
          : '…'}
      </span>
    );
  }
  const title = display.title || t('today.untitledSession', 'Untitled session');
  const statusLabel = {
    waiting: t('today.status.waiting', 'Waiting for you'),
    running: t('today.status.running', 'Running'),
    later: t('today.status.later', 'Later'),
    done: t('today.status.done', 'Done'),
    unread: t('today.status.unread', 'Unread'),
    idle: t('today.status.idle', 'Idle'),
  }[display.status];
  return (
    <span
      {...stylex.props(
        styles.mention,
        props.gaps.before && styles.gapStart,
        !props.gaps.after && styles.flushEnd,
        props.selected && styles.selected
      )}
      {...rootProps}
      data-today-status={display.status}
      draggable
      onDragStart={(event) => {
        if (pressedStatus.current) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        startSessionMentionDrag(event, { sessionId, title, source: 'today' });
      }}
    >
      <button
        type="button"
        {...stylex.props(styles.icon)}
        data-today-mention-status=""
        aria-haspopup="menu"
        aria-label={t('today.changeStatus', 'Status: {{status}}. Change status', {
          status: statusLabel,
        })}
        tabIndex={-1}
        onPointerDown={(event) => {
          pressedStatus.current = true;
          // Keep the editor's focus and selection where they are.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          controller?.onMentionMenu?.(sessionId, event.currentTarget);
        }}
      >
        <StatusIcon display={display} />
      </button>
      {/* A span: a button never wraps, leaving the status icon alone on the line above. */}
      <span
        role="button"
        {...stylex.props(styles.title, display.status === 'done' && styles.titleDone)}
        aria-label={t('today.mentionLabel', 'Session: {{title}}, {{status}}', {
          title,
          status: statusLabel,
        })}
        tabIndex={-1}
        onClick={(event) => controller?.onOpenSession?.(sessionId, event)}
      >
        {title}
      </span>
    </span>
  );
}
