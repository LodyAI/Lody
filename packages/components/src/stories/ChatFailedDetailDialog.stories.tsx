import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ChatFailedDetailDialog } from '@/components/ai-gui/chat-failed-detail-dialog';

const meta: Meta<typeof ChatFailedDetailDialog> = {
  title: 'Components/ChatFailedDetailDialog',
  component: ChatFailedDetailDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    title: 'Upstream API error — you can retry your message',
    reason: 'acp_upstream_api_error',
    sessionId: 'session-8f31c2',
    agentType: 'claude',
    machineId: 'machine-macbook',
    summary: 'Overloaded',
    message:
      'Internal error: API Error: 500 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX9m4x2Qv"}',
  },
};

export default meta;
type Story = StoryObj<typeof ChatFailedDetailDialog>;

export const UpstreamApiError: Story = {};

export const WithSuggestedAction: Story = {
  args: {
    title: 'Git executable was not found on the target machine',
    reason: 'turn_pre_prompt_failed',
    code: 'git_executable_not_found',
    action:
      'Install Git for Windows or add git.exe to PATH, fully restart Lody/CLI, verify “git --version” in a new terminal, then try again.',
    summary: undefined,
    message:
      'Error: spawn git ENOENT\n  at ChildProcess.handle.onexit (node:internal/child_process)',
  },
};

export const LongRawPayload: Story = {
  args: {
    title: 'Agent internal error',
    reason: 'acp_internal_error',
    summary: 'Unhandled exception while starting the agent',
    message: [
      'Internal error: Unhandled exception while starting the agent',
      ...Array.from(
        { length: 40 },
        (_, index) =>
          `    at packages/acp/src/runtime/stage-${index}.ts:${index * 7 + 3}:${index * 3 + 11} (runStage${index})`
      ),
    ].join('\n'),
  },
};

export const NoRawMessage: Story = {
  args: {
    title: 'Session not found',
    reason: 'session_not_found',
    summary: undefined,
    message: undefined,
    code: undefined,
  },
};
