import { memo, useCallback, useMemo } from 'react';
import { Pin, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Button } from '@lody/ui/button';
import type { SessionHistoryParsed } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  messageButton: {
    minWidth: 'calc(var(--spacing) * 0)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    cursor: 'pointer',
  },
  banner: {
    position: 'relative',
    zIndex: 10,
    width: '100%',
    borderBottomWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.5)',
    backgroundColor: 'hsl(var(--muted) / 0.2)',
  },
  column: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  pinIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  closeIcon: { width: themeSpace[3.5], height: themeSpace[3.5] },
});

interface SessionPinProps {
  pinnedHistoryId: string | null;
  /** The pinned user turn, hydrated by the caller through the conversation view. */
  pinnedMessage: SessionHistoryParsed | null;
  onUnpin: () => void;
  onScrollToMessage?: (historyId: string) => void;
}

/** Extract plain text from a parsed history entry's items. */
function getTextFromHistory(entry: SessionHistoryParsed): string {
  return entry.items
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join(' ')
    .trim();
}

/**
 * Static pin banner below the tab bar.
 * Only rendered when user has explicitly pinned a message.
 */
export const SessionPin = memo(function SessionPin({
  pinnedHistoryId,
  pinnedMessage,
  onUnpin,
  onScrollToMessage,
}: SessionPinProps) {
  const { t } = useTranslation();

  const pinnedEntry = useMemo(() => {
    if (!pinnedHistoryId || !pinnedMessage) return null;
    return pinnedMessage.id === pinnedHistoryId && pinnedMessage.role === 'user'
      ? pinnedMessage
      : null;
  }, [pinnedHistoryId, pinnedMessage]);

  const pinnedText = useMemo(() => {
    if (!pinnedEntry) return '';
    return getTextFromHistory(pinnedEntry);
  }, [pinnedEntry]);

  const handleClick = useCallback(() => {
    if (pinnedEntry && onScrollToMessage) {
      onScrollToMessage(pinnedEntry.id);
    }
  }, [pinnedEntry, onScrollToMessage]);

  if (!pinnedEntry || !pinnedText) {
    return null;
  }

  return (
    <div {...stylex.props(styles.banner)}>
      <ConversationColumn {...stylex.props(styles.column)}>
        <Pin {...stylex.props(styles.pinIcon)} />
        <Button
          type="button"
          variant="ghost"
          className={clsx(stylex.props(styles.messageButton).className, 'flex-1 justify-start')}
          onClick={handleClick}
          title={pinnedText}
        >
          {pinnedText}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          onClick={onUnpin}
          aria-label={t('sessions.pin.unpin', 'Unpin message')}
        >
          <X {...stylex.props(styles.closeIcon)} />
        </Button>
      </ConversationColumn>
    </div>
  );
});

SessionPin.displayName = 'SessionPin';
