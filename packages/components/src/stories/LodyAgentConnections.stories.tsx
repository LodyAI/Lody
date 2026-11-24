import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import {
  LodyAgentConnections,
  type LodyAgentCredential,
  type LodyAgentCustomProvider,
} from '@/components/settings/lody-agent-connections';

const credentials: readonly LodyAgentCredential[] = [
  { providerId: 'anthropic', type: 'oauth' },
  { providerId: 'openrouter', type: 'api-key' },
  { providerId: 'prov_gateway', type: 'api-key' },
];

const providers: readonly LodyAgentCustomProvider[] = [
  {
    id: 'prov_gateway',
    name: 'Acme Gateway',
    protocol: 'openai-completions',
    baseUrl: 'https://gateway.acme.dev/v1',
    models: [{ id: 'acme-large' }, { id: 'acme-small' }],
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
  title: 'Settings/Lody Agent connections',
  component: LodyAgentConnections,
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.surface)}>
        <Story />
      </div>
    ),
  ],
  args: {
    status: 'ready',
    credentials,
    providers,
    uncertainRemovalIds: [],
    onRetry: () => {},
    onRemove: () => {},
    onCreate: async () => {},
  },
} satisfies Meta<typeof LodyAgentConnections>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { credentials: [], providers: [] },
};

export const RemovalNotConfirmed: Story = {
  args: { uncertainRemovalIds: ['openrouter'] },
};

export const ReadFailed: Story = {
  args: { status: 'error', credentials: [], providers: [] },
};

export const AddingEndpoint: Story = {
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add endpoint' }));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByPlaceholderText('Acme Gateway'), 'Acme Gateway');
    await userEvent.type(
      await page.findByPlaceholderText('https://gateway.example.com/v1'),
      'https://gateway.acme.dev/v1'
    );
  },
};
