import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import {
  MermaidDiagramViewer,
  type MermaidDiagramSelection,
} from '@/components/ai-gui/mermaid-diagram-viewer';

const styles = stylex.create({
  root: { overflow: 'hidden', padding: 16 },
  source: { display: 'block', width: 1600, height: 900 },
});

function Fixture({ scoped = false }: { scoped?: boolean }) {
  const source = useRef<SVGSVGElement>(null);
  const [selection, setSelection] = useState<MermaidDiagramSelection | null>(null);
  const open = useCallback(() => {
    if (!source.current) return;
    const bounds = source.current.getBoundingClientRect();
    setSelection({
      svg: source.current.cloneNode(true) as SVGSVGElement,
      naturalWidth: bounds.width,
      naturalHeight: bounds.height,
    });
  }, []);
  useLayoutEffect(open, [open]);
  useLayoutEffect(() => {
    const viewer = document.querySelector<HTMLElement>('[data-testid="mermaid-diagram-viewer"]');
    if (viewer && scoped) viewer.style.setProperty('--spacing', '5px');
  }, [scoped, selection]);

  return (
    <div {...stylex.props(styles.root)} data-mermaid-controls-fixture>
      <Button onClick={open}>Open viewer</Button>
      <output data-mermaid-controls-open={String(selection !== null)}>
        {selection ? 'Viewer open' : 'Viewer closed'}
      </output>
      <svg
        ref={source}
        viewBox="0 0 1600 900"
        role="img"
        aria-label="Synthetic diagram input"
        {...stylex.props(styles.source)}
      >
        <rect x="20" y="100" width="180" height="80" rx="12" fill="none" stroke="currentColor" />
        <path d="M200 140H420M410 130l10 10-10 10" fill="none" stroke="currentColor" />
        <rect x="420" y="100" width="180" height="80" rx="12" fill="none" stroke="currentColor" />
        <text x="110" y="145" textAnchor="middle" fill="currentColor">
          Input
        </text>
        <text x="510" y="145" textAnchor="middle" fill="currentColor">
          Output
        </text>
      </svg>
      <MermaidDiagramViewer selection={selection} onClose={() => setSelection(null)} />
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedMermaidControls',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <Fixture /> };
export const ScopedSpacing: Story = { render: () => <Fixture scoped /> };
