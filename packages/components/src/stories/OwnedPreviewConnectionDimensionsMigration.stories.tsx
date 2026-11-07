import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState } from 'react';
import { Button } from '@lody/ui/button';
import {
  PreviewConnectionPlaceholder,
  PreviewConnectionStatus,
} from '@/components/sessions/preview-connection-status';

const meta = {
  title: 'Migration/OwnedPreviewConnectionDimensions',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({ scoped = false }: { scoped?: boolean }) {
  const [busy, setBusy] = useState(true);
  const [restores, setRestores] = useState(0);
  useLayoutEffect(() => {
    if (!scoped) return undefined;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (previous) root.style.setProperty('--spacing', previous);
      else root.style.removeProperty('--spacing');
    };
  }, [scoped]);
  const props = {
    local: false,
    busy,
    connection: { status: 'closed' as const, closedReason: 'idle_timeout' as const },
    remoteMachineName: 'Synthetic build machine',
    onRestore: () => {
      setRestores((count) => count + 1);
      setBusy(true);
    },
  };
  return (
    <div data-preview-dimensions data-stage={busy ? 'connecting' : 'expired'}>
      <Button variant="secondary" onClick={() => setBusy(false)}>
        Show expired preview
      </Button>
      <output data-restores>{restores}</output>
      <PreviewConnectionStatus {...props} />
      <PreviewConnectionPlaceholder {...props} />
    </div>
  );
}

export const Default: Story = { render: () => <Fixture /> };
export const RootSpacing: Story = { render: () => <Fixture scoped /> };
