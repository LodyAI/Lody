import { useCallback, useSyncExternalStore } from 'react';

/**
 * Touch has no hover, so mobile message actions (copy, fork, edit, pin, turn
 * info) rest hidden and a tap on the message reveals them. One message at a
 * time: revealing another hides the previous one, and tapping the same message
 * again hides it. Rows subscribe to their own boolean, so a tap re-renders only
 * the two rows whose state changed.
 */
let revealedMessageId: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setRevealedMessageId = (next: string | null) => {
  if (revealedMessageId === next) return;
  revealedMessageId = next;
  for (const listener of listeners) listener();
};

export const toggleMobileMessageActions = (messageId: string) => {
  setRevealedMessageId(revealedMessageId === messageId ? null : messageId);
};

export const useMobileMessageActionsRevealed = (messageId: string): boolean => {
  const getSnapshot = useCallback(() => revealedMessageId === messageId, [messageId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const INTERACTIVE_TARGET_SELECTOR =
  'a, button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"], [data-assistant-turn-actions], [data-user-message-actions]';

/**
 * A tap on the message body toggles its actions; a tap that lands on a control,
 * a link, or the action bar itself does that control's job instead, and a tap
 * that ends a text selection leaves the actions alone.
 */
export const isMessageActionsToggleTap = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest(INTERACTIVE_TARGET_SELECTOR)) return false;
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  return !selection || selection.isCollapsed;
};
