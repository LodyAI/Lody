import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId, SessionDoc } from '@lody/shared';
import { buildChatVirtualRows } from '../src/components/ai-gui/view';
import { collectSubagentTasks } from '../src/components/ai-gui/subagent-task-panel';
import { getMessageItemPrefix } from '../src/lib/session-chat-search';
import {
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_PLAN_VALUE,
} from '../src/components/shared/acp-selector-options';
import {
  disableCodexPlanMode,
  findLatestCompletedCodexProposedPlan,
  isCodexPlanModeEnabled,
  shouldShowCodexProposedPlanDecision,
} from '../src/lib/codex-plan-decision';
import {
  hasUnansweredPlanApproval,
  resolvePlanExitMarkdown,
} from '../src/components/ai-gui/plan-surface';

describe('plan-turn-virtual-rows', () => {
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

  const buildRows = (
    items: MessageContent[],
    finished: boolean,
    expanded?: boolean,
    search = false
  ) =>
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
      ...(expanded !== undefined
        ? {
            selectionLayouts: new Map([
              [
                'assistant-1',
                {
                  finished,
                  activeSearchBlockId: search ? getMessageItemPrefix('assistant-1', 0) : null,
                  expandState: {
                    expandedWorkedGroups: { 'segment:assistant-1:0': expanded },
                    expandedGroups: {},
                    expandedByIndex: {},
                    planOpen: false,
                  },
                },
              ],
            ]),
          }
        : {}),
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
  const visibleContentKinds = (rows: ReturnType<typeof buildRows>, includeDetails = false) =>
    rows.flatMap((row) => {
      if (row.type !== 'assistant' || (!includeDetails && row.isWorkedDetail)) return [];
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

      expect(workedHeaders(rows).map((header) => header.expanded)).toEqual([true, true]);
      expect(visibleContentKinds(rows, true)).toEqual([
        'worked_group_header',
        'activity_group_header',
        'content:tool_call',
        'worked_group_header',
        // The post-plan thought and edit share one disclosure.
        'activity_group_header',
        'content:text',
      ]);
      const activityGroups = rows.flatMap((row) =>
        row.type === 'assistant' && row.content.kind === 'activity_group_header'
          ? [row.content.block.entries.map((entry) => entry.content)]
          : []
      );
      expect(activityGroups).toEqual([planTurnItems.slice(0, 2), planTurnItems.slice(3, 5)]);
    });
  });

  describe('phased text in finished turns', () => {
    const phased = (text: string, messagePhase: 'commentary' | 'final_answer'): MessageContent =>
      ({ type: 'text', text, messagePhase }) as MessageContent;

    it('places the header before commentary and restores chronological rows when expanded', () => {
      const items = [
        phased('Inspecting', 'commentary'),
        tool('read', 'read'),
        answerText('Unphased'),
        phased('Checking', 'commentary'),
        phased('Done', 'final_answer'),
      ];
      expect(visibleContentKinds(buildRows(items, true))).toEqual([
        'worked_group_header',
        'content:text',
        'content:text',
        'content:text',
      ]);
      const rows = buildRows(items, true, true);
      const ordered = rows.flatMap((row) => {
        if (row.type !== 'assistant') return [];
        if (
          row.content.kind === 'worked_group_header' ||
          row.content.kind === 'activity_group_header'
        )
          return [row.content.kind];
        if (row.content.kind === 'content' && row.content.block.entry.content.type === 'text')
          return [row.content.block.entry.content.text];
        return [];
      });
      expect(ordered).toEqual([
        'worked_group_header',
        'Inspecting',
        'activity_group_header',
        'Unphased',
        'Checking',
        'Done',
      ]);
    });

    it('allows manual live folding and restores interrupted progress', () => {
      const items = [
        phased('Inspecting', 'commentary'),
        tool('read', 'read'),
        answerText('Unknown'),
      ];
      expect(workedHeaders(buildRows(items, false))[0]?.expanded).toBe(true);
      expect(visibleContentKinds(buildRows(items, false, false), true)).toEqual([
        'worked_group_header',
        'content:text',
      ]);
      expect(visibleContentKinds(buildRows(items.slice(0, 2), true, false), true)).toEqual([
        'content:text',
        'activity_group_header',
      ]);
      expect(visibleContentKinds(buildRows(items, false, true), true)).toEqual([
        'worked_group_header',
        'content:text',
        'activity_group_header',
        'content:text',
      ]);
      expect(visibleContentKinds(buildRows(items, false, false, true), true)).toEqual([
        'worked_group_header',
        'content:text',
        'activity_group_header',
        'content:text',
      ]);
      expect(
        visibleContentKinds(
          buildRows([...items, phased('Done', 'final_answer')], false, false),
          true
        )
      ).toEqual(['worked_group_header', 'content:text', 'content:text']);
    });

    it('keeps interrupted work open and folds it when an unphased answer arrives', () => {
      const items = [phased('Inspecting', 'commentary'), tool('read', 'read')];
      expect(visibleContentKinds(buildRows(items, false), true)).toEqual([
        'worked_group_header',
        'content:text',
        'activity_group_header',
      ]);
      expect(visibleContentKinds(buildRows(items, true))).toEqual([
        'content:text',
        'activity_group_header',
      ]);
      expect(visibleContentKinds(buildRows([...items, answerText('Unknown phase')], true))).toEqual(
        ['worked_group_header', 'content:text']
      );
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
      expect(
        visible.map((row) => (row.type === 'assistant' ? row.content.kind : row.type))
      ).toEqual(['worked_group_header', 'content', 'subagent_tasks']);
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
  });
});

describe('codex-plan-decision', () => {
  const makeHistory = (items: unknown[], id = 'assistant-turn'): SessionDoc['history'] =>
    [
      {
        id,
        $cid: id,
        role: 'assistant',
        items,
        timestamp: new Date().toISOString(),
        fileDiff: [],
        read: false,
      },
    ] as unknown as SessionDoc['history'];

  describe('codex plan decision helpers', () => {
    it('disables Core planning without changing permission, model, or reasoning', () => {
      const config = { plan_mode: true, mode: 'agent', reasoning_effort: 'high' };
      expect(isCodexPlanModeEnabled(config)).toBe(true);
      const disabled = disableCodexPlanMode(config);
      expect(disabled).toEqual({ ...config, plan_mode: false });
      expect(isCodexPlanModeEnabled(disabled)).toBe(false);
      expect(isCodexPlanModeEnabled({ plan_mode: false, collaboration_mode: 'plan' })).toBe(false);
    });

    it('keeps the plan entry id when a newer plain assistant reply exists', () => {
      const history = [
        ...makeHistory(
          [
            {
              type: 'proposed_plan',
              turnId: 'turn-plan',
              markdown: '# Final plan',
              status: 'completed',
              isLatest: true,
            },
          ],
          'plan-reply'
        ),
        ...makeHistory([{ type: 'text', text: 'A later normal reply' }], 'plain-reply'),
      ] as SessionDoc['history'];

      expect(findLatestCompletedCodexProposedPlan(history)).toEqual({
        key: 'plan-reply:turn-plan',
        entryId: 'plan-reply',
        turnId: 'turn-plan',
      });
    });

    it('keeps the completed plan decision visible after plan mode is manually disabled', () => {
      const plan = findLatestCompletedCodexProposedPlan(
        makeHistory([
          {
            type: 'proposed_plan',
            turnId: 'turn-completed',
            markdown: '# Final plan',
            status: 'completed',
            isLatest: true,
          },
        ])
      );
      const config = disableCodexPlanMode({
        [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_PLAN_VALUE,
      });

      expect(isCodexPlanModeEnabled(config)).toBe(false);
      expect(
        shouldShowCodexProposedPlanDecision({
          plan,
          dismissed: false,
          pending: false,
          isCodexSession: true,
          isSessionIdle: true,
          isSessionActive: false,
          isAgentBusy: false,
        })
      ).toBe(true);
    });
  });
});

describe('plan-surface', () => {
  type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

  const toolCall = (overrides: Partial<ToolCallMessage>): ToolCallMessage =>
    ({
      type: 'tool_call',
      toolCallId: 't',
      kind: 'switch_mode',
      status: 'completed',
      ...overrides,
    }) as ToolCallMessage;

  const request = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'r',
    options: [{ optionId: 'allow', name: 'Yes', kind: 'allow_once' }],
    ...overrides,
  });

  /**
   * The bundled adapters put the plan in different places. These are the shapes
   * they actually emit, so a regression here means one agent's plan silently
   * stops rendering (or renders twice).
   */
  describe('resolvePlanExitMarkdown', () => {
    it("reads Claude's and Kimi's card-carried content block", () => {
      expect(
        resolvePlanExitMarkdown(
          toolCall({
            content: [{ type: 'content', content: { type: 'text', text: '# Plan\n1. Go' } }],
          })
        )
      ).toBe('# Plan\n1. Go');
    });

    it("reads Codex's rawInput carrier", () => {
      expect(resolvePlanExitMarkdown(toolCall({ rawInput: { plan: '# Codex plan' } }))).toBe(
        '# Codex plan'
      );
    });

    it.each([
      { status: 'failed' as const, result: "The user doesn't want to proceed with this tool use." },
      { status: 'completed' as const, result: 'User has approved your plan.' },
    ])(
      'keeps the submitted plan after a $status result replaces card content',
      ({ status, result }) => {
        const markdown = '# Plan\n1. Keep the tests.\n2. Update the parser.';
        const pending = toolCall({
          status: 'pending',
          rawInput: { plan: markdown },
          content: [{ type: 'content', content: { type: 'text', text: markdown } }],
        });
        expect(resolvePlanExitMarkdown(pending)).toBe(markdown);

        // ACP replaces content but retains rawInput when the result omits it.
        const settled = toolCall({
          ...pending,
          status,
          content: [{ type: 'content', content: { type: 'text', text: result } }],
          rawOutput: result,
        });
        expect(resolvePlanExitMarkdown(settled)).toBe(markdown);
        // A hydrated historical card has no component-local copy of the plan.
        expect(resolvePlanExitMarkdown(JSON.parse(JSON.stringify(settled)))).toBe(markdown);
        expect(resolvePlanExitMarkdown({ ...settled, content: [] })).toBe(markdown);
      }
    );

    it("takes only the first block, so Kimi's action summary stays out of the plan", () => {
      // Kimi builds `[plan, "Requesting approval to <action>"]`; joining pasted
      // the summary into the plan body.
      expect(
        resolvePlanExitMarkdown(
          toolCall({
            content: [
              { type: 'content', content: { type: 'text', text: 'Plan saved to: /p\n\n# Plan' } },
              { type: 'content', content: { type: 'text', text: 'Requesting approval to run' } },
            ],
          })
        )
      ).toBe('Plan saved to: /p\n\n# Plan');
    });
  });

  describe('hasUnansweredPlanApproval', () => {
    const planExit = (permissionRequest: unknown): MessageContent =>
      ({
        type: 'tool_call',
        toolCallId: 'plan-exit',
        kind: 'switch_mode',
        status: 'pending',
        permissionRequest,
      }) as MessageContent;

    it('holds the plan open while the approval is unanswered', () => {
      expect(hasUnansweredPlanApproval([planExit(request())])).toBe(true);
    });

    it('lets the plan clamp once the reader has answered', () => {
      expect(
        hasUnansweredPlanApproval([
          planExit(request({ outcome: { outcome: 'selected', optionId: 'allow' } })),
        ])
      ).toBe(false);
    });

    it('treats a withdrawn request as answered, not pending', () => {
      // A cancelled request has nothing left to decide, so it must not pin the
      // plan open for the rest of the session.
      expect(
        hasUnansweredPlanApproval([planExit(request({ outcome: { outcome: 'cancelled' } }))])
      ).toBe(false);
    });
  });
});
