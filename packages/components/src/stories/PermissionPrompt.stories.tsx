import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { MessageContent } from '@lody/shared';
import { PermissionPrompt } from '@/components/sessions/floating-permission-request';

type ToolCall = Extract<MessageContent, { type: 'tool_call' }>;
type Permission = NonNullable<ToolCall['permissionRequest']>;

/*
 * Provider stories use requests a provider really sends, with the provider's own
 * option names (see the permission note for where each comes from): the prompt
 * never rewrites them, so the stories must not either. Long-label cases use
 * synthetic requests to exercise wrapping.
 */

const request = (
  toolCall: Omit<ToolCall, 'type' | 'toolCallId' | 'status' | 'permissionRequest'>,
  permission: Omit<Permission, 'requestId'>
): { toolCall: ToolCall; permission: Permission } => {
  const full: Permission = { requestId: 'req-1', ...permission };
  return {
    toolCall: {
      type: 'tool_call',
      toolCallId: 'tc-1',
      status: 'pending',
      ...toolCall,
      permissionRequest: full,
    } as ToolCall,
    permission: full,
  };
};

const claudeCommand = request(
  {
    kind: 'execute',
    title: 'pnpm install --frozen-lockfile',
    content: [
      { type: 'terminal_command', command: 'pnpm install --frozen-lockfile', cwd: '/repo' },
    ],
  } as never,
  {
    _meta: {
      permission: {
        version: 1,
        title: 'Run command?',
        description: 'Reason: install dependencies before running the tests',
      },
    },
    options: [
      { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
      {
        optionId: 'always',
        name: "Yes, and don't ask again for `pnpm install` commands",
        kind: 'allow_always',
      },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ],
  }
);

const meta = {
  title: 'Sessions/PermissionPrompt',
  component: PermissionPrompt,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[min(640px,calc(100vw-16px))]">
        <Story />
      </div>
    ),
  ],
  args: { ...claudeCommand, onSelect: () => undefined, onStop: () => undefined },
} satisfies Meta<typeof PermissionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

function SelectablePermissionPrompt(args: Parameters<typeof PermissionPrompt>[0]) {
  const [selected, setSelected] = useState('');
  return (
    <>
      <PermissionPrompt {...args} onSelect={setSelected} />
      <output aria-label="Selected option">{selected}</output>
    </>
  );
}

/** Claude asking to run a command: its own heading and reason, its own answers. */
export const ClaudeCommand: Story = {};

/** A risky call Claude marks `defaultToNo`: the refusal is the suggestion. */
export const DefaultToNo: Story = {
  args: request(
    {
      kind: 'execute',
      title: 'rm -rf node_modules dist',
      content: [{ type: 'terminal_command', command: 'rm -rf node_modules dist' }],
    } as never,
    {
      _meta: { permission: { version: 1, title: 'Run command?', defaultToNo: true } },
      options: [
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
      ],
    }
  ),
};

/** Codex editing files: the paths touched, and its option descriptions. */
export const CodexEdit: Story = {
  args: request(
    {
      kind: 'edit',
      title: 'Edit files',
      locations: [{ path: 'src/auth/session.ts' }, { path: 'src/auth/token.ts' }],
    } as never,
    {
      _meta: { permission: { version: 1, title: 'Make edits?' } },
      options: [
        { optionId: 'approved', name: 'Yes, proceed', kind: 'allow_once' },
        {
          optionId: 'approved_for_session',
          name: "Yes, and don't ask again for these files",
          kind: 'allow_always',
          _meta: {
            permission: {
              description: 'Edits to these two files run without asking until the session ends.',
            },
          },
        },
        {
          optionId: 'cancel',
          name: 'No, and tell Codex what to do differently',
          kind: 'reject_once',
        },
      ],
    }
  ),
};

export const LongOptions: Story = {
  render: (args) => <SelectablePermissionPrompt {...args} />,
  args: request(
    { kind: 'edit', title: 'Edit files', locations: [{ path: 'src/example.ts' }] } as never,
    {
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'always',
          name: 'Always allow edits to files under /workspace/example/packages/components for the rest of this session, including newly created files in that directory.',
          kind: 'allow_always',
        },
        {
          optionId: 'reject',
          name: 'Deny this request because the proposed change touches files outside the agreed scope. Ask the agent to revise the change before continuing.',
          kind: 'reject_once',
        },
        {
          optionId: 'block',
          name: 'Always deny edits to /workspace/example/packages/components/src/components/deeply/nested/example-with-a-very-long-unbroken-filename-and-authorization-scope.tsx for the rest of this session.',
          kind: 'reject_always',
        },
      ],
    }
  ),
};

export const LongChineseOptions: Story = {
  render: (args) => <SelectablePermissionPrompt {...args} />,
  args: request(
    { kind: 'edit', title: 'Edit files', locations: [{ path: 'src/example.ts' }] } as never,
    {
      options: [
        { optionId: 'allow', name: '仅允许本次操作', kind: 'allow_once' },
        {
          optionId: 'always',
          name: '始终允许修改当前工作目录及其子目录下的文件，包括后续新建的文件；授权仅在本次会话中有效，会话结束后需要重新确认。',
          kind: 'allow_always',
        },
        {
          optionId: 'reject',
          name: '拒绝本次请求，因为拟议的修改涉及约定范围之外的文件。请先让 Agent 调整修改范围，保留现有内容，确认后再继续执行。',
          kind: 'reject_once',
        },
      ],
    }
  ),
};

/** Codex network access: an "always" refusal Escape must never pick. */
export const CodexNetwork: Story = {
  args: request({ kind: 'fetch', title: 'https network access to registry.npmjs.org' } as never, {
    _meta: { permission: { version: 1, title: 'Allow network access?' } },
    options: [
      { optionId: 'approved', name: 'Yes, just this once', kind: 'allow_once' },
      {
        optionId: 'host_always',
        name: 'Yes, and allow this host in the future',
        kind: 'allow_always',
      },
      {
        optionId: 'host_never',
        name: 'No, and block this host in the future',
        kind: 'reject_always',
      },
      { optionId: 'denied', name: 'No, continue without running it', kind: 'reject_once' },
    ],
  }),
};

/** Claude leaving plan mode: the plan is the message above, so no subject here. */
export const ClaudePlanExit: Story = {
  args: request({ kind: 'switch_mode', title: 'Approve Plan' } as never, {
    _meta: { permission: { version: 1, title: 'Ready to code?' } },
    options: [
      { optionId: 'auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
      { optionId: 'accept_edits', name: 'Yes, auto-accept edits', kind: 'allow_always' },
      { optionId: 'default', name: 'Yes, manually approve edits', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ],
  }),
};

/** An MCP tool from a custom agent that sent no heading: the kind decides it. */
export const McpTool: Story = {
  args: request({ kind: 'mcp', title: 'github.create_issue' } as never, {
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
  }),
};

/** The DeepSeek harness sends no title at all. */
export const Untitled: Story = {
  args: request({} as never, {
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  }),
};

/** A long command stays whole and scrolls inside its own box. */
export const LongCommand: Story = {
  args: request(
    {
      kind: 'execute',
      content: [
        {
          type: 'terminal_command',
          command: Array.from(
            { length: 14 },
            (_, i) => `docker run --rm -v "$PWD":/app -w /app node:22 pnpm --filter pkg-${i} test`
          ).join(' && \\\n  '),
        },
      ],
    } as never,
    {
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
    }
  ),
};

/** One of several pending requests. */
export const InQueue: Story = {
  args: {
    position: { index: 1, total: 3, onPrevious: () => undefined, onNext: () => undefined },
  },
};

/** The answer is on its way. */
export const Sending: Story = { args: { sendingOptionId: 'allow' } };

/** The answer did not arrive; the prompt says so and stays answerable. */
export const SendFailed: Story = {
  args: { error: "Your answer didn't reach the agent. Try again." },
};

/** The workspace is still connecting. */
export const NotReady: Story = { args: { isReady: false } };
