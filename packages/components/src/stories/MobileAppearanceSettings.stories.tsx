import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider as JotaiProvider, createStore } from 'jotai';

import { conversationFontSizeAtom } from '@/atoms';
import { MobileAppearanceSettings } from '@/components/mobile/mobile-appearance-settings';
const storyLayout = stylex.create({
  section: {
    'padding-bottom': 'calc(var(--spacing) * 6)',
  },
});

function StoryShell({ conversationFontSize }: { conversationFontSize: number }) {
  // A per-story store keeps the size out of the shared default store, so switching
  // stories does not carry the previous one's persisted value.
  const store = useMemo(() => {
    const created = createStore();
    created.set(conversationFontSizeAtom, conversationFontSize);
    return created;
  }, [conversationFontSize]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-y-auto bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <JotaiProvider store={store}>
          <div {...stylex.props(storyLayout.section)}>
            <MobileAppearanceSettings />
          </div>
        </JotaiProvider>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileAppearanceSettings',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  args: { conversationFontSize: 14 },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The largest offered size, so the sample shows what the scale's top end looks like. */
export const LargestSize: Story = {
  args: { conversationFontSize: 32 },
};

/** The smallest offered size. */
export const SmallestSize: Story = {
  args: { conversationFontSize: 8 },
};
