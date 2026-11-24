import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@lody/ui/button';
import { PinSectionTargetPill } from '@/components/chat/pin-section-target-pill';

function PinSectionTargetDemo({ name }: { name: string }) {
  const [pinned, setPinned] = useState(true);
  return (
    <div {...stylex.props(themeStyles.row)}>
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

const themeStyles = stylex.create({
  row: { display: 'flex', width: '420px', alignItems: 'center', gap: 'calc(var(--spacing) * 2)', padding: 'calc(var(--spacing) * 6)' },
});
