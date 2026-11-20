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

const styles = stylex.create({
  // Inline so a long title wraps like text; each line fragment keeps its own padding.
  mention: {
    display: 'inline',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    borderRadius: radius.mini,
    paddingInline: 1,
    userSelect: 'none',
  },
  selected: { backgroundColor: 'Highlight', color: 'HighlightText' },
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minWidth: 14,
    height: 14,
    marginInlineEnd: space[1],
    verticalAlign: '-2px',
    padding: 0,
    borderWidth: 0,
    background: 'none',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    borderRadius: radius.mini,
    ':hover': { backgroundColor: colors.hoverFill },
  },
  countdown: {
    fontSize: text.captionSize,
    lineHeight: 1,
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
  titleSelected: { color: 'inherit' },
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
export function TodayMention(props: { mention: TodayMentionTarget; selected?: boolean }) {
  const { t } = useTranslation();
  const { mention, selected = false } = props;
  if (mention.kind !== 'session' || !mention.id) {
    return (
      <span
        {...stylex.props(styles.mention, styles.muted, selected && styles.selected)}
        data-today-mention=""
        contentEditable={false}
      >
        {mention.kind ? t('today.mentionUnsupported', 'Unsupported reference') : '?'}
      </span>
    );
  }
  return <TodaySessionMention sessionId={mention.id} selected={selected} />;
}

/** A conversation's mention display from the sidebar's signals and the surface clock. */
export function useTodaySessionDisplay(sessionId: SessionId): TodaySessionDisplay {
  const nowMs = useTodayNow();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const metaSettled = useAtomValue(sessionMetaCacheSettledAtomFamily(sessionId));
  const live = useAtomValue(sessionLiveStatusAtomFamily(sessionId));
  return todaySessionDisplay({ meta, metaSettled, live, nowMs });
}

function TodaySessionMention(props: { sessionId: string; selected: boolean }) {
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
        {...stylex.props(styles.mention, styles.muted, props.selected && styles.selected)}
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
      {...stylex.props(styles.mention, props.selected && styles.selected)}
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
          display.status === 'done' && styles.titleDone,
          props.selected && styles.titleSelected
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
