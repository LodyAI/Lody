import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider as JotaiProvider, createStore } from 'jotai';

import { conversationFontSizeAtom } from '@/atoms';
import { MobileAppearanceSettings } from '@/components/mobile/mobile-appearance-settings';
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflowY: 'auto',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

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
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
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
