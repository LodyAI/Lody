import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';

import { buildChatVirtualRows } from '../src/components/ai-gui/view';
import { collectSubagentTasks } from '../src/components/ai-gui/subagent-task-panel';

/**
 * End of the wiring, not just the layout helper: `buildChatVirtualRows` is what
 * actually emits the virtual rows the conversation renders, so this is where
 * "an approved plan produces a visible region of its own" is provable.
 *
 * The turn shape mirrors what the bundled adapters emit. A plan is approved
 * from inside a RUNNING turn (Claude's `ExitPlanMode`, Codex's plan review,
 * both ACP kind `switch_mode`), so ONE finished assistant turn carries the
 * pre-plan exploration, the plan, and the whole implementation.
 */
const tool = (
  toolCallId: string,
  kind: Extract<MessageContent, { type: 'tool_call' }>['kind'],
  overrides: Partial<Extract<MessageContent, { type: 'tool_call' }>> = {}
): MessageContent =>
  ({ type: 'tool_call', toolCallId, kind, status: 'completed', ...overrides }) as MessageContent;

const planTurnItems: MessageContent[] = [
  tool('read-1', 'read', { locations: [{ path: 'src/a.ts' }] }),
  tool('grep-1', 'search'),
  tool('plan-exit-1', 'switch_mode', {
    // Claude renders "Ready to code?" and Codex "Implement this plan?"; the cut
    // keys on `kind`, never the title.
    title: 'Ready to code?',
    content: [{ type: 'content', content: { type: 'text', text: '# Plan\n1. Do the thing' } }],
  } as Partial<Extract<MessageContent, { type: 'tool_call' }>>),
  { type: 'thought', text: 'Start with the parser.' } as MessageContent,
  tool('edit-1', 'edit', { locations: [{ path: 'src/a.ts' }] }),
  { type: 'text', text: 'Done, changed 1 file.' } as MessageContent,
];

const task = (
  taskId: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
): MessageContent =>
  ({
    type: 'subagent_task',
    taskId,
    taskKind: 'background',
    actor: 'Bash',
    status,
    description: `Synthetic ${taskId}`,
    isBackgrounded: true,
  }) as MessageContent;
const normalizedTask = (
  taskId: string,
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
): MessageContent =>
  ({
    ...(task(taskId, 'completed') as Extract<MessageContent, { type: 'subagent_task' }>),
    run: {
      sessionId: `run-${taskId}`,
      snapshot: {
        state,
        support: { stream: [], progress: false, outputRead: 'none', cancel: false },
      },
      items: [],
    },
  }) as MessageContent;
const answerText = (value: string): MessageContent =>
  ({ type: 'text', text: value }) as MessageContent;

const assistantMessage = (items: MessageContent[], finished: boolean): SessionHistoryParsed =>
  ({
    id: 'assistant-1',
    role: 'assistant',
    items,
    timestamp: '2026-08-10T00:00:00.000Z',
    ...(finished ? { finished: true, endedAt: Date.parse('2026-08-10T00:05:00.000Z') } : {}),
  }) as unknown as SessionHistoryParsed;

const buildRows = (items: MessageContent[], finished: boolean) =>
  buildChatVirtualRows({
    items: [
      {
        type: 'message',
        sessionId: 'session-1' as SessionId,
        message: assistantMessage(items, finished),
      },
    ],
    lastAssistantMessageId: 'assistant-1',
    expansionVersion: 0,
  });

const taskIdsInVisibleRow = (rows: ReturnType<typeof buildRows>) => {
  const row = rows.find(
    (candidate) => candidate.type === 'assistant' && candidate.content.kind === 'subagent_tasks'
  );
  return row?.type === 'assistant'
    ? collectSubagentTasks(row.item.message.items).map(({ taskId }) => taskId)
    : [];
};

const workedHeaders = (rows: ReturnType<typeof buildRows>) =>
  rows.flatMap((row) =>
    row.type === 'assistant' && row.content.kind === 'worked_group_header'
      ? [{ key: row.key, durationMs: row.content.durationMs, expanded: row.content.expanded }]
      : []
  );

/**
 * The rows a reader actually sees top to bottom, minus the turn's own footer
 * (copy/actions — always last, not part of the plan/execution question).
 */
const visibleContentKinds = (rows: ReturnType<typeof buildRows>) =>
  rows.flatMap((row) => {
    if (row.type !== 'assistant' || row.isWorkedDetail) return [];
    if (row.content.kind === 'footer') return [];
    if (row.content.kind !== 'content') return [row.content.kind];
    return [
      row.content.block.kind === 'content'
        ? `content:${row.content.block.entry.content.type}`
        : 'content:activity_group',
    ];
  });

describe('approved plan renders its own region', () => {
  it('gives the implementation a second collapsible region under the plan', () => {
    const rows = buildRows(planTurnItems, true);

    // Two independently foldable regions, not one.
    const headers = workedHeaders(rows);
    expect(headers).toHaveLength(2);

    // Only the LAST region may claim the turn duration; the plan region falls
    // back to the "Finished working" copy.
    expect(headers[0]?.durationMs).toBeNull();
    expect(headers[1]?.durationMs).toBe(5 * 60 * 1000);

    // Distinct row keys, or the VList would desync on duplicate keys.
    expect(headers[0]?.key).not.toBe(headers[1]?.key);

    // Reading top to bottom: the pre-plan work folds, the plan card stays put,
    // the implementation gets its own fold, and the answer stays visible.
    expect(visibleContentKinds(rows)).toEqual([
      'worked_group_header', // pre-plan exploration
      'content:tool_call', // the plan / approval card
      'worked_group_header', // the approved implementation
      'content:text', // final answer
    ]);
  });

  it('sorts agent attachments below the plan and keeps the answer visible above them', () => {
    // A plan runs long, so an attachment above it is stranded mid-markdown.
    // Emitted attachment-first; rendered plan-first.
    const rows = buildRows(
      [
        tool('read-1', 'read'),
        {
          type: 'file',
          fileId: 'f1',
          fileName: 'report.md',
          mimeType: 'text/markdown',
          sizeBytes: 10,
          sha256: 'a',
          textPreview: true,
          uploadedAt: 0,
          transport: 'r2',
        },
        { type: 'text', text: 'Here is the plan and the report.' },
        {
          type: 'proposed_plan',
          turnId: 'turn-plan',
          markdown: '# Plan',
          status: 'completed',
          isLatest: true,
        },
      ] as unknown as MessageContent[],
      true
    );

    // The answer keeps its place above the tail: a turn ending in a `file` used
    // to report no visible answer, which folded the answer into "Worked for …".
    expect(visibleContentKinds(rows)).toEqual([
      'worked_group_header',
      'content:text',
      'content:proposed_plan',
      'content:file',
    ]);
  });

  it('keeps every step visible while the turn is still streaming', () => {
    const rows = buildRows(planTurnItems, false);

    expect(workedHeaders(rows)).toHaveLength(0);
    expect(visibleContentKinds(rows)).toEqual([
      'activity_group_header',
      'content:tool_call',
      'activity_group_header',
      'content:text',
    ]);
  });

  it('leaves an ordinary turn with exactly one region', () => {
    const rows = buildRows(
      [tool('read-1', 'read'), tool('edit-1', 'edit'), { type: 'text', text: 'Done.' }],
      true
    );

    expect(workedHeaders(rows)).toHaveLength(1);
    expect(visibleContentKinds(rows)).toEqual(['worked_group_header', 'content:text']);
  });

  it('does not emit an empty region when the turn ends on the plan card', () => {
    const rows = buildRows(
      [tool('read-1', 'read'), tool('plan-exit-1', 'switch_mode', { title: 'Ready to code?' })],
      true
    );

    expect(workedHeaders(rows)).toHaveLength(1);
    expect(visibleContentKinds(rows)).toEqual(['worked_group_header', 'content:tool_call']);
  });
});

describe('finished turns with background tasks', () => {
  it('keeps the task panel after the answer while any task is running', () => {
    const items = [
      tool('build', 'execute'),
      answerText('The answer is ready.'),
      task('task-a', 'in_progress'),
      task('task-b', 'completed'),
      task('task-c', 'pending'),
      normalizedTask('task-d', 'running'),
    ];
    const rows = buildRows(items, true);
    const visible = rows.filter(
      (row) => row.type === 'assistant' && row.content.kind !== 'footer' && !row.isWorkedDetail
    );
    const taskRowIndex = visible.findIndex(
      (row) => row.type === 'assistant' && row.content.kind === 'subagent_tasks'
    );
    const answerRowIndex = visible.findIndex(
      (row) =>
        row.type === 'assistant' &&
        row.content.kind === 'content' &&
        row.content.block.kind === 'content' &&
        row.content.block.entry.content.type === 'text'
    );

    expect(taskRowIndex).toBeGreaterThan(answerRowIndex);
    expect(visible.map((row) => (row.type === 'assistant' ? row.content.kind : row.type))).toEqual([
      'worked_group_header',
      'content',
      'subagent_tasks',
    ]);
    expect(taskIdsInVisibleRow(rows)).toEqual(['task-a', 'task-b', 'task-c', 'task-d']);
  });

  it('keeps terminal tasks folded into worked details by default', () => {
    const rows = buildRows(
      [
        tool('build', 'execute'),
        answerText('The answer is ready.'),
        task('task-a', 'completed'),
        task('task-b', 'failed'),
        normalizedTask('task-c', 'cancelled'),
        normalizedTask('task-d', 'unknown'),
      ],
      true
    );

    expect(visibleContentKinds(rows)).toEqual(['worked_group_header', 'content:text']);
  });

  it('rebuilds the same visible task row and task order from reloaded history', () => {
    const createHistory = () =>
      assistantMessage(
        [
          tool('build', 'execute'),
          answerText('The answer is ready.'),
          task('task-a', 'in_progress'),
          task('task-b', 'in_progress'),
        ],
        true
      );
    const buildHistoryRows = (message: SessionHistoryParsed) =>
      buildChatVirtualRows({
        items: [{ type: 'message', sessionId: 'session-1' as SessionId, message }],
        lastAssistantMessageId: 'assistant-1',
        expansionVersion: 0,
      });
    const firstRows = buildHistoryRows(createHistory());
    const loadedRows = buildHistoryRows(createHistory());
    const taskRow = (rows: ReturnType<typeof buildRows>) =>
      rows.find((row) => row.type === 'assistant' && row.content.kind === 'subagent_tasks');

    expect(taskRow(firstRows)?.key).toBe('assistant:assistant-1:subagent-tasks');
    expect(taskRow(loadedRows)?.key).toBe(taskRow(firstRows)?.key);
    expect(taskIdsInVisibleRow(firstRows)).toEqual(['task-a', 'task-b']);
    expect(taskIdsInVisibleRow(loadedRows)).toEqual(taskIdsInVisibleRow(firstRows));
    expect(visibleContentKinds(firstRows)).toEqual(visibleContentKinds(loadedRows));
  });
});
