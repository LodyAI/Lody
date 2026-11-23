/**
 * What an expanded tool step shows (`ai-gui/tool-call-detail.tsx`): one sheet
 * per step, sections in the order they happened, no header repeating the row's
 * title. Covers every shape agents send — a described shell command, a Codex
 * `bash -lc` argv, a failing exit, a command echoed as a text block, a string
 * result stored as terminal output, a JSON result, a prose result, a search
 * pattern, a running command.
 *
 * `play` opens the group and every step so the screenshot shows the sheets.
 */
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { userEvent, waitFor, within } from 'storybook/test';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { runtimeAtom } from '@/atoms';

const storyStore = createStore();
storyStore.set(runtimeAtom, {
  withSessionStore: () => Promise.reject(new Error('stub')),
} as never);

const sessionId = 'session-tool-call-steps-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

const pythonScript = [
  'cd /tmp/docx_extract && python3 -c "',
  'import re',
  "with open('report/word/document.xml', encoding='utf-8') as f:",
  '    xml = f.read()',
  "paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.DOTALL)",
  "print('\\n'.join(p for p in paras[150:] if p))",
  '"',
].join('\n');

const toolStepsTurn: SessionHistoryParsed = {
  id: 'tool-call-steps-assistant',
  role: 'assistant',
  timestamp: '2026-09-26T09:00:00.000Z',
  read: true,
  finished: false,
  items: [
    { type: 'text', text: 'Checking the branch, then pushing the fix.' },
    {
      type: 'tool_call',
      toolCallId: 'steps-tool-search',
      title: 'ToolSearch',
      kind: 'other',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Tool: TaskStop' } }],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-task-stop',
      title: 'TaskStop',
      kind: 'other',
      status: 'completed',
      content: [
        {
          type: 'terminal_output',
          stream: 'combined',
          output:
            '{"message":"Successfully stopped task: b7q2 (pnpm check > /tmp/check.log 2>&1)","task_id":"b7q2","task_type":"local_bash"}',
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-claude-bash',
      title: 'Amend commit with import fix and push branch',
      kind: 'execute',
      status: 'completed',
      content: [
        {
          type: 'terminal_command',
          command:
            'git status --short; git add packages/components/src/settings/integrations.tsx && git commit -q --amend --no-edit && git log --oneline -1 && git push -u origin feat/settings-polish 2>&1 | tail -3',
        },
        {
          type: 'terminal_output',
          stream: 'combined',
          output: [
            ' M packages/components/src/settings/integrations.tsx',
            'fc83522 feat(ui): rework settings and focus rings',
            'To https://github.com/example/app.git',
            ' * [new branch]      feat/settings-polish -> feat/settings-polish',
          ].join('\n'),
          exitStatus: { exitCode: 0, signal: null },
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-python-echo',
      title: 'python3',
      kind: 'execute',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: pythonScript } },
        { type: 'terminal_command', command: pythonScript },
        {
          type: 'terminal_output',
          stream: 'combined',
          output: '项目启动与技术任务书\n一、项目背景\n二、技术目标',
          exitStatus: { exitCode: 0, signal: null },
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-codex-failing',
      title: 'pnpm --filter @app/web typecheck',
      kind: 'execute',
      status: 'failed',
      content: [
        {
          type: 'terminal_command',
          command: '/bin/bash',
          args: ['-lc', 'pnpm --filter @app/web typecheck'],
          cwd: '/repo',
        },
        {
          type: 'terminal_output',
          stream: 'combined',
          output:
            "src/settings/integrations.tsx(3,10): error TS6133: 'Badge' is declared but its value is never read.",
          exitStatus: { exitCode: 2, signal: null },
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-search',
      title: "Search for 'useMarkdownCodeTokens'",
      kind: 'search',
      status: 'completed',
      content: [
        {
          type: 'terminal_command',
          command: 'useMarkdownCodeTokens',
          args: ['packages/components'],
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-fetch',
      title: 'Fetch https://shiki.style/guide',
      kind: 'fetch',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Shiki tokenizes with **TextMate grammars**. `codeToTokens` returns themed tokens per line.',
          },
        },
      ],
    },
    {
      type: 'tool_call',
      toolCallId: 'steps-running',
      title: 'pnpm --dir apps/desktop exec vite build',
      kind: 'execute',
      status: 'in_progress',
      content: [
        {
          type: 'terminal_command',
          command: '/bin/zsh',
          args: ['-lc', 'pnpm --dir apps/desktop exec vite build'],
        },
      ],
    },
  ],
};

const items: ChatStreamItem[] = [
  { type: 'message', sessionId, message: toolStepsTurn, turnIndex: 0 } as const,
];

const meta = {
  title: 'Sessions/ToolCallSteps',
  component: SessionChatStreamView,
  parameters: { layout: 'fullscreen' },
  args: { sessionId, items, renderMessageRow },
  render: () => (
    <Provider store={storyStore}>
      <div className="relative h-[1500px] w-full bg-background">
        <SessionChatStreamView
          items={items}
          sessionId={sessionId}
          renderMessageRow={renderMessageRow}
          lastAssistantMessageId={toolStepsTurn.id}
          agentActivityLabel="Working"
        />
      </div>
    </Provider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The group header, then each step it reveals.
    await userEvent.click(await canvas.findByRole('button', { expanded: false }));
    await waitFor(() => {
      if (canvas.queryAllByRole('button', { expanded: false }).length === 0) {
        throw new Error('The group has not revealed its steps yet');
      }
    });
    for (const step of canvas.queryAllByRole('button', { expanded: false })) {
      await userEvent.click(step);
    }
  },
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { globals: { theme: 'light' } };

export const Dark: Story = { globals: { theme: 'dark' } };

const customAcpCommand =
  'sleep 2; grep -E "READY|FAILED" /tmp/build-check.log | tail -5; pgrep -f build-worker >/dev/null && echo "CHECK COMPLETE"';
const customAcpLinkedEcho = customAcpCommand.replaceAll(
  '/tmp/build-check.log',
  '[/tmp/build-check.log](file:///tmp/build-check.log)'
);
const customAcpTurn: SessionHistoryParsed = {
  id: 'custom-acp-echo-assistant',
  role: 'assistant',
  timestamp: '2026-09-29T09:00:00.000Z',
  read: true,
  finished: false,
  items: [
    {
      type: 'tool_call',
      toolCallId: 'custom-acp-linked-echo',
      title: 'sleep, grep, pgrep',
      kind: 'execute',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: customAcpLinkedEcho } },
        { type: 'terminal_command', command: customAcpCommand },
        { type: 'terminal_output', stream: 'combined', output: 'CHECK COMPLETE\n' },
      ],
    },
  ],
};

/** Synthetic Custom ACP payload reproducing a linked text echo beside its structured command. */
export const CustomAcpEcho: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <Provider store={storyStore}>
      <div className="relative h-[700px] w-full bg-background">
        <SessionChatStreamView
          items={[{ type: 'message', sessionId, message: customAcpTurn, turnIndex: 0 }]}
          sessionId={sessionId}
          renderMessageRow={renderMessageRow}
          lastAssistantMessageId={customAcpTurn.id}
          agentActivityLabel="Working"
        />
      </div>
    </Provider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { expanded: false }));
    await userEvent.click(await canvas.findByRole('button', { expanded: false }));
  },
};
