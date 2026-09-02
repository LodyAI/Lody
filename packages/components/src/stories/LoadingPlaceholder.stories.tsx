import type { Meta, StoryObj } from '@storybook/react';

import { LoadingPlaceholder } from '@/components/loading-placeholder';

const meta = {
  title: 'Components/LoadingPlaceholder',
  component: LoadingPlaceholder,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof LoadingPlaceholder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Loading',
  },
};

export const WithDescription: Story = {
  args: {
    title: 'Loading workspace',
    description: 'Fetching your workspace list.',
  },
};

export const AuthFlow: Story = {
  args: {
    title: 'Preparing your account',
    description: 'Finishing sign-in so we can link your email.',
  },
};

/**
 * What `RouteSuspense` shows while a lazy route chunk is fetched. The surface
 * paints on the first frame — that is what replaces the white flash — while the
 * spinner and label stay invisible for 300ms and then fade in, so a chunk that
 * arrives quickly never flashes an indicator. Reload the story to watch the
 * delay; the canvas is there the whole time.
 */
export const DeferredIndicator: Story = {
  args: {
    title: 'Loading...',
    deferIndicator: true,
  },
};

/**
 * The same fallback nested in an already-mounted pane (the Archive route, say).
 * It fills its parent instead of the viewport, so the sidebar beside it stays
 * on screen. The dashed frame stands in for that pane.
 */
export const DeferredIndicatorInContentPane: Story = {
  args: {
    title: 'Loading...',
    variant: 'content',
    deferIndicator: true,
  },
  decorators: [
    (Story) => (
      <div className="h-[100dvh] w-full bg-background p-6">
        <div className="h-full w-full rounded-lg border border-dashed border-border">
          <Story />
        </div>
      </div>
    ),
  ],
};
