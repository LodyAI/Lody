import type { Meta, StoryObj } from '@storybook/react';
import { toast } from 'sonner';
import { Toaster } from '@/ui/sonner';
import { Button } from '@lody/ui/button';

/**
 * The global toast surface. Toasts render neutral (no accent color) with a
 * subtle border and an inline close button tucked inside on the right, aligned
 * with the title line. An action button takes a full-width row of its own below
 * the text so a wrapping description keeps the toast's full width.
 */
const meta: Meta<typeof Toaster> = {
  title: 'UI/Toaster',
  component: Toaster,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => (
    <div className="flex min-h-[60vh] flex-col items-start gap-3 p-8">
      <Toaster {...args} />
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
type Story = StoryObj<typeof Toaster>;

export const Default: Story = {};
