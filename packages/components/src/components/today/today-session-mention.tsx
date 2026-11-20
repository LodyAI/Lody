import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import type React from 'react';
import { Hand } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionRoomId, type SessionId, type TodayMentionTarget } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { sessionMetaAtomFamily, sessionMetaCacheSettledAtomFamily } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { useTodayEditor } from './editor/today-editor-context';
import { todaySessionDisplay, type TodaySessionDisplay } from './today-session-status';
import { useTodayNow } from './use-today-clock';

// Inline-reference chip rules (Notion, Linear, Slack, AFFiNE, Outline): the chip
// stays inline text so it never grows the line; it carries its own inline
// padding so a selection fill clears the icon and title; the icon is a fixed
// slot centred on the text's x-height with its own hover, apart from the title's
// underline; selection only tints the fill, so the title keeps its state colour
// (a Done title stays dim and struck through).
const CHIP_PAD = space[1];
const ICON_HIT = '18px';
const ICON_BLEED = '3px';

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
  // A chip that opens its line keeps its padding: pulling it into the gutter put
  // the caret before the chip inside the icon's hover fill.
  leading: {},
  // The editor's text selection tint (`::selection`), so a selected chip reads as
  // part of the selected run and keeps every state colour.
  selected: { backgroundColor: `color-mix(in srgb, ${colors.accent} 25%, transparent)` },
  // The status icon is its own small icon button (Linear's issue-row status).
  // It is exactly one line box tall and aligned to the line's top, with its
  // glyph centred inside (`align-items: center`): the glyph sits on the centre
  // of the line, where the title's capitals and CJK glyphs sit, instead of
  // `vertical-align: middle`'s baseline-plus-half-x-height, which reads low.
  // The 3px bleed stays inside the chip's 4px padding, so the caret before the
  // chip is never under the hover fill.
  icon: {
    // An inline-block on the line's baseline, one line box tall: its glyph sits
    // in a line-height box centred on the line, and a countdown inside is
    // ordinary text on the shared baseline in every font. The 1px start margin
    // keeps the caret before the chip clear of the hover fill.
    display: 'inline-block',
    boxSizing: 'border-box',
    minWidth: ICON_HIT,
    lineHeight: text.bodyLeading,
    verticalAlign: 'baseline',
    marginInlineStart: '1px',
    paddingInlineStart: 0,
    paddingInlineEnd: ICON_BLEED,
    marginInlineEnd: `calc(${space[1]} - ${ICON_BLEED})`,
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
  // Mark colours: accent for live work and unread, warning for idle and
  // waiting on you, quiet grey for Later and Done.
  markAccent: { color: colors.accent, display: 'block' },
  markWarning: { color: colors.warning, display: 'block' },
  markQuiet: { color: colors.secondaryLabel, display: 'block' },

  // Plain inline text: it sits on the line's baseline like the title.
  countdown: {
    fontSize: text.captionSize,
    // Its own line box no taller than its font, so baseline alignment never
    // pushes the line taller.
    lineHeight: 1,
    marginInlineStart: 2,
    color: colors.tertiaryLabel,
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
});

/**
 * One family of 12px status marks (Linear's status circles): the same circle,
 * stroke and weight for every state, told apart by fill and a small mark.
 * Static on purpose: motion inside running text is noise (the sidebar keeps
 * its animated working mark).
 */
function StatusGlyph(props: { status: Extract<TodaySessionDisplay, { state: 'ok' }>['status'] }) {
  const ring = { cx: 6, cy: 6, r: 5, fill: 'none', strokeWidth: 1.5 } as const;
  switch (props.status) {
    case 'idle':
      return (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          {...stylex.props(styles.markWarning)}
        >
          <circle {...ring} stroke="currentColor" strokeDasharray="2.2 1.8" />
        </svg>
      );
    case 'running':
      return (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          {...stylex.props(styles.markAccent)}
        >
          <circle {...ring} stroke="currentColor" />
          <path d="M6 2.5 A3.5 3.5 0 0 1 6 9.5 Z" fill="currentColor" />
        </svg>
      );
    case 'waiting':
      // Waiting for you: the sidebar's hand, at the family's size and stroke.
      return <Hand size={12} strokeWidth={1.75} aria-hidden {...stylex.props(styles.markAccent)} />;
    case 'unread':
      return (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          {...stylex.props(styles.markAccent)}
        >
          <circle cx="6" cy="6" r="3.5" fill="currentColor" />
        </svg>
      );
    case 'later':
      return (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          {...stylex.props(styles.markQuiet)}
        >
          <circle {...ring} stroke="currentColor" />
          <path
            d="M6 3.5 V6 L7.75 7.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'done':
      return (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          {...stylex.props(styles.markQuiet)}
        >
          <circle {...ring} stroke="currentColor" />
          <path
            d="M3.9 6.1 L5.4 7.5 L8.1 4.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

function StatusIcon(props: { display: Extract<TodaySessionDisplay, { state: 'ok' }> }) {
  const { status, snoozeCountdown } = props.display;
  return (
    <>
      <span {...stylex.props(styles.glyph)}>
        <StatusGlyph status={status} />
      </span>
      {status === 'later' && snoozeCountdown ? (
        <span {...stylex.props(styles.countdown)}>{snoozeCountdown}</span>
      ) : null}
    </>
  );
}

/**
 * One conversation mention: its status icon (a button opening the status
 * menu) and its live title (opens the conversation). Static rows and the
 * editor's decorators render this same component so metrics match; its root
 * carries `data-today-mention`, which caret geometry counts as one character.
 * Pointer presses never reach the row, so they never activate the editor.
 * Behavior: specs/today-outline.md (Conversation mentions).
 */
export function TodayMention(props: {
  mention: TodayMentionTarget;
  selected?: boolean;
  /** The mention opens a line of its node (offset 0 or after a newline). */
  leading?: boolean;
}) {
  const { t } = useTranslation();
  const { mention, selected = false, leading = false } = props;
  if (mention.kind !== 'session' || !mention.id) {
    return (
      <span
        {...stylex.props(
          styles.mention,
          leading && styles.leading,
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
  return <TodaySessionMention sessionId={mention.id} selected={selected} leading={leading} />;
}

/** A conversation's mention display from the sidebar's signals and the surface clock. */
export function useTodaySessionDisplay(sessionId: SessionId): TodaySessionDisplay {
  const nowMs = useTodayNow();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const metaSettled = useAtomValue(sessionMetaCacheSettledAtomFamily(sessionId));
  const live = useAtomValue(sessionLiveStatusAtomFamily(sessionId));
  return todaySessionDisplay({ meta, metaSettled, live, nowMs });
}

function TodaySessionMention(props: { sessionId: string; selected: boolean; leading: boolean }) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const sessionId = props.sessionId as SessionId;
  const display = useTodaySessionDisplay(sessionId);
  const rootProps = {
    'data-today-mention': '',
    'data-today-session': sessionId,
    contentEditable: false,
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  } as const;
  if (display.state !== 'ok') {
    return (
      <span
        {...stylex.props(
          styles.mention,
          props.leading && styles.leading,
          styles.muted,
          props.selected && styles.selected
        )}
        {...rootProps}
      >
        {display.state === 'missing'
          ? t('today.sessionMissing', 'Conversation deleted / No access')
          : '…'}
      </span>
    );
  }
  const title = display.title || t('today.untitledSession', 'Untitled conversation');
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
        props.leading && styles.leading,
        props.selected && styles.selected
      )}
      {...rootProps}
      data-today-status={display.status}
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
      <button
        type="button"
        {...stylex.props(styles.title, display.status === 'done' && styles.titleDone)}
        aria-label={t('today.mentionLabel', 'Conversation: {{title}}, {{status}}', {
          title,
          status: statusLabel,
        })}
        tabIndex={-1}
        onClick={(event) => controller?.onOpenSession?.(sessionId, event)}
      >
        {title}
      </button>
    </span>
  );
}
