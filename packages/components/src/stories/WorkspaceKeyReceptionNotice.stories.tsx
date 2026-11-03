import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { WorkspaceKeyReceptionNotice } from '../components/workspace-key-reception-notice';

const styles = stylex.create({
  page: { padding: space[4], display: 'grid', gap: space[3], maxWidth: 600 },
});
const waiting = { workspaceId: 'storybook-encrypted' };
// Synthetic preview advances only the display clock; it grants no key or authority.
function AfterDelayPreview(props: ComponentProps<typeof WorkspaceKeyReceptionNotice>) {
  const [clock] = useState(() => {
    let elapsed = 0;
    return {
      now: () => elapsed,
      setTimeout: (callback: () => void, delay: number) =>
        setTimeout(() => {
          elapsed += delay;
          callback();
        }, 0),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    };
  });
  return <WorkspaceKeyReceptionNotice {...props} clock={clock} />;
}
const meta = {
  title: 'Workspace/KeyReceptionNotice',
  component: WorkspaceKeyReceptionNotice,
  args: { workspaceId: waiting.workspaceId, waiting },
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.page)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceKeyReceptionNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BeforeThreshold: Story = {};
export const ReceivingKey: Story = { render: (args) => <AfterDelayPreview {...args} /> };
export const OtherWorkspace: Story = {
  args: { workspaceId: 'storybook-other' },
  render: (args) => <AfterDelayPreview {...args} />,
};
export const KeyInstalled: Story = { args: { waiting: null } };
