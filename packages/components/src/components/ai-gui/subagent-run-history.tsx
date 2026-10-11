import { Fragment, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  buildAssistantTurnRenderBlocks,
  type AssistantActivitySummary,
} from './assistant-turn-render-blocks';
import type { SubagentTask } from './subagent-task-state';
import { styles } from './subagent-run-history.stylex';

type RunItem = NonNullable<SubagentTask['run']>['items'][number];

export type SubagentActivityHeaderProps = {
  id: string;
  summary: AssistantActivitySummary;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

/** The host supplies its conversation renderers; dialog rows never enter conversation search. */
export function SubagentRunMessageList({
  task,
  renderItem,
  renderActivityHeader,
}: {
  task: SubagentTask;
  renderItem: (item: RunItem, streaming: boolean) => ReactNode;
  renderActivityHeader: (props: SubagentActivityHeaderProps) => ReactNode;
}) {
  const items = task.run?.items;
  const blocks = useMemo(
    () => buildAssistantTurnRenderBlocks(`subagent:${task.taskId}`, items ?? []),
    [items, task.taskId]
  );
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const live = task.run?.snapshot.state === 'running' || task.run?.snapshot.state === 'pending';
  const renderEntry = (item: RunItem, index: number) =>
    renderItem(item, live && index === (items?.length ?? 0) - 1);

  return (
    <div {...stylex.props(styles.list)}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'activity_group') {
          const expanded = expandedGroups[block.key] ?? true;
          return (
            <Fragment key={block.key}>
              {renderActivityHeader({
                id: block.key,
                summary: block.summary,
                expanded,
                onExpandedChange: (next) =>
                  setExpandedGroups((current) => ({ ...current, [block.key]: next })),
              })}
              {expanded
                ? block.entries.map((entry) => (
                    <div
                      key={
                        entry.content.type === 'tool_call'
                          ? `tool:${entry.content.toolCallId}`
                          : `thought:${entry.itemIndex}`
                      }
                      {...stylex.props(styles.row)}
                    >
                      {renderEntry(entry.content, entry.itemIndex)}
                    </div>
                  ))
                : null}
            </Fragment>
          );
        }
        const item = block.entry.content;
        // Run transcripts retain only these four variants; tools with process
        // status and plan-mode kinds remain standalone content in the shared layout.
        if (
          item.type !== 'text' &&
          item.type !== 'thought' &&
          item.type !== 'tool_call' &&
          item.type !== 'plan'
        )
          return null;
        return (
          <div
            key={block.key}
            {...stylex.props(
              styles.row,
              item.type === 'text' ? styles.prose : styles.surface,
              blockIndex === 0 && styles.first
            )}
          >
            {renderEntry(item, block.entry.itemIndex)}
          </div>
        );
      })}
    </div>
  );
}
