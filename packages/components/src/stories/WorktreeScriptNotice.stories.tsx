import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import { MessageRowView } from '@/components/ai-gui/view';
const storyLayout = stylex.create({
  canvas: {
    'margin-inline': 'auto',
    'max-width': '42rem',
    padding: 'calc(var(--spacing) * 6)',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 4)',
  },
});

const sessionId = 'session-storybook' as SessionId;

const SAMPLE_OUTPUT = [
  '+ cp .env.example .env',
  '+ pnpm install',
  'Lockfile is up to date, resolution step is skipped',
  'Packages: +812',
  'Progress: resolved 812, reused 812, downloaded 0, added 812, done',
  'Done in 4.2s',
].join('\n');

function systemMessage(id: string, items: MessageContent[]): SessionHistoryParsed {
  return {
    id,
    role: 'system',
    timestamp: new Date('2026-06-06T00:00:00Z').toISOString(),
    read: true,
    userId: undefined,
    items,
    finished: true,
  } as SessionHistoryParsed;
}

function worktreeScript(partial: Partial<MessageContent> = {}): MessageContent {
  return {
    type: 'worktree_script',
    phase: 'setup',
    status: 'completed',
    steps: [
      {
        command: 'cp .env.example .env',
        status: 'completed',
        output: '+ cp .env.example .env\n',
      },
      {
        command: 'pnpm install',
        status: 'completed',
        output: SAMPLE_OUTPUT,
      },
    ],
    ...partial,
  } as MessageContent;
}

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div {...stylex.props(storyLayout.canvas)}>{children}</div>
);

const meta = {
  title: 'AI/WorktreeScriptNotice',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  render: () => (
    <Frame>
      <MessageRowView
        message={systemMessage('m-running', [
          worktreeScript({
            phase: 'setup',
            status: 'in_progress',
            steps: [
              {
                command: 'cp .env.example .env',
                status: 'completed',
                output: '+ cp .env.example .env\n',
              },
              {
                command: 'pnpm install',
                status: 'in_progress',
                output: SAMPLE_OUTPUT,
              },
            ],
          }),
        ])}
        sessionId={sessionId}
      />
    </Frame>
  ),
};

export const CompletedCollapsed: Story = {
  render: () => (
    <Frame>
      <MessageRowView
        message={systemMessage('m-done', [worktreeScript({ phase: 'setup', status: 'completed' })])}
        sessionId={sessionId}
      />
    </Frame>
  ),
};

export const CleanupFailed: Story = {
  render: () => (
    <Frame>
      <MessageRowView
        message={systemMessage('m-failed', [
          worktreeScript({
            phase: 'cleanup',
            status: 'failed',
            steps: [
              {
                command: 'rm -rf node_modules',
                status: 'failed',
                output: 'rm: cannot remove node_modules: Directory not empty\nexit code 1',
              },
            ],
          }),
        ])}
        sessionId={sessionId}
      />
    </Frame>
  ),
};

export const Stacked: Story = {
  render: () => (
    <Frame>
      <div {...stylex.props(storyLayout.stack)}>
        <MessageRowView
          message={systemMessage('m1', [worktreeScript({ phase: 'setup', status: 'completed' })])}
          sessionId={sessionId}
        />
        <MessageRowView
          message={systemMessage('m2', [
            worktreeScript({
              phase: 'cleanup',
              status: 'in_progress',
              steps: [
                {
                  command: 'rm -rf node_modules',
                  status: 'in_progress',
                  output: 'removing node_modules\n',
                },
              ],
            }),
          ])}
          sessionId={sessionId}
        />
      </div>
    </Frame>
  ),
};
