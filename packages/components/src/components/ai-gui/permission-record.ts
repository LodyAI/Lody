import type { MessageContent } from '@lody/shared';

type PermissionRequest = NonNullable<
  Extract<MessageContent, { type: 'tool_call' }>['permissionRequest']
>;

/**
 * How a permission request should read in conversation scrollback.
 *
 * `pending` is still a decision the reader can make, so it keeps the full card.
 * A SETTLED one is a fact: re-rendering the header, every option, and the
 * selection re-asks a question that was already answered, and made the record
 * the heaviest object in the turn. It collapses to one line — the outcome and
 * what was chosen. A `withdrawn` request (the turn was interrupted before
 * anyone answered) recorded nothing, so it shows nothing.
 */
export type PermissionRecord =
  | { kind: 'pending' }
  | { kind: 'withdrawn' }
  | { kind: 'settled'; allowed: boolean; optionName: string | null };

export const resolvePermissionRecord = (permission: PermissionRequest): PermissionRecord => {
  const outcome = permission.outcome;
  if (!outcome) return { kind: 'pending' };
  if (outcome.outcome === 'cancelled') return { kind: 'withdrawn' };

  const selected = permission.options.find((option) => option.optionId === outcome.optionId);
  const optionName = selected?.name?.trim();
  return {
    kind: 'settled',
    // An unknown option id (stale history) reads as allowed, matching the
    // card's own assumption rather than inventing a denial.
    allowed: selected ? selected.kind?.startsWith('allow') === true : true,
    optionName: optionName ? optionName : null,
  };
};
