import type { MessageContent } from '@lody/shared';

type AssistantMessageRenderSeed = {
  content: MessageContent;
  itemIndex: number;
};

export type AssistantMessageRenderItem = AssistantMessageRenderSeed & {
  displayIndex: number;
};

export const isSubagentTaskItem = (item: MessageContent): boolean => item.type === 'subagent_task';

const isHiddenCompletedActivity = (item: MessageContent): boolean =>
  item.type === 'tool_call' &&
  item.activityKind === 'codex_retry' &&
  item.status !== 'pending' &&
  item.status !== 'in_progress';

const withDisplayIndexes = (
  items: readonly AssistantMessageRenderSeed[]
): AssistantMessageRenderItem[] =>
  items.map((item, displayIndex) => ({
    ...item,
    displayIndex,
  }));

/**
 * Attachments the agent produced. In a turn that ALSO carries a plan they sort
 * below it: a plan runs long, and a file card stranded above one is a small
 * thing the reader has to find in the middle of a wall of markdown. Below the
 * plan it is always in the same place — the last thing in the turn.
 *
 * Images travel with files. Splitting them (images above the plan, files below)
 * would read as two unrelated attachment areas separated by the plan.
 */
const AGENT_ATTACHMENT_TYPES = new Set<MessageContent['type']>(['file', 'image', 'image_group']);

/** The plan-approval card that closes a plan (ACP kind, never a title). */
const isPlanExitSeed = (seed: AssistantMessageRenderSeed): boolean =>
  seed.content.type === 'tool_call' && seed.content.kind === 'switch_mode';

export const buildAssistantMessageRenderItems = (
  items: readonly MessageContent[]
): AssistantMessageRenderItem[] => {
  const visibleItems = items.flatMap((content, itemIndex) =>
    isSubagentTaskItem(content) || isHiddenCompletedActivity(content)
      ? []
      : [{ content, itemIndex }]
  );

  // No plan, no reordering: a turn's natural order is the right one, and moving
  // attachments on their own would separate them from the answer they belong to.
  if (!visibleItems.some((item) => item.content.type === 'proposed_plan')) {
    return withDisplayIndexes(visibleItems);
  }

  const rest: AssistantMessageRenderSeed[] = [];
  const plans: AssistantMessageRenderSeed[] = [];
  const attachments: AssistantMessageRenderSeed[] = [];
  for (const item of visibleItems) {
    if (item.content.type === 'proposed_plan') {
      plans.push(item);
    } else if (AGENT_ATTACHMENT_TYPES.has(item.content.type)) {
      attachments.push(item);
    } else {
      rest.push(item);
    }
  }

  /* The plan and the card that approves it are ONE thing, so the plan renders
     immediately BEFORE its approval rather than at the end of the turn: read the
     plan, then read the decision. Codex is why this matters — it keeps the plan
     in a separate `proposed_plan` item and puts nothing readable in the card, so
     unmoved the two halves of one question sat a whole implementation apart.
     Without an approval card (the plan is still being drafted) the plan stays at
     the end, which is where a growing plan belongs. */
  const planExitIndex = rest.findIndex(isPlanExitSeed);
  const ordered =
    planExitIndex === -1
      ? [...rest, ...plans]
      : [...rest.slice(0, planExitIndex), ...plans, ...rest.slice(planExitIndex)];

  // `itemIndex` stays the ORIGINAL history index through the reorder — image
  // gallery keys, search block ids, and expansion state are keyed on it.
  return withDisplayIndexes([...ordered, ...attachments]);
};
