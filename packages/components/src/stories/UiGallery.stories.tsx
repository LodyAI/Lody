import type { Meta, StoryObj } from '@storybook/react';

import { UiGallery } from '@lody/ui/gallery';

const meta = {
  title: 'Design System/UI Gallery',
  component: UiGallery,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof UiGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The token board: every `@lody/ui` token and Button state, rendered twice so
 * Lody Light and Vesper sit side by side regardless of the Storybook theme.
 */
export const TokenBoard: Story = {
  args: { palettes: 'both' },
};

/** One palette at full width, for reading a surface the way the app renders it. */
export const LodyLight: Story = {
  args: { palettes: 'light' },
};

export const Vesper: Story = {
  args: { palettes: 'dark' },
};

/**
 * No forced theme: the board follows the Storybook theme toolbar, which is how
 * a product surface sees the tokens.
 */
export const Ambient: Story = {
  args: { palettes: 'ambient' },
};
