import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { AgentActivityRow, AssistantTurnFooter } from '@/components/ai-gui/view';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  footer: { paddingTop: '12rem', maxWidth: '46rem' },
  activity: { paddingTop: themeSpace[4] },
});

const meta = {
  title: 'AI GUI/ViewMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'view-migration-session' as SessionId;
const finished: SessionHistoryParsed = {
  id: 'view-migration-finished',
  role: 'assistant',
  timestamp: '2026-10-21T12:00:00.000Z',
  endedAt: Date.parse('2026-10-21T12:00:12.000Z'),
  read: true,
  finished: true,
  modelInfo: {
    modelId: 'synthetic-model',
    name: 'Synthetic model',
    _meta: { lodyThoughtLevel: 'high' },
  },
  tokenUsage: {
    inputTokens: 1234,
    outputTokens: 300,
    reasoningOutputTokens: 200,
    cacheReadInputTokens: 1_500_000,
    cacheCreationInputTokens: 2000,
    costUSD: 0.0182,
  },
  items: [{ type: 'text', text: 'A fixed finished turn for metadata spacing.' }],
};

function MetadataFixture({ sparse = false }: { sparse?: boolean }) {
  const message: SessionHistoryParsed = sparse
    ? {
        ...finished,
        id: 'view-migration-sparse',
        modelInfo: undefined,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      }
    : finished;
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.footer)}>
        <AssistantTurnFooter
          message={message}
          sessionId={sessionId}
          showDuration
          isTurnHovered
          isLatestTurn
        />
      </div>
    </div>
  );
}

const openMetadata: NonNullable<Story['play']> = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Turn configuration' }));
  const body = within(canvasElement.ownerDocument.body);
  await expect(body.getByText('Tokens', { exact: true })).toBeVisible();
  await expect(body.getByText('Timing', { exact: true })).toBeVisible();
};

export const TurnMetadata: Story = {
  render: () => <MetadataFixture />,
  play: openMetadata,
};

export const SparseTurnMetadata: Story = {
  render: () => <MetadataFixture sparse />,
  play: openMetadata,
};

export const ActivityTones: Story = {
  render: () => (
    <div {...stylex.props(styles.canvas)}>
      <AgentActivityRow label="Working" tone="primary" shimmer={false} />
      <div {...stylex.props(styles.activity)}>
        <AgentActivityRow label="Waiting for permission" tone="warning" shimmer={false} />
      </div>
    </div>
  ),
};
