import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import {
  LodyAgentCustomProviders,
  type LodyAgentCustomProvider,
} from '@/components/settings/lody-agent-custom-providers';

const providers: readonly LodyAgentCustomProvider[] = [
  {
    id: 'prov_openrouter',
    name: 'OpenRouter',
    protocol: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'anthropic/claude-sonnet-4.6' }, { id: 'openai/gpt-5.2' }],
  },
  {
    id: 'prov_local',
    name: 'Local gateway',
    protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:8787',
    models: [{ id: 'lody-large' }],
  },
];

const styles = stylex.create({
  surface: {
    maxWidth: 560,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
});

const meta = {
  title: 'Settings/Lody Agent custom providers',
  component: LodyAgentCustomProviders,
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.surface)}>
        <Story />
      </div>
    ),
  ],
  args: {
    status: 'ready',
    providers: [],
    onRefresh: () => {},
    onRemove: () => {},
    onCreate: () => {},
  },
} satisfies Meta<typeof LodyAgentCustomProviders>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { providers },
};

export const Empty: Story = {
  args: { providers: [] },
};

export const Adding: Story = {
  args: { providers },
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add provider' }));
    await userEvent.type(await canvas.findByPlaceholderText('Acme Gateway'), 'Acme Gateway');
    await userEvent.type(
      await canvas.findByPlaceholderText('https://gateway.example.com/v1'),
      'https://gateway.acme.dev/v1'
    );
    await userEvent.type(
      await canvas.findByPlaceholderText('acme-large, acme-small'),
      'acme-large, acme-small'
    );
  },
};
