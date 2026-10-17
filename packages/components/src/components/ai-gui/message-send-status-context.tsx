import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Context for tracking which user messages are still being synced to the server.
 * The set contains message IDs that have been written to local CRDT but not yet
 * confirmed by the server via waitUntilSynced().
 */
export const MessageSendStatusContext = createContext<ReadonlySet<string>>(new Set());

/**
 * Returns true after 500ms of sending, avoiding flashes for fast delivery.
 * Ready local inputs supply their owner-confirmation state because control-doc
 * synchronization alone does not confirm Roost history delivery.
 */
export function useIsMessageSendingVisible(messageId: string, sending?: boolean): boolean {
  const sendingIds = useContext(MessageSendStatusContext);
  const isSending = sending ?? sendingIds.has(messageId);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isSending) {
      setVisible(false);
      return undefined;
    }

    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, [isSending]);

  return isSending && visible;
}
