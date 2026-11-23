import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import { fn } from 'storybook/test';
import type { SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Toast } from '@lody/ui';
import { RenameSessionDialogView } from '@/components/sessions/rename-session-dialog';
import { toastManager } from '@/lib/toast';

const meta = {
  title: 'Components/RenameSessionDialog',
  component: RenameSessionDialogView,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    target: {
      sessionId: 'rename-session' as SessionId,
      initialTitle: 'Improve rename chat',
    },
    onClose: fn(),
    onRename: fn(),
  },
} satisfies Meta<typeof RenameSessionDialogView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WrappingTitle: Story = {
  args: {
    target: {
      sessionId: 'rename-session' as SessionId,
      initialTitle:
        'Polish the Rename Chat experience so longer conversation names remain easy to review',
    },
  },
};

export const EmptyTitle: Story = {
  args: { target: { sessionId: 'rename-session' as SessionId, initialTitle: '' } },
};

export const OverflowTitle: Story = {
  args: {
    target: {
      sessionId: 'rename-session' as SessionId,
      initialTitle:
        'Review the local workspace and preserve the original project layout 中文标题 · '.repeat(8),
    },
  },
};

function InteractiveFixture({ mode = 'success' }: { mode?: 'success' | 'pending' | 'retry' }) {
  const initialTarget = {
    sessionId: 'rename-session' as SessionId,
    initialTitle: 'Synthetic local conversation 中文',
  };
  const [target, setTarget] = useState<typeof initialTarget | null>(initialTarget);
  const [result, setResult] = useState('Ready');
  const attempts = useRef(0);
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);

  useEffect(() => {
    // The fixture's synthetic save completes through a signal, never a timer.
    const settle = (event: Event) => {
      const completion = pending.current;
      if (!completion) return;
      pending.current = null;
      if ((event as CustomEvent<string>).detail === 'reject') {
        setResult('Attempt failed');
        completion.reject(new Error('Synthetic rename failed'));
      } else {
        completion.resolve();
      }
    };
    window.addEventListener('rename-fixture-settle', settle);
    return () => window.removeEventListener('rename-fixture-settle', settle);
  }, []);

  return (
    <>
      <Toast.Provider manager={toastManager} />
      <Button
        onClick={() => {
          setResult('Ready');
          setTarget(initialTarget);
        }}
      >
        Open rename dialog
      </Button>
      <output data-rename-result="">{result}</output>
      <RenameSessionDialogView
        target={target}
        onClose={() => {
          setTarget(null);
          setResult((current) => (current === 'Ready' ? 'Closed' : current));
        }}
        onRename={async (_sessionId, nextTitle) => {
          attempts.current += 1;
          if (mode === 'retry' && attempts.current === 1) {
            setResult('Attempt failed');
            throw new Error('Synthetic rename failed');
          }
          if (mode === 'pending') {
            setResult('Saving');
            await new Promise<void>((resolve, reject) => {
              pending.current = { resolve, reject };
            });
          }
          setResult(`Saved: ${nextTitle}`);
        }}
      />
    </>
  );
}

export const Interactive: Story = { render: () => <InteractiveFixture /> };
export const PendingSave: Story = { render: () => <InteractiveFixture mode="pending" /> };
export const FailureRetry: Story = { render: () => <InteractiveFixture mode="retry" /> };
