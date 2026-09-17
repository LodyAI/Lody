import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ConversationFontSizeSlider } from '@/components/settings/conversation-font-size-slider';

const meta = {
  title: 'Settings/ConversationFontSizeSlider',
  component: ConversationFontSizeSlider,
  render: function ControlledSlider(args) {
    const [value, setValue] = useState(args.value);
    return <ConversationFontSizeSlider value={value} onChange={setValue} />;
  },
  args: { value: 14, onChange: () => undefined },
} satisfies Meta<typeof ConversationFontSizeSlider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Minimum: Story = { args: { value: 8 } };
export const Maximum: Story = { args: { value: 32 } };
