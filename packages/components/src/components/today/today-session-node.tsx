import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { sessionMetaAtomFamily, sessionMetaCacheSettledAtomFamily } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { todaySessionDisplay } from './today-session-status';

const styles = stylex.create({
  label: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    background: 'none',
    borderWidth: 0,
    padding: 0,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    textDecorationLine: 'underline',
    textDecorationColor: 'transparent',
    textUnderlineOffset: '3px',
    ':hover': { textDecorationColor: colors.tertiaryLabel },
  },
  done: {
    color: colors.tertiaryLabel,
    textDecorationLine: 'line-through',
    textDecorationColor: 'currentColor',
    ':hover': { textDecorationColor: 'currentColor' },
  },
  muted: { color: colors.tertiaryLabel, fontStyle: 'italic' },
  check: {
    width: 14,
    height: 14,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.success,
    color: colors.onAccent,
    flexShrink: 0,
  },
  status: { display: 'inline-flex', width: 14, justifyContent: 'center', flexShrink: 0 },
});

/**
 * A session node's line: live title and the sidebar's status mark, drawn as a
 * finished to-do when the session is settled or archived. Clicking the title
 * opens the conversation; the rest of the row selects the node.
 */
export function TodaySessionLabel(props: {
  sessionId: string;
  onOpen: (event: { metaKey: boolean; ctrlKey: boolean }) => void;
}) {
  const { t } = useTranslation();
  const sessionId = props.sessionId as SessionId;
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const metaSettled = useAtomValue(sessionMetaCacheSettledAtomFamily(sessionId));
  const live = useAtomValue(sessionLiveStatusAtomFamily(sessionId));
  const display = todaySessionDisplay({ meta, metaSettled, live });
  if (display.state !== 'ok') {
    return (
      <span {...stylex.props(styles.label, styles.muted)} data-today-session={sessionId}>
        {display.state === 'missing'
          ? t('today.sessionMissing', 'Conversation deleted / No access')
          : '…'}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.label)} data-today-session={sessionId}>
      {display.done ? (
        <span {...stylex.props(styles.check)} aria-hidden>
          <Check size={10} strokeWidth={3} />
        </span>
      ) : display.waiting || display.working || display.unread ? (
        <span {...stylex.props(styles.status)}>
          <SessionRowStatusIndicator
            isWaitingPermission={display.waiting}
            isWorking={display.working}
            hasUnreadMessages={display.unread}
          />
        </span>
      ) : null}
      <button
        type="button"
        {...stylex.props(styles.title, display.done && styles.done)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => props.onOpen(event)}
      >
        {display.title || t('today.untitledSession', 'Untitled conversation')}
      </button>
    </span>
  );
}
