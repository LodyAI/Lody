import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@lody/ui/button';
import { PinSectionTargetPill } from '@/components/chat/pin-section-target-pill';

/**
 * The new-chat page opened from a pin section's "New Chat" button names the
 * section the conversation will be pinned into, beside the project pills.
 * Unchecking it starts an unpinned conversation.
 */
function PinSectionTargetDemo({ name }: { name: string }) {
  const [pinned, setPinned] = useState(true);
  return (
    <div className="flex w-[420px] items-center gap-2 p-6">
      {pinned ? (
        <PinSectionTargetPill
          sectionId="maintenance"
          name={name}
          onClear={() => setPinned(false)}
        />
      ) : (
        <Button type="button" variant="ghost" size="mini" onClick={() => setPinned(true)}>
          Cleared — restore
        </Button>
      )}
    </div>
  );
}

const meta = {
  title: 'Chat/Pin Section Target',
  component: PinSectionTargetDemo,
  args: { name: 'Maintenance' },
} satisfies Meta<typeof PinSectionTargetDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongName: Story = {
  args: { name: 'Weekly dependency and mirror maintenance' },
};
