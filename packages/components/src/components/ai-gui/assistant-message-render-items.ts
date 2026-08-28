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

const appendSegmentWithPlansLast = (
  target: AssistantMessageRenderSeed[],
  segment: readonly AssistantMessageRenderSeed[]
): void => {
  for (const item of segment) {
    if (item.content.type !== 'proposed_plan') {
      target.push(item);
    }
  }
  for (const item of segment) {
    if (item.content.type === 'proposed_plan') {
      target.push(item);
    }
  }
};

export const buildAssistantMessageRenderItems = (
  items: readonly MessageContent[]
): AssistantMessageRenderItem[] => {
  const visibleItems = items.flatMap((content, itemIndex) =>
    isSubagentTaskItem(content) || isHiddenCompletedActivity(content)
      ? []
      : [{ content, itemIndex }]
  );

  if (!visibleItems.some((item) => item.content.type === 'proposed_plan')) {
    return withDisplayIndexes(visibleItems);
  }

  // A proposed plan should finish the planning region, not the whole assistant
  // turn. Codex emits it before the switch_mode approval and then continues the
  // same ACP prompt with implementation work. A global "plans last" partition
  // therefore put that work above the plan. Keep the existing plan-last
  // presentation independently inside every switch-delimited region instead.
  const ordered: AssistantMessageRenderSeed[] = [];
  let segment: AssistantMessageRenderSeed[] = [];
  for (const item of visibleItems) {
    if (item.content.type === 'tool_call' && item.content.kind === 'switch_mode') {
      appendSegmentWithPlansLast(ordered, segment);
      segment = [];
      ordered.push(item);
      continue;
    }
    segment.push(item);
  }
  appendSegmentWithPlansLast(ordered, segment);

  return withDisplayIndexes(ordered);
};
