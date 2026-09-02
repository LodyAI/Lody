/**
 * Left-edge alignment guard for a streaming assistant turn.
 *
 * Every row of one turn — answer prose, the "Ran N commands" activity headers,
 * the subagent task card, and the trailing activity indicator — is a sibling in
 * the same `ConversationColumn`, so they must all start on the column's content
 * edge. A per-row horizontal pad on any one of them reads as an accidental
 * indent (the prose used to carry `sm:px-2` and sat 8px right of the chevrons).
 */
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { runtimeAtom } from '@/atoms';
import { CONVERSATION_CONTENT_WIDTH_CLASS } from '@/lib/conversation-layout';
import { cn } from '@/lib/utils';

/**
 * `usePermissionResponse` reports `isReady: !!runtime`, and a NOT-ready card
 * renders its disabled-state footer ("Permission actions are disabled in this
 * environment") and is taller than the real one. That state belongs to a
 * workspace whose runtime has not opened — not to plan mode — so a story about
 * plan-mode geometry must stub the runtime or it measures the wrong card.
 * Same stub as `FloatingPermissionRequest.stories.tsx`: click handlers reject
 * if exercised, screenshots show the active design.
 */
const stubRuntime = { withSessionStore: () => Promise.reject(new Error('stub')) };
const storyStore = createStore();
storyStore.set(runtimeAtom, stubRuntime as never);

const WithRuntime = ({ children }: { children: ReactNode }) => (
  <Provider store={storyStore}>{children}</Provider>
);

const meta = {
  title: 'Sessions/AssistantTurnAlignment',
  component: SessionChatStreamView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-turn-alignment-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

const streamingTurn: SessionHistoryParsed = {
  id: 'alignment-assistant',
  role: 'assistant',
  timestamp: '2026-08-11T09:00:00.000Z',
  read: true,
  finished: false,
  items: [
    { type: 'text', text: '我先查看 loro-dev/loro 仓库的 issue #1057 内容。' },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-1',
      title: 'gh issue view 1057 --repo loro-dev/loro',
      kind: 'execute',
      status: 'completed',
      content: [
        {
          type: 'terminal_command',
          command: '/bin/bash',
          args: ['-lc', 'gh issue view 1057 --repo loro-dev/loro'],
          cwd: '/repo',
        },
      ],
    },
    {
      type: 'text',
      text: [
        '这是一个附带失败测试的 PR(#1057),报告 shallow snapshot 会保留已删除富文本 mark 的',
        'style 值(隐私泄漏)。我先看一下 PR 的测试代码和相关的编码实现。',
      ].join(' '),
    },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-2',
      title: 'rg shallow_snapshot crates/loro-internal/src',
      kind: 'search',
      status: 'completed',
    },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-3',
      title: 'Read crates/loro-internal/src/encoding.rs',
      kind: 'read',
      status: 'completed',
    },
    {
      type: 'subagent_task',
      taskId: 'alignment-task-1',
      status: 'in_progress',
      taskType: 'subagent',
      subagentType: 'Explore',
      description: 'Trace shallow snapshot mark encoding',
      isBackgrounded: true,
    },
  ],
};

const items: ChatStreamItem[] = [{ type: 'message', sessionId, message: streamingTurn } as const];

/**
 * Finished turn: the "Worked for …" chevron, the edited-files card, and the
 * footer action bar are the other rows keyed to the same rail.
 */
const finishedTurn: SessionHistoryParsed = {
  id: 'alignment-assistant-finished',
  role: 'assistant',
  timestamp: '2026-08-11T09:02:00.000Z',
  read: true,
  finished: true,
  endedAt: Date.parse('2026-08-11T09:02:12.000Z'),
  fileDiff: [
    { filePath: 'crates/loro-internal/src/encoding.rs', add: 24, del: 6 },
    { filePath: 'crates/loro-internal/tests/shallow_snapshot.rs', add: 61, del: 0 },
  ],
  items: [
    {
      type: 'tool_call',
      toolCallId: 'alignment-finished-tool',
      title: 'Edit crates/loro-internal/src/encoding.rs',
      kind: 'edit',
      status: 'completed',
    },
    {
      type: 'text',
      text: 'Shallow snapshot 现在会丢弃已删除 mark 的 style 值,新增的回归测试覆盖了这条路径。',
    },
  ],
};

const finishedItems: ChatStreamItem[] = [
  { type: 'message', sessionId, message: finishedTurn } as const,
];

export const DesktopStreamingTurn: Story = {
  args: { sessionId, items, renderMessageRow },
  globals: { theme: 'dark' },
  render: () => (
    <div className="h-[520px] w-full bg-background">
      <SessionChatStreamView
        items={items}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        agentActivityLabel="Exploring"
        agentActivityTone="warning"
      />
    </div>
  ),
};

export const DesktopFinishedTurn: Story = {
  args: { sessionId, items: finishedItems, renderMessageRow },
  globals: { theme: 'dark' },
  render: () => (
    <div className="h-[520px] w-full bg-background">
      <SessionChatStreamView
        items={finishedItems}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        lastAssistantMessageId={finishedTurn.id}
        lastCompletedAssistantMessageId={finishedTurn.id}
      />
    </div>
  ),
};

/**
 * PLAN-MODE TURN — the widest set of top-level row shells in one column.
 *
 * A plan approval cuts one turn into two regions (`isPlanExitBlock` in
 * `assistant-turn-render-blocks.ts`), so a single turn shows two worked
 * headers, the `switch_mode` approval card, its resolved permission card, an
 * image group, a file card, and the proposed-plan card — plus the next turn's
 * prose. Those are all SIBLINGS in one `ConversationColumn`, so EVERY one of
 * them starts on the guide line. Measure with `getBoundingClientRect` against
 * the guide; do not eyeball it.
 *
 * Each of those shells used to carry a private horizontal pad, which rendered
 * the turn as a 0 / 8 / 16px ladder — the `switch_mode` title 8px right of the
 * chevrons above it (and 8px right of its OWN `px-0` body), the resolved
 * permission card 16px right of everything. The pads are gone; a new shell that
 * re-adds one shows up here immediately.
 *
 * GEOMETRY CONTRACT for those rows (`ai-gui/AGENTS.md` points here; it is at its
 * 8 KiB ceiling, so the numbers live where they are rendered):
 *
 *   - One radius. Every top-level card is `rounded-xl` — proposed plan, file
 *     card, image frame, the resolved permission record.
 *   - No indent, ever. An expanded region's contents start on the rail too —
 *     the worked section, the activity group, and a tool call's own body. The
 *     chevron and the header carry the hierarchy; expanding reveals rows, it
 *     never shifts them right. Hover pills bleed with `-mx-1` instead.
 *   - One gap. A row that PAINTS a surface takes `cardSiblingGap` (12px);
 *     prose keeps `turnSiblingGap` (4px) because its leading already separates
 *     it. Add a new card-shaped content type to `CARD_CONTENT_TYPES` or it
 *     silently inherits the prose gap and reads as a stack of strips.
 *   - The gap between rows is never smaller than the padding inside one. That
 *     is what broke before: cards 4-8px apart with 10-12px of internal padding.
 *   - No surface inside a surface. The plan-exit body renders bare; a nested
 *     panel cannot be concentric with a 12px card that has 12px padding, and it
 *     reads as a frame around nothing.
 *   - Order. When a turn carries a plan, agent attachments sort BELOW it
 *     (`AGENT_ATTACHMENT_TYPES`): a plan runs long, and a file card stranded
 *     above one is a small thing to find mid-markdown. The answer text still
 *     reads above that whole tail.
 *   - One plan surface, whatever the adapter. Claude and Kimi carry the plan in
 *     the approval card's `content`, Codex in `rawInput` plus a separate
 *     `proposed_plan` row. `plan-surface.ts` resolves the carrier and they all
 *     render one `PlanPanel` — see `DesktopPlanAdapterParity`.
 *   - One panel. Every framed block — command, tool input/output, permission,
 *     proposed plan — uses `conversation-panel.ts`: the HEADER carries the
 *     raised fill, the body sits on the frame. Never the reverse, and never an
 *     accent-tinted frame for one panel among neutral siblings. The header tint
 *     is a FOREGROUND alpha, because Vesper's `--muted` equals `--background`
 *     and a `bg-muted` header measured as a zero-step band in dark.
 *   - A settled permission is ONE LINE, not a card: check/cross plus the option
 *     that was chosen (`resolvePermissionRecord`). Pending keeps the full card —
 *     it is still a decision. A withdrawn request renders nothing, and
 *     `ToolCallCard` drops its body so the card does not open onto empty
 *     padding. Covered by `DesktopPlanDenied` / `DesktopPlanWithdrawn`.
 *   - The plan and its approval are ONE unit. The plan renders directly above
 *     the card that approves it (`buildAssistantMessageRenderItems` moves it
 *     there), and the card has NO title — "Implement this plan?" stacked on
 *     "Yes, implement this plan" asked and answered the same question twice.
 *     The plan panel clamps and expands from its header, because it now sits
 *     near the top of the turn, above everything it produced — but ONLY once it
 *     is history. While the approval is unanswered (or the plan is still
 *     streaming) it opens in full: `hasUnansweredPlanApproval`. Hiding two
 *     thirds of a plan behind a chevron at the moment someone is asked to
 *     approve it is the one state where clamping is unacceptable. See
 *     `DesktopPlanAwaitingDecision`.
 *   - ONE icon tone. Every icon in a turn is `text-muted-foreground` at full
 *     opacity — no per-icon `opacity-60/70/80/90`, and no hue on the outcome
 *     icon (check vs cross already carries approved vs denied). An interactive
 *     icon rests at that tone too and brightens on hover; resting DIMMER than
 *     the static chrome around it read as disabled.
 *
 * The guide line below is story-only chrome; it marks where
 * `ConversationColumn`'s content box starts (`CONVERSATION_GUTTER_X_CLASS`).
 */
const planModeTurn: SessionHistoryParsed = {
  id: 'alignment-plan-mode',
  role: 'assistant',
  timestamp: '2026-08-11T09:10:00.000Z',
  read: true,
  finished: true,
  endedAt: Date.parse('2026-08-11T09:38:35.000Z'),
  items: [
    /* Region 1 — the work that produced the plan. Folds under "Finished
       working": an earlier region never shows a duration. */
    { type: 'thought', text: '先确认这一页的布局来源,再决定改哪一层。' },
    {
      type: 'tool_call',
      toolCallId: 'plan-read-1',
      title: 'Read packages/components/src/components/ai-gui/view.tsx',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
    },
    {
      type: 'tool_call',
      toolCallId: 'plan-search-1',
      title: 'rg ConversationColumn packages/components/src',
      kind: 'search',
      status: 'completed',
    },
    /* CODEX's plan exit: the plan goes in `rawInput` (never rendered) and the
       readable plan is the separate `proposed_plan` below, which
       `buildAssistantMessageRenderItems` moves up to sit directly above this
       card. So this row contributes only the decision. Claude's shape — plan in
       `content`, no `proposed_plan` — is covered by `DesktopPlanDenied`. NEVER
       give one card both: it prints the plan twice, which no adapter does. */
    {
      type: 'tool_call',
      toolCallId: 'plan-review:plan-1',
      title: 'Implement this plan?',
      kind: 'switch_mode',
      status: 'completed',
      rawInput: { plan: '# Plan' },
      permissionRequest: {
        requestId: 'plan-exit-permission-1',
        options: [
          { optionId: 'implement', name: 'Yes, implement this plan', kind: 'allow_once' },
          {
            optionId: 'revise',
            name: 'No, and tell Codex what to do differently',
            kind: 'reject_once',
          },
        ],
        outcome: { outcome: 'selected', optionId: 'implement' },
      },
    },
    /* Region 2 — the approved implementation. Last region, so it owns the
       duration: "Worked for 28m 35s". */
    { type: 'thought', text: '按计划先改 ToolCallCard 的外壳内边距。' },
    {
      type: 'tool_call',
      toolCallId: 'plan-edit-1',
      title: 'Edit packages/components/src/components/ai-gui/view.tsx',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
    },
    {
      type: 'tool_call',
      toolCallId: 'plan-edit-2',
      title: 'Edit packages/components/src/stories/AssistantTurnAlignment.stories.tsx',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'packages/components/src/stories/AssistantTurnAlignment.stories.tsx' }],
    },
    {
      type: 'image_group',
      images: [
        {
          imageId: 'alignment-plan-shot-1',
          mimeType: 'image/png',
          fileName: 'plan-mode-turn.png',
          sizeBytes: 40_000,
          width: 320,
          height: 200,
        },
      ],
    },
    {
      type: 'text',
      text: '计划卡、权限卡、附件和正文都落在同一条左轨上,任何外壳自带的水平内边距都会在这条参考线上暴露出来。',
    },
    {
      type: 'file',
      fileId: 'alignment-plan-file-1',
      fileName: 'plan-mode-alignment.md',
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      sha256: 'f'.repeat(64),
      textPreview: true,
      uploadedAt: Date.parse('2026-08-11T09:38:30.000Z'),
      transport: 'local',
      machineId: 'machine-alignment-storybook',
    },
    {
      type: 'proposed_plan',
      turnId: 'alignment-plan-turn',
      status: 'completed',
      isLatest: true,
      markdown: [
        '## Goal',
        'Keep every top-level row of a plan-mode turn on one left rail.',
        '## Steps',
        '1. No per-shell horizontal pad on the `switch_mode` card.',
        '2. The resolved permission card sits on the rail, not on its own `ml-4`.',
      ].join('\n'),
    },
  ],
};

const planModeItems: ChatStreamItem[] = [
  { type: 'message', sessionId, message: planModeTurn } as const,
];

/** Story-only guide at the column's content edge. */
const RailGuide = () => (
  <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
    <div className={cn(CONVERSATION_CONTENT_WIDTH_CLASS, 'relative h-full')}>
      {/* `left-4` == the `sm:px-4` gutter, i.e. where every top-level row starts. */}
      <div className="absolute inset-y-0 left-4 w-px bg-status-danger/70" />
    </div>
  </div>
);

/**
 * The other two outcomes of the same card. A settled permission is one line —
 * check + what was chosen, or a cross when it was denied — and a WITHDRAWN
 * request (interrupted turn) renders nothing at all, not an empty card.
 */
const planExitOutcomeTurn = (
  id: string,
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
): SessionHistoryParsed => ({
  id,
  role: 'assistant',
  timestamp: '2026-08-11T09:10:00.000Z',
  read: true,
  finished: true,
  endedAt: Date.parse('2026-08-11T09:10:20.000Z'),
  items: [
    {
      type: 'tool_call',
      toolCallId: 'read-1',
      title: 'Read view.tsx',
      kind: 'read',
      status: 'completed',
    },
    {
      type: 'tool_call',
      toolCallId: `${id}-plan-exit`,
      title: 'Ready to code?',
      kind: 'switch_mode',
      status: 'completed',
      /* CLAUDE's shape: `ExitPlanMode` carries the plan as a `content` text
         block, so the card renders it above the outcome and there is no
         separate `proposed_plan` item. */
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: '**Plan**\n\n1. Drop the per-shell horizontal pads.\n2. Re-measure against the rail guide.',
          },
        },
      ],
      permissionRequest: {
        requestId: `${id}-permission`,
        options: [
          { optionId: 'approve', name: 'Yes, implement the plan', kind: 'allow_once' },
          { optionId: 'reject', name: 'No, and tell Codex what to change', kind: 'reject_once' },
        ],
        outcome,
      },
    },
    { type: 'text', text: 'Recorded the decision above.' },
  ],
});

const outcomeStory = (message: SessionHistoryParsed, height = 'h-[320px]'): Story => ({
  args: {
    sessionId,
    items: [{ type: 'message', sessionId, message } as const],
    renderMessageRow,
  },
  globals: { theme: 'dark' },
  render: () => (
    <WithRuntime>
      <div className={cn('relative w-full bg-background', height)}>
        <SessionChatStreamView
          items={[{ type: 'message', sessionId, message } as const]}
          sessionId={sessionId}
          renderMessageRow={renderMessageRow}
          lastAssistantMessageId={message.id}
          lastCompletedAssistantMessageId={message.id}
        />
        <RailGuide />
      </div>
    </WithRuntime>
  ),
});

/**
 * The moment the plan matters most: the approval is unanswered, so the plan
 * opens IN FULL and the pending permission card keeps all its options. Compare
 * with `DesktopPlanModeTurn`, where the same plan is clamped because the
 * decision is already made.
 */
const planAwaitingDecisionTurn: SessionHistoryParsed = {
  id: 'alignment-plan-pending',
  role: 'assistant',
  timestamp: '2026-08-11T09:10:00.000Z',
  read: true,
  finished: false,
  items: [
    {
      type: 'tool_call',
      toolCallId: 'pending-read-1',
      title: 'Read packages/components/src/components/ai-gui/view.tsx',
      kind: 'read',
      status: 'completed',
    },
    {
      type: 'proposed_plan',
      turnId: 'alignment-pending-turn',
      status: 'completed',
      isLatest: true,
      markdown: [
        '## Goal',
        'Keep every top-level row of a plan-mode turn on one left rail.',
        '## Steps',
        '1. No per-shell horizontal pad on the `switch_mode` card.',
        '2. The resolved permission card sits on the rail.',
        '3. Attachments sort below the plan.',
        '4. One icon tone for the whole turn.',
      ].join('\n'),
    },
    {
      type: 'tool_call',
      toolCallId: 'plan-review:pending',
      title: 'Implement this plan?',
      kind: 'switch_mode',
      status: 'pending',
      rawInput: { plan: '# Plan' },
      permissionRequest: {
        requestId: 'pending-permission',
        options: [
          { optionId: 'implement', name: 'Yes, implement this plan', kind: 'allow_once' },
          {
            optionId: 'revise',
            name: 'No, and tell Codex what to do differently',
            kind: 'reject_once',
          },
        ],
      },
    },
  ],
};

/**
 * ADAPTER PARITY. The bundled agents put the plan in different places
 * (`plan-surface.ts`), and the turn must not show it: Claude and Kimi carry it
 * in the card's `content`, Codex in `rawInput` plus a separate `proposed_plan`
 * row. All three render the same panel here. If one of these starts looking
 * different, an adapter grew a carrier `resolvePlanExitMarkdown` does not know.
 */
const PARITY_PLAN = [
  '## Goal',
  'Render the same plan panel whichever adapter produced it.',
  '## Steps',
  '1. Resolve the carrier in `plan-surface.ts`.',
  '2. Feed every carrier into one `PlanPanel`.',
].join('\n');

const parityTurn = (
  id: string,
  label: string,
  planExit: Record<string, unknown>,
  extraItems: MessageContent[] = []
): SessionHistoryParsed =>
  ({
    id,
    role: 'assistant',
    timestamp: '2026-08-11T09:10:00.000Z',
    read: true,
    finished: true,
    endedAt: Date.parse('2026-08-11T09:10:30.000Z'),
    items: [
      { type: 'text', text: label },
      ...extraItems,
      {
        type: 'tool_call',
        toolCallId: `${id}-exit`,
        kind: 'switch_mode',
        status: 'completed',
        permissionRequest: {
          requestId: `${id}-permission`,
          options: [
            { optionId: 'approve', name: 'Yes, implement this plan', kind: 'allow_once' },
            { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
          ],
          outcome: { outcome: 'selected', optionId: 'approve' },
        },
        ...planExit,
      },
    ],
  }) as unknown as SessionHistoryParsed;

const parityTurns: SessionHistoryParsed[] = [
  // Claude: `ExitPlanMode` puts the plan in a `content` text block.
  parityTurn('parity-claude', 'Claude — plan in the card `content`', {
    title: 'Ready to code?',
    content: [{ type: 'content', content: { type: 'text', text: PARITY_PLAN } }],
  }),
  // Kimi: same carrier, with the `Plan saved to:` prefix its adapter composes.
  parityTurn('parity-kimi', 'Kimi — same carrier, plus its trailing action summary', {
    title: 'ExitPlanMode',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: `Plan saved to: /tmp/plan.md\n\n${PARITY_PLAN}` },
      },
      // `buildPermissionToolCallUpdate` always appends this after the plan; it
      // must not end up inside the plan panel.
      { type: 'content', content: { type: 'text', text: 'Requesting approval to exit plan mode' } },
    ],
  }),
  // Codex: `rawInput` plus a separate `proposed_plan` row, which wins.
  parityTurn(
    'parity-codex',
    'Codex — `rawInput` plus a separate plan row',
    { title: 'Implement this plan?', rawInput: { plan: PARITY_PLAN } },
    [
      {
        type: 'proposed_plan',
        turnId: 'parity-codex-turn',
        markdown: PARITY_PLAN,
        status: 'completed',
        isLatest: true,
      } as MessageContent,
    ]
  ),
];

export const DesktopPlanAdapterParity: Story = {
  args: {
    sessionId,
    items: parityTurns.map((message) => ({ type: 'message', sessionId, message }) as const),
    renderMessageRow,
  },
  globals: { theme: 'dark' },
  render: () => (
    <WithRuntime>
      <div className="relative h-[1100px] w-full bg-background">
        <SessionChatStreamView
          items={parityTurns.map((message) => ({ type: 'message', sessionId, message }) as const)}
          sessionId={sessionId}
          renderMessageRow={renderMessageRow}
        />
        <RailGuide />
      </div>
    </WithRuntime>
  ),
};

export const DesktopPlanAwaitingDecision: Story = outcomeStory(
  planAwaitingDecisionTurn,
  'h-[760px]'
);

export const DesktopPlanDenied: Story = outcomeStory(
  planExitOutcomeTurn('alignment-plan-denied', { outcome: 'selected', optionId: 'reject' })
);

export const DesktopPlanWithdrawn: Story = outcomeStory(
  planExitOutcomeTurn('alignment-plan-cancelled', { outcome: 'cancelled' })
);

export const DesktopPlanModeTurn: Story = {
  args: { sessionId, items: planModeItems, renderMessageRow },
  globals: { theme: 'dark' },
  render: () => (
    <WithRuntime>
      <div className="relative h-[900px] w-full bg-background">
        <SessionChatStreamView
          items={planModeItems}
          sessionId={sessionId}
          renderMessageRow={renderMessageRow}
          lastAssistantMessageId={planModeTurn.id}
          lastCompletedAssistantMessageId={planModeTurn.id}
        />
        <RailGuide />
      </div>
    </WithRuntime>
  ),
};
