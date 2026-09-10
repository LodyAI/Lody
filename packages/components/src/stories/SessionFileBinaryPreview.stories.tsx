import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { useTranslation } from 'react-i18next';
import { resolveRevealFileLabel } from '@/lib/session-file-actions';
import { SessionFileBinaryPreview } from '@/components/sessions/session-file-binary-preview';

const meta = {
  title: 'Sessions/SessionFileBinaryPreview',
  component: SessionFileBinaryPreview,
  render: function BinaryPreviewStory(args) {
    const { t } = useTranslation();
    const fileActions = args.fileActions;
    return (
      <SessionFileBinaryPreview
        {...args}
        fileActions={
          fileActions?.localHost
            ? {
                ...fileActions,
                localHost: {
                  ...fileActions.localHost,
                  revealLabel: resolveRevealFileLabel('darwin', t),
                },
              }
            : fileActions
        }
      />
    );
  },
  decorators: [
    (Story) => (
      <div className="h-80 w-96 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionFileBinaryPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LocalArchive: Story = {
  args: {
    path: '/tmp/build/Lody.zip',
    fileActions: {
      onCopyPath: fn(),
      localHost: {
        openTarget: 'default-app',
        revealLabel: 'Reveal in Finder',
        onOpen: fn(),
        onReveal: fn(),
      },
    },
  },
};

export const RemoteArchive: Story = {
  args: { path: 'build/Lody.zip', fileActions: { onCopyPath: fn() } },
};
