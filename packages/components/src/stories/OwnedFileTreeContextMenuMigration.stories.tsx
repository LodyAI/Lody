import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { FileTreeProviderView } from '../components/sessions/components/file-tree-view';
import { createFakeSessionFileProvider } from '../lib/session-file-provider';
import type { SessionFileMenuItem } from '../hooks/use-session-file-actions';

function Fixture({ spacing = false }: { spacing?: boolean }) {
  const [result, setResult] = useState('Ready');
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: [
          { path: 'README.md', kind: 'text', sourceState: 'live-collaborative' },
          { path: 'src/example.tsx', kind: 'text', sourceState: 'live-collaborative' },
        ],
      }),
    []
  );
  const items = useMemo<readonly SessionFileMenuItem[]>(
    () => [
      {
        id: 'copy-relative-path',
        label: 'Record relative path',
        icon: Copy,
        run: (path) => setResult(`Recorded ${path}`),
      },
      {
        id: 'open-in-editor',
        label: 'Open synthetic editor',
        icon: ExternalLink,
        run: (path) => setResult(`Editor ${path}`),
      },
    ],
    []
  );
  useLayoutEffect(() => {
    if (!spacing) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (previous) root.style.setProperty('--spacing', previous);
      else root.style.removeProperty('--spacing');
    };
  }, [spacing]);
  return (
    <main
      data-owned-file-context=""
      style={{
        minHeight: '100dvh',
        padding: 16,
        color: 'hsl(var(--foreground))',
        background: 'hsl(var(--background))',
      }}
    >
      <div
        style={{
          height: 360,
          width: 320,
          maxWidth: '100%',
          border: '1px solid hsl(var(--border))',
        }}
      >
        <FileTreeProviderView
          fileProvider={provider}
          fileProviderPending={false}
          fileMenuItems={items}
          handleOpenFile={(path) => setResult(`Opened ${path}`)}
        />
      </div>
      <output data-owned-file-context-result="" style={{ display: 'block', marginTop: 16 }}>
        {result}
      </output>
    </main>
  );
}
const meta = {
  title: 'Migration/OwnedFileTreeContextMenu',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: () => <Fixture /> };
export const RootSpacing: Story = { render: () => <Fixture spacing /> };
