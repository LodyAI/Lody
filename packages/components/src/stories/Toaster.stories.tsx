import type { Meta, StoryObj } from '@storybook/react';
import { toast } from '@/lib/toast';
import { Toast } from '@lody/ui';
import { toastManager } from '@/lib/toast';
import { Button } from '@lody/ui/button';
import { RoostHistoryError, SessionHistoryRequestError } from '@/lib/roost-history-error';
import { useTranslation } from 'react-i18next';

/**
 * The global toast surface. Close is always on the far right. Title stays
 * left; an action chip sits with the close on the right.
 */
const meta: Meta<typeof Toast.Provider> = {
  title: 'UI/Toaster',
  component: Toast.Provider,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => (
    <div className="flex min-h-[60vh] flex-col items-start gap-3 p-8">
      <Toast.Provider manager={toastManager} {...args} />
      <Button
        variant="secondary"
        onClick={() => toast.success('Base branch name copied to clipboard')}
      >
        Show success toast
      </Button>
      <Button variant="secondary" onClick={() => toast.info('Issue URL copied to clipboard')}>
        Show info toast
      </Button>
      <Button variant="secondary" onClick={() => toast.error('Unable to copy link')}>
        Show error toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast('Session updated', {
            description: 'Your changes were saved to the workspace.',
          })
        }
      >
        Show toast with description
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast.success('cursor connected successfully.', {
            description:
              'This machine is private by default. Share it from device settings when teammates should be able to use it.',
            action: {
              label: 'Open machine settings',
              onClick: () => {},
            },
          })
        }
      >
        Show toast with description and action
      </Button>
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof Toast.Provider>;

export const Default: Story = {};

export const RoostWriteFailure: Story = {
  render: function RoostWriteFailureStory(args) {
    const { t } = useTranslation();
    return (
      <>
        <Toast.Provider manager={toastManager} {...args} />
        <Button
          onClick={() =>
            toast.error(t('sessions.sendError'), {
              description: new RoostHistoryError(
                'write',
                'Roost history initialize failed (code=workerFailed; diagnostic=65b4a1d8-6f6a-4ea0-87e8-2dbd563d25f6)'
              ).message,
              duration: 0,
            })
          }
        >
          {t('sessions.sendError')}
        </Button>
      </>
    );
  },
};

const historyRequestFailureStory = (metadataPending: boolean): Story => ({
  render: function HistoryRequestFailureStory(args) {
    const { t } = useTranslation();
    return (
      <>
        <Toast.Provider manager={toastManager} {...args} />
        <Button
          onClick={() =>
            toast.error(t('sessions.sendError'), {
              description: new SessionHistoryRequestError(
                'write',
                {
                  source: metadataPending ? 'remote' : 'transport',
                  code: metadataPending ? 'session_metadata_pending' : 'request_failed',
                  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  machineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                },
                metadataPending
                  ? 'Session history metadata did not reach the target machine in time.'
                  : 'History RPC request append exceeded 10000ms.'
              ).message,
              duration: 0,
            })
          }
        >
          {t('sessions.sendError')}
        </Button>
      </>
    );
  },
});

export const HistoryRequestTransportFailure = historyRequestFailureStory(false);
export const HistoryMetadataPending = historyRequestFailureStory(true);
