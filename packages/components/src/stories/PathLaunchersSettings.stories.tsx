import * as stylex from '@stylexjs/stylex';
import { useRef, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PathLaunchersSettings } from '@/components/settings/path-launchers-setting';
import { writeStoredPathLauncherPreference } from '@/lib/session-path-launchers';
const storyLayout = stylex.create({
  frame: {
    width: '760px',
    'max-width': 'calc(100vw - 2rem)',
  },
});

const meta = {
  title: 'Settings/PathLaunchersSettings',
  component: PathLaunchersSettings,
  parameters: {
    layout: 'centered',
  },
  args: {
    isElectron: true,
    platform: 'darwin',
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PathLaunchersSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCustomLauncher: Story = {
  render: (args) => <SeededPathLaunchersSettings {...args} />,
};

function SeededPathLaunchersSettings(args: ComponentProps<typeof PathLaunchersSettings>) {
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    writeStoredPathLauncherPreference({
      selectedLauncherId: 'custom:phpstorm',
      customLaunchers: [
        {
          id: 'phpstorm',
          label: 'PhpStorm',
          commandTemplate: 'open -a "PhpStorm" {path}',
        },
      ],
    });
  }
  return <PathLaunchersSettings {...args} />;
}
