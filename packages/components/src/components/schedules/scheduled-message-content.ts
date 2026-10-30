import { scheduledMessagePrompt, type ScheduleDocument } from '@lody/shared';

/**
 * The human-authored text a scheduled message shows in lists and queue rows.
 * A message may still be syncing, or contain only attachments; callers fall
 * back to the stored title in both cases.
 */
export function scheduledMessageText(
  document: Pick<ScheduleDocument, 'message'> | null | undefined
): string | undefined {
  const text = document?.message ? scheduledMessagePrompt(document.message).trim() : '';
  return text || undefined;
}

export function scheduledMessageDisplayText(
  document: Pick<ScheduleDocument, 'message'> | null | undefined,
  fallback: string
): string {
  return scheduledMessageText(document) ?? fallback;
}
