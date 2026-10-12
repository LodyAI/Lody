import type { Meta, StoryObj } from '@storybook/react';
import { Provider, useSetAtom } from 'jotai';
import { useState } from 'react';
import { Button } from '@lody/ui/button';
import { SessionArchiveDialog } from '@/components/session-archive-dialog';
import { sessionArchiveDialogAtom } from '@/atoms/session-archive';

const meta = {
  title: 'Sessions/Archive confirmation',
  component: SessionArchiveDialog,
  decorators: [
    (Story) => (
      <Provider>
        <Story />
      </Provider>
    ),
  ],
} satisfies Meta<typeof SessionArchiveDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

function Example() {
  const setRequest = useSetAtom(sessionArchiveDialogAtom);
  const [result, setResult] = useState('');
  return (
    <>
      <Button
        onClick={() => setRequest({ count: 3, resolve: (mode) => setResult(mode ?? 'cancelled') })}
      >
        Archive conversation group
      </Button>
      <output aria-live="polite">{result}</output>
      <SessionArchiveDialog />
    </>
  );
}

export const Group: Story = { render: () => <Example /> };
