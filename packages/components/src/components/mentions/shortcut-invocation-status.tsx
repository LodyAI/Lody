import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptShortcutScope } from '@lody/shared/prompt-shortcuts';
import { useMentionContext } from '@/ui/mention';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import { shortcutAvailabilityMessage } from './mention-prompt-shortcut-source';
import { isShortcutMention, shortcutInvocationAvailability } from './shortcut-composer-state';

/**
 * Why an inserted Shortcut cannot be sent from here.
 *
 * A chip is a frozen snapshot, so the thing that changes under it is the
 * context: the machine went offline, the project changed, a reference lost its
 * permission. Re-checked against live state on every render rather than stored
 * on the chip, and reported up so the send button and this notice agree.
 */
export function ShortcutInvocationStatus({
  scope = {},
  onAvailabilityChange,
}: {
  scope?: PromptShortcutScope;
  onAvailabilityChange?: (blocked: boolean) => void;
}) {
  const context = useMentionContext('ShortcutInvocationStatus');
  const { runtime } = usePromptShortcuts();
  const { t } = useTranslation();
  const chips = useMemo(() => context.mentions.filter(isShortcutMention), [context.mentions]);
  const unavailable = chips
    .map(({ data }) => ({
      name: data.snapshot.name,
      availability: shortcutInvocationAvailability(
        data,
        runtime ? { userId: runtime.userId, workspaceId: runtime.workspaceId, scope } : null
      ),
    }))
    .filter(({ availability }) => availability.kind !== 'available');
  const blocked = unavailable.length > 0;
  useEffect(() => {
    onAvailabilityChange?.(blocked);
  }, [blocked, onAvailabilityChange]);
  return (
    <>
      {unavailable.map(({ name, availability }, index) => (
        <p key={index} role="status" className="mt-2 text-xs text-muted-foreground">
          {name}: {shortcutAvailabilityMessage(availability, t)}
        </p>
      ))}
    </>
  );
}
