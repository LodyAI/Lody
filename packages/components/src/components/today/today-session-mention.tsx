import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { AlarmClock, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionRoomId, type SessionId, type TodayMentionTarget } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { sessionMetaAtomFamily, sessionMetaCacheSettledAtomFamily } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
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
const ICON_HIT = '20px';
const ICON_BLEED = '3px';

const styles = stylex.create({
  // Inline so a long title wraps like text; each line fragment keeps its own padding.
  mention: {
    display: 'inline',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    borderRadius: radius.mini,
    paddingInline: CHIP_PAD,
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
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    boxSizing: 'border-box',
    minWidth: ICON_HIT,
    height: text.bodyLeading,
    paddingInline: ICON_BLEED,
    marginInlineStart: `calc(-1 * ${ICON_BLEED})`,
    marginInlineEnd: `calc(${space[1]} - ${ICON_BLEED})`,
    verticalAlign: 'top',
    paddingBlock: 0,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: 'inherit',
    font: 'inherit',
    lineHeight: 1,
    cursor: 'pointer',
    borderRadius: radius.mini,
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.accent}` },
  },
  // Small text sits on the shared baseline, not on the line's centre (centred,
  // it reads like a superscript). Centred in the same line box, a smaller font's
  // baseline lands higher by about 0.6× the size difference; shift it back down.
  countdown: {
    fontSize: text.captionSize,
    lineHeight: text.bodyLeading,
    position: 'relative',
    top: `calc((${text.bodySize} - ${text.captionSize}) * 0.6)`,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  check: {
    width: 14,
    height: 14,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.success,
    color: colors.onAccent,
  },
  // Linear's backlog circle: small, hollow, dashed, in the warning colour.
  idle: {
    width: 10,
    height: 10,
    boxSizing: 'border-box',
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.warning,
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
  titleUnread: { fontWeight: 500 },
  titleDone: {
    color: colors.tertiaryLabel,
    textDecorationLine: 'line-through',
    textDecorationColor: 'currentColor',
  },
  muted: { color: colors.tertiaryLabel, fontStyle: 'italic' },
});

function StatusIcon(props: { display: Extract<TodaySessionDisplay, { state: 'ok' }> }) {
  const { status, snoozeCountdown } = props.display;
  switch (status) {
    case 'waiting':
      return <SessionRowStatusIndicator isWaitingPermission />;
    case 'running':
      return <SessionRowStatusIndicator isWorking />;
    case 'unread':
      return <SessionRowStatusIndicator hasUnreadMessages />;
    case 'later':
      return (
        <>
          <AlarmClock size={12} aria-hidden />
          {snoozeCountdown ? (
            <span {...stylex.props(styles.countdown)}>{snoozeCountdown}</span>
          ) : null}
        </>
      );
    case 'done':
      return (
        <span {...stylex.props(styles.check)} aria-hidden>
          <Check size={10} strokeWidth={3} />
        </span>
      );
    case 'idle':
      return <span {...stylex.props(styles.idle)} aria-hidden />;
  }
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
        {...stylex.props(
          styles.title,
          display.status === 'unread' && styles.titleUnread,
          display.status === 'done' && styles.titleDone
        )}
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
