import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ReviewAgentSetupDialog } from '@/components/sessions/auto-review-info';
import { Button } from '@lody/ui/button';

function Harness() {
  const [open, setOpen] = useState(true);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Show setup prompt</Button>
      <ReviewAgentSetupDialog
        open={open}
        onOpenChange={setOpen}
        machineName="Zhen’s MacBook Pro"
        onOpenSettings={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: 'Sessions/ReviewAgentSetupDialog',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
